import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Operation ledger (Invariant I2: idempotency). Keyed by (userId, opId) — opId is
// globally unique (embeds the originating clientId + random), so a durable op replayed
// after a reload/new tab under a DIFFERENT envelope clientId still dedups. clientId is
// stored for audit only. Public so the app can call via components.convexLocalFirst.ops.*.

export const getByOpId = query({
  args: {
    userId: v.string(),
    opId: v.string()
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("ops")
      .withIndex("by_user_op", (q) => q.eq("userId", args.userId).eq("opId", args.opId))
      .unique();
    if (!row) {
      return null;
    }
    return { status: row.status, resultJson: row.resultJson, error: row.error, changesJson: row.changesJson };
  }
});

export const record = mutation({
  args: {
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
    changesJson: v.optional(v.string()),
    error: v.optional(v.string()),
    committedAt: v.number()
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("ops")
      .withIndex("by_user_op", (q) => q.eq("userId", args.userId).eq("opId", args.opId))
      .unique();
    if (existing) {
      return existing._id;
    }
    return await ctx.db.insert("ops", args);
  }
});
