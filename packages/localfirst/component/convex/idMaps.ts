import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// localId -> serverId mapping, per (userId, table). Public component API.

export const put = mutation({
  args: {
    userId: v.string(),
    table: v.string(),
    localId: v.string(),
    serverId: v.string()
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("idMaps")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .first(); // first-by-index = oldest; deterministic under legacy duplicate rows (never wedge)
    if (existing) {
      // Idempotent on a matching claim; reject a conflicting one. localId is a
      // globally-unique client id, so a different serverId for the same
      // (table, localId) means a collision/race — never silently remap.
      if (existing.serverId !== args.serverId) {
        throw new Error(`idMaps: (${args.table}, ${args.localId}) already maps to a different serverId`);
      }
      return existing._id;
    }
    return await ctx.db.insert("idMaps", { ...args, createdAt: Date.now() });
  }
});

export const get = query({
  // Resolve by (table, localId) only — NOT userId — so any authorized member can
  // resolve a workspace/project row created by another member. localId is a
  // globally-unique client id; membership is enforced separately on write.
  args: {
    table: v.string(),
    localId: v.string()
  },
  handler: async (ctx, args) => {
    // Deterministic under legacy duplicates: put() has been fail-closed since
    // 0.2 (one mapping per (table, localId)), but data written by an older
    // component version can hold duplicates — .unique() would then wedge every
    // push/pull touching that localId forever. First-by-index = the OLDEST
    // mapping, i.e. the row the first writer created, which is also what the
    // fail-closed put() would have preserved.
    const row = await ctx.db
      .query("idMaps")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .first();
    return row?.serverId ?? null;
  }
});
