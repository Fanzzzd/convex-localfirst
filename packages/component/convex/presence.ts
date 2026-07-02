import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// A member is "present" while its heartbeat is fresher than this. Heartbeats
// arrive every few seconds (the React hook defaults to 10s), so reads see at
// most one stale interval. There is no cron: stale rows are invisible to list()
// immediately (read-time cutoff) and physically pruned by later heartbeats.
export const PRESENCE_TTL_MS = 30_000;

/** Upsert this client's presence row; opportunistically prune long-dead rows in
 *  the same scope so the table stays bounded without a cron. `leaving` deletes
 *  the row immediately (best-effort — a killed tab just times out instead). */
export const heartbeat = mutation({
  args: {
    scopeKey: v.string(),
    clientId: v.string(),
    userId: v.string(),
    dataJson: v.string(),
    leaving: v.optional(v.boolean())
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_scope_client", (q) => q.eq("scopeKey", args.scopeKey).eq("clientId", args.clientId))
      .first();
    if (args.leaving) {
      if (existing) {
        await ctx.db.delete(existing._id);
      }
      return null;
    }
    if (existing) {
      await ctx.db.patch(existing._id, { userId: args.userId, dataJson: args.dataJson, updatedAt: now });
    } else {
      await ctx.db.insert("presence", {
        scopeKey: args.scopeKey,
        clientId: args.clientId,
        userId: args.userId,
        dataJson: args.dataJson,
        updatedAt: now
      });
    }
    const stale = await ctx.db
      .query("presence")
      .withIndex("by_scope_updated", (q) => q.eq("scopeKey", args.scopeKey).lt("updatedAt", now - PRESENCE_TTL_MS * 2))
      .take(20);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    return null;
  }
});

/** Everyone fresh in the scope. Reactive: every heartbeat is a table write, so
 *  subscribers re-run at heartbeat granularity — no polling needed. */
export const list = query({
  args: { scopeKey: v.string() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    const rows = await ctx.db
      .query("presence")
      .withIndex("by_scope_updated", (q) => q.eq("scopeKey", args.scopeKey).gt("updatedAt", cutoff))
      .collect();
    return rows.map((row) => ({
      clientId: row.clientId,
      userId: row.userId,
      dataJson: row.dataJson,
      updatedAt: row.updatedAt
    }));
  }
});
