import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ops: defineTable({
    userId: v.string(),
    clientId: v.string(),
    opId: v.string(),
    schemaVersion: v.number(),
    functionName: v.string(),
    table: v.string(),
    localId: v.string(),
    status: v.union(v.literal("accepted"), v.literal("rejected")),
    argsJson: v.string(),
    operationJson: v.string(),
    resultJson: v.optional(v.string()),
    // The confirming change(s) this op produced, re-delivered on a duplicate replay so
    // an op committed but never acked (crash/drop) can leave _pending on recovery.
    changesJson: v.optional(v.string()),
    error: v.optional(v.string()),
    committedAt: v.number()
  })
    // Idempotency key is (userId, opId): opId is globally unique (it embeds the
    // originating clientId + a random suffix), so a durable op replayed after a
    // reload/new tab — under a DIFFERENT envelope clientId — still dedups. Keying by
    // clientId here would miss that replay and re-apply the op. clientId stays as a
    // column for audit only.
    .index("by_user_op", ["userId", "opId"])
    .index("by_user_committed", ["userId", "committedAt"]),

  changes: defineTable({
    scopeKey: v.string(),
    changeId: v.string(),
    table: v.string(),
    localId: v.string(),
    kind: v.union(v.literal("insert"), v.literal("patch"), v.literal("delete")),
    dataJson: v.optional(v.string()),
    patchJson: v.optional(v.string()),
    version: v.number(),
    serverTime: v.number(),
    opId: v.optional(v.string())
  })
    .index("by_scope_change", ["scopeKey", "changeId"])
    .index("by_table_local", ["table", "localId"]),

  idMaps: defineTable({
    userId: v.string(), // creator, kept for audit only — NOT part of the lookup key
    table: v.string(),
    localId: v.string(),
    serverId: v.string(),
    createdAt: v.number()
  }).index("by_table_local", ["table", "localId"]),

  // Per-field write clocks for `timestampLww` tables: clocksJson is a JSON map
  // field -> { ts, tiebreaker } so a NEWER field-write wins regardless of arrival order.
  // Keyed by (table, localId) like idMaps. The push mutation read-modify-writes a row's
  // clocks inside its own transaction, so Convex OCC serializes concurrent writers to the
  // same row — no clock update is lost (same guarantee as the per-row version RMW).
  fieldClocks: defineTable({
    table: v.string(),
    localId: v.string(),
    clocksJson: v.string(),
    updatedAt: v.number()
  }).index("by_table_local", ["table", "localId"])
});
