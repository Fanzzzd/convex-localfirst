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
      .unique();
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
    const row = await ctx.db
      .query("idMaps")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .unique();
    return row?.serverId ?? null;
  }
});
