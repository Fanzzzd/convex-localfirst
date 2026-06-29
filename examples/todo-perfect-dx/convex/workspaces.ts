import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Plain Convex functions (NOT local-first). They exercise the drop-in fallback
// path (I11): the same useQuery/useMutation hooks call straight through to Convex.

/** Ensure the user is a member of the workspace (idempotent). */
export const join = mutation({
  args: { userId: v.string(), workspaceId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("ws_members")
      .withIndex("by_user_ws", (q) => q.eq("userId", args.userId).eq("workspaceId", args.workspaceId))
      .unique();
    if (existing) {
      return existing._id;
    }
    return await ctx.db.insert("ws_members", { userId: args.userId, workspaceId: args.workspaceId });
  }
});

/** How many members a workspace has (a plain Convex read, via fallback). */
export const memberCount = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const members = await ctx.db
      .query("ws_members")
      .withIndex("by_ws", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return members.length;
  }
});
