import { v } from "convex/values";
import { query } from "./_generated/server";

// Minimal idempotency ledger: replay needs only the outcome, schema version, and
// confirming change payload. The original operation/args already live client-side.
export const getByOpId = query({
  args: { userId: v.string(), opId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("ops")
      .withIndex("by_user_op", (q) => q.eq("userId", args.userId).eq("opId", args.opId))
      .first();
    if (!row) return null;
    return {
      schemaVersion: row.schemaVersion,
      status: row.status,
      error: row.error,
      changesJson: row.changesJson
    };
  }
});
