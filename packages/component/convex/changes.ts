import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Append-only change log. Public so the mounting app's sync handler can write/read
// it via components.convexLocalFirst.changes.*. Deletes propagate as a kind:"delete"
// change in this same log — there is no separate tombstone table.

const CHANGE_ID_WIDTH = 12;

/**
 * Append a change and return its assigned monotonic changeId. The id is the
 * per-scope sequence, zero-padded so it sorts lexicographically (cursors compare
 * with `gt`). ponytail: changeId is derived from the current max in this scope
 * (read-max+1) rather than a separate counter table — one fewer table, and the
 * whole append runs in one transaction so OCC retries any racing append. If a
 * single scope ever sustains very high write contention, switch to a counter row.
 */
export const append = mutation({
  args: {
    scopeKey: v.string(),
    table: v.string(),
    localId: v.string(),
    kind: v.union(v.literal("insert"), v.literal("patch"), v.literal("delete")),
    dataJson: v.optional(v.string()),
    patchJson: v.optional(v.string()),
    version: v.number(),
    serverTime: v.number(),
    opId: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    const last = await ctx.db
      .query("changes")
      .withIndex("by_scope_change", (q) => q.eq("scopeKey", args.scopeKey))
      .order("desc")
      .first();
    const next = (last ? Number(last.changeId) : 0) + 1;
    const changeId = String(next).padStart(CHANGE_ID_WIDTH, "0");
    await ctx.db.insert("changes", { ...args, changeId });
    return changeId;
  }
});

export const listAfter = query({
  args: {
    scopeKey: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number()
  },
  handler: async (ctx, args) => {
    const cursor = args.cursor ?? "";
    const rows = await ctx.db
      .query("changes")
      .withIndex("by_scope_change", (q) => q.eq("scopeKey", args.scopeKey).gt("changeId", cursor))
      .take(args.limit);
    return rows.map((r) => ({
      changeId: r.changeId,
      scopeKey: r.scopeKey,
      table: r.table,
      localId: r.localId,
      kind: r.kind,
      dataJson: r.dataJson,
      patchJson: r.patchJson,
      version: r.version,
      serverTime: r.serverTime,
      opId: r.opId
    }));
  }
});

/** Highest version recorded for a row (0 if none) — the server's row-version source of truth. */
export const latestVersion = query({
  args: { table: v.string(), localId: v.string() },
  handler: async (ctx, args) => {
    const last = await ctx.db
      .query("changes")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .order("desc")
      .first();
    return last?.version ?? 0;
  }
});

/** The scope a row lives (or last lived) in, from its newest change. Used to
 *  authorize an idempotent no-op delete of an already-gone row: the row itself is
 *  gone so its scope can't come from the app table, but the append-only change log
 *  still records it. Null if the row was never seen by the server. */
export const scopeForLocal = query({
  args: { table: v.string(), localId: v.string() },
  handler: async (ctx, args) => {
    const last = await ctx.db
      .query("changes")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .order("desc")
      .first();
    return last?.scopeKey ?? null;
  }
});
