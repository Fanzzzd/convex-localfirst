import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Append-only change log + per-row version authority. Public so the mounting app's
// sync handler can write/read it via components.convexLocalFirst.changes.*. Deletes
// propagate as a kind:"delete" change in this same log — there is no separate
// tombstone table. The log is a DELIVERY FEED, not the archive: old changes are
// GC'd opportunistically on append (see below); versions live in rowVersions and
// cold clients bootstrap from the app rows themselves (rowVersions drives paging).

const CHANGE_ID_WIDTH = 12;
// How many expired changes one append may prune. Amortized GC: deletion keeps pace
// with the append rate, so no cron is needed. A quiet scope keeps its old changes —
// which is fine, because a quiet scope's log is small.
const GC_BATCH = 4;

/**
 * Append a change and return its assigned monotonic changeId. The id is the
 * per-scope sequence, zero-padded so it sorts lexicographically (cursors compare
 * with `gt`). ponytail: changeId is derived from the current max in this scope
 * (read-max+1) rather than a separate counter table — one fewer table, and the
 * whole append runs in one transaction so OCC retries any racing append. If a
 * single scope ever sustains very high write contention, switch to a counter row.
 *
 * Also (same transaction): upserts the row's rowVersions entry, and prunes up to
 * GC_BATCH changes in this scope older than `retentionMs` (never the one just
 * appended). A pruned change is safe to lose: a client whose cursor predates the
 * prune horizon is detected by the pull path (gap check) and re-bootstrapped from
 * current rows.
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
    opId: v.optional(v.string()),
    serverId: v.optional(v.string()),
    retentionMs: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    const { retentionMs, serverId, ...change } = args;
    const last = await ctx.db
      .query("changes")
      .withIndex("by_scope_change", (q) => q.eq("scopeKey", args.scopeKey))
      .order("desc")
      .first();
    const next = (last ? Number(last.changeId) : 0) + 1;
    const changeId = String(next).padStart(CHANGE_ID_WIDTH, "0");
    await ctx.db.insert("changes", { ...change, changeId });

    // Row-version authority: upsert (table, localId) -> version/scope.
    const rv = await ctx.db
      .query("rowVersions")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .first();
    if (rv) {
      await ctx.db.patch(rv._id, { version: args.version, scopeKey: args.scopeKey, serverId });
    } else {
      await ctx.db.insert("rowVersions", {
        table: args.table,
        localId: args.localId,
        rowKey: `${args.table}:${args.localId}`,
        scopeKey: args.scopeKey,
        version: args.version,
        serverId
      });
    }

    // Opportunistic GC of this scope's expired changes (oldest-first; never the
    // change just appended, so a non-empty log always keeps its newest entry).
    if (retentionMs !== undefined) {
      const horizon = args.serverTime - retentionMs;
      const oldest = await ctx.db
        .query("changes")
        .withIndex("by_scope_change", (q) => q.eq("scopeKey", args.scopeKey))
        .take(GC_BATCH + 1);
      for (const row of oldest) {
        if (row.changeId === changeId || row.serverTime >= horizon) {
          break; // ordered by changeId asc — the rest are newer still
        }
        await ctx.db.delete(row._id);
      }
    }

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

/** Highest version recorded for a row (0 if none) — from rowVersions, which
 *  survives change-log GC, so versions never regress. Falls back to the change
 *  log for rows written before rowVersions existed (no backfill needed — the
 *  first post-upgrade write creates the entry at the correct version). */
export const latestVersion = query({
  args: { table: v.string(), localId: v.string() },
  handler: async (ctx, args) => {
    const rv = await ctx.db
      .query("rowVersions")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .first();
    if (rv) {
      return rv.version;
    }
    const last = await ctx.db
      .query("changes")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .order("desc")
      .first();
    return last?.version ?? 0;
  }
});

/** The scope a row lives (or last lived) in — from rowVersions (GC-proof), with
 *  the same pre-rowVersions change-log fallback as latestVersion. Used to
 *  authorize an idempotent no-op delete of an already-gone row. Null if the row
 *  was never seen by the server. */
export const scopeForLocal = query({
  args: { table: v.string(), localId: v.string() },
  handler: async (ctx, args) => {
    const rv = await ctx.db
      .query("rowVersions")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .first();
    if (rv) {
      return rv.scopeKey;
    }
    const last = await ctx.db
      .query("changes")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .order("desc")
      .first();
    return last?.scopeKey ?? null;
  }
});

/** Oldest retained changeId for a scope (null when empty) — the pull path's GC-gap check. */
export const firstId = query({
  args: { scopeKey: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("changes")
      .withIndex("by_scope_change", (q) => q.eq("scopeKey", args.scopeKey))
      .first();
    return row?.changeId ?? null;
  }
});

/** Newest changeId for a scope (null when empty) — a bootstrap's end cursor. */
export const lastId = query({
  args: { scopeKey: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("changes")
      .withIndex("by_scope_change", (q) => q.eq("scopeKey", args.scopeKey))
      .order("desc")
      .first();
    return row?.changeId ?? null;
  }
});

/** One bootstrap page of per-row versions for a scope, ordered by rowKey. */
export const listVersions = query({
  args: { scopeKey: v.string(), afterRowKey: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, args) => {
    const after = args.afterRowKey ?? "";
    const rows = await ctx.db
      .query("rowVersions")
      .withIndex("by_scope_row", (q) => q.eq("scopeKey", args.scopeKey).gt("rowKey", after))
      .take(args.limit);
    return rows.map((r) => ({ table: r.table, localId: r.localId, version: r.version, rowKey: r.rowKey, serverId: r.serverId ?? null }));
  }
});
