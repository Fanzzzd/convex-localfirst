import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Regular Convex (NOT local-first): identity + workspace membership, the server-
// authority slice that replaces Plane's Django auth/membership endpoints. The
// rewritten WorkspaceService/UserService call these directly via the Convex client.

/** Create a workspace + make the creator an admin member (idempotent on id). */
export const createWorkspace = mutation({
  args: { user_id: v.string(), id: v.string(), name: v.string(), slug: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("workspaces")
      .withIndex("byId", (q) => q.eq("id", args.id))
      .unique();
    if (!existing) {
      await ctx.db.insert("workspaces", {
        id: args.id,
        name: args.name,
        slug: args.slug,
        owner_id: args.user_id,
        logo_url: null,
        total_members: 1,
        total_projects: 0,
        organization_size: "",
        timezone: "UTC",
        created_at: Date.now(),
        created_by: args.user_id
      });
    }
    const member = await ctx.db
      .query("ws_members")
      .withIndex("by_user_ws", (q) => q.eq("user_id", args.user_id).eq("workspace_id", args.id))
      .unique();
    if (!member) {
      await ctx.db.insert("ws_members", { user_id: args.user_id, workspace_id: args.id, role: 20 });
    }
    return args.id;
  }
});

/** Add (or update the role of) a member in a workspace. Idempotent on
 *  (user_id, workspace_id). The membership table `ws_members` is exactly what the
 *  sync layer's `isMember` check (I7) reads, so this is the single source of
 *  workspace access. Server-only mutation — clients never write membership. */
export const addMember = mutation({
  args: { user_id: v.string(), workspace_id: v.string(), role: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("ws_members")
      .withIndex("by_user_ws", (q) => q.eq("user_id", args.user_id).eq("workspace_id", args.workspace_id))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { role: args.role });
      return existing._id;
    }
    return await ctx.db.insert("ws_members", {
      user_id: args.user_id,
      workspace_id: args.workspace_id,
      role: args.role
    });
  }
});

/** Ensure a user record exists (idempotent) — backs the members list. */
export const upsertUser = mutation({
  args: {
    id: v.string(),
    email: v.string(),
    display_name: v.string(),
    first_name: v.string(),
    last_name: v.string(),
    avatar_url: v.string()
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("byId", (q) => q.eq("id", args.id))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args });
      return args.id;
    }
    await ctx.db.insert("users", { ...args, is_active: true, is_bot: false });
    return args.id;
  }
});

/** Workspaces the user belongs to (joins ws_members -> workspaces), with role. */
export const listMine = query({
  args: { user_id: v.string() },
  handler: async (ctx, args) => {
    const memberships = await ctx.db
      .query("ws_members")
      .withIndex("by_user_ws", (q) => q.eq("user_id", args.user_id))
      .collect();
    const out = [];
    for (const m of memberships) {
      const ws = await ctx.db
        .query("workspaces")
        .withIndex("byId", (q) => q.eq("id", m.workspace_id))
        .unique();
      if (ws) {
        out.push({ ...ws, role: m.role });
      }
    }
    return out;
  }
});

/** Members of a workspace, shaped like Plane's IWorkspaceMember (member: IUserLite). */
export const members = query({
  args: { workspace_id: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("ws_members")
      .withIndex("by_ws", (q) => q.eq("workspace_id", args.workspace_id))
      .collect();
    const out = [];
    for (const r of rows) {
      const u = await ctx.db
        .query("users")
        .withIndex("byId", (q) => q.eq("id", r.user_id))
        .unique();
      out.push({
        id: r._id,
        role: r.role,
        member: u
          ? {
              id: u.id,
              display_name: u.display_name,
              first_name: u.first_name,
              last_name: u.last_name,
              email: u.email,
              avatar_url: u.avatar_url,
              is_bot: u.is_bot
            }
          : { id: r.user_id, display_name: r.user_id, first_name: r.user_id, last_name: "", email: "", avatar_url: "", is_bot: false }
      });
    }
    return out;
  }
});
