import { convexToJson, jsonToConvex, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";

// Append-only change log + per-row version authority. Public so the mounting app's
// sync handler can write/read it via components.convexLocalFirst.changes.*. Deletes
// propagate as a kind:"delete" change in this same log — there is no separate
// tombstone table. The log is a DELIVERY FEED, not the archive: old changes are
// GC'd by the cursor-backed mutation plus a small append-time prune; versions
// live in rowVersions and cold clients bootstrap from current app rows.

const CHANGE_ID_WIDTH = 12;
// How many expired changes one append may prune before the scheduled global GC.
const GC_BATCH = 4;
const GLOBAL_GC_BATCH = 32;

/**
 * Append a change and return its assigned monotonic changeId. The id is the
 * per-scope sequence, zero-padded so it sorts lexicographically (cursors compare
 * with `gt`). changeId is derived from the current max in this scope
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
const changeArgs = {
  scopeKey: v.string(),
  table: v.string(),
  localId: v.string(),
  kind: v.union(v.literal("insert"), v.literal("patch"), v.literal("delete")),
  dataJson: v.optional(v.string()),
  patchJson: v.optional(v.string()),
  version: v.number(),
  serverTime: v.number(),
  opId: v.optional(v.string()),
  serverId: v.optional(v.string())
};

type ChangeArgs = {
  scopeKey: string;
  table: string;
  localId: string;
  kind: "insert" | "patch" | "delete";
  dataJson?: string;
  patchJson?: string;
  version: number;
  serverTime: number;
  opId?: string;
  serverId?: string;
  retentionMs?: number;
};

async function appendChange(ctx: MutationCtx, args: ChangeArgs): Promise<string> {
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

export const append = mutation({
  args: { ...changeArgs, retentionMs: v.optional(v.number()) },
  handler: appendChange
});

/** One component call for the op ledger + optional change append. The mounting
 * app's row write shares the parent Convex mutation, so any error aborts all of it. */
export const commitOp = mutation({
  args: {
    userId: v.string(),
    opId: v.string(),
    schemaVersion: v.number(),
    status: v.union(v.literal("accepted"), v.literal("rejected")),
    error: v.optional(v.string()),
    committedAt: v.number(),
    change: v.optional(v.object(changeArgs)),
    retentionMs: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("ops")
      .withIndex("by_user_op", (q) => q.eq("userId", args.userId).eq("opId", args.opId))
      .first();
    if (existing) throw new Error(`ops: duplicate commit for ${args.opId}`);

    let committedChange:
      | (Omit<NonNullable<typeof args.change>, "serverId"> & { changeId: string })
      | undefined;
    let changesJson: string | undefined;
    if (args.change) {
      const changeId = await appendChange(ctx, { ...args.change, retentionMs: args.retentionMs });
      const { serverId: _serverId, ...change } = args.change;
      committedChange = { ...change, changeId };
      const payload = {
        changeId,
        scopeKey: change.scopeKey,
        table: change.table,
        localId: change.localId,
        kind: change.kind,
        ...(change.dataJson ? { data: jsonToConvex(JSON.parse(change.dataJson)) } : {}),
        ...(change.patchJson ? { patch: jsonToConvex(JSON.parse(change.patchJson)) } : {}),
        version: change.version,
        serverTime: change.serverTime,
        ...(change.opId ? { opId: change.opId } : {})
      };
      changesJson = JSON.stringify(convexToJson([payload] as any));
    }

    await ctx.db.insert("ops", {
      userId: args.userId,
      opId: args.opId,
      schemaVersion: args.schemaVersion,
      status: args.status,
      changesJson,
      error: args.error,
      committedAt: args.committedAt
    });
    return { change: committedChange ?? null };
  }
});

// Global, cursor-backed GC reaches idle scopes too. Each stream pins its horizon
// while paginating, then resets so the next completed pass can advance it.
export const gc = mutation({
  args: { now: v.number(), retentionMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (args.retentionMs === undefined) return { ops: 0, changes: 0, done: true };
    const requestedHorizon = args.now - args.retentionMs;
    const state = await ctx.db
      .query("gcState")
      .withIndex("by_name", (q) => q.eq("name", "global"))
      .first();

    const opsHorizon = state?.opsHorizon ?? requestedHorizon;
    const opsPage = await ctx.db
      .query("ops")
      .withIndex("by_committed", (q) => q.lt("committedAt", opsHorizon))
      .paginate({ cursor: state?.opsCursor ?? null, numItems: GLOBAL_GC_BATCH });
    for (const row of opsPage.page) await ctx.db.delete(row._id);

    const changesHorizon = state?.changesHorizon ?? requestedHorizon;
    const changesPage = await ctx.db
      .query("changes")
      .withIndex("by_server_time", (q) => q.lt("serverTime", changesHorizon))
      .paginate({ cursor: state?.changesCursor ?? null, numItems: GLOBAL_GC_BATCH });
    for (const row of changesPage.page) await ctx.db.delete(row._id);

    const next = {
      name: "global",
      opsCursor: opsPage.isDone ? undefined : opsPage.continueCursor,
      opsHorizon: opsPage.isDone ? undefined : opsHorizon,
      changesCursor: changesPage.isDone ? undefined : changesPage.continueCursor,
      changesHorizon: changesPage.isDone ? undefined : changesHorizon
    };
    if (state) await ctx.db.patch(state._id, next);
    else await ctx.db.insert("gcState", next);
    return {
      ops: opsPage.page.length,
      changes: changesPage.page.length,
      done: opsPage.isDone && changesPage.isDone
    };
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
