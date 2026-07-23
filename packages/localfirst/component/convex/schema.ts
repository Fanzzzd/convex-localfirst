import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ops: defineTable({
    userId: v.string(),
    opId: v.string(),
    schemaVersion: v.number(),
    status: v.union(v.literal("accepted"), v.literal("rejected")),
    // The confirming change(s) this op produced, re-delivered on a duplicate replay so
    // an op committed but never acked (crash/drop) can leave _pending on recovery.
    changesJson: v.optional(v.string()),
    error: v.optional(v.string()),
    committedAt: v.number()
  })
    .index("by_user_op", ["userId", "opId"])
    .index("by_committed", ["committedAt"]),

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
    .index("by_table_local", ["table", "localId"])
    .index("by_server_time", ["serverTime"]),

  // Per-row version authority + snapshot-bootstrap driver. One row per (table,
  // localId) EVER seen, upserted on every change append; survives change-log GC
  // (and row deletion) so versions stay monotonic forever. rowKey = `table:localId`
  // gives bootstrap a single-column pagination cursor.
  rowVersions: defineTable({
    table: v.string(),
    localId: v.string(),
    rowKey: v.string(),
    scopeKey: v.string(),
    version: v.number(),
    // Denormalized app-row id so snapshot bootstrap loads rows with one ctx.db.get
    // instead of a per-row id-map lookup.
    serverId: v.optional(v.string())
  })
    .index("by_table_local", ["table", "localId"])
    .index("by_scope_row", ["scopeKey", "rowKey"]),

  idMaps: defineTable({
    userId: v.string(), // creator, kept for audit only — NOT part of the lookup key
    table: v.string(),
    localId: v.string(),
    serverId: v.string(),
    createdAt: v.number()
  }).index("by_table_local", ["table", "localId"]),

  // Ephemeral presence: who is in a scope right now (avatars, cursors, typing).
  // Rows are heartbeat-refreshed and expire by read-time TTL + opportunistic
  // pruning on heartbeat -- never part of the sync log, never persisted locally.
  presence: defineTable({
    scopeKey: v.string(),
    clientId: v.string(),
    userId: v.string(),
    dataJson: v.string(),
    updatedAt: v.number()
  })
    .index("by_scope_client", ["scopeKey", "clientId"])
    .index("by_scope_updated", ["scopeKey", "updatedAt"]),

  gcState: defineTable({
    name: v.string(),
    opsCursor: v.optional(v.string()),
    opsHorizon: v.optional(v.number()),
    changesCursor: v.optional(v.string()),
    changesHorizon: v.optional(v.number())
  }).index("by_name", ["name"])
});
