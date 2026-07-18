import { collectTables, createSyncFunctions } from "@convex-localfirst/server";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

// Import the local-first table modules so collectTables can read each one's
// scope/idField/conflict from the SAME lf.table(...) definition the client manifest
// is generated from. No restating scope field names or idField/conflict here — that
// drift (edit one file, forget the other) was a silent footgun. Add a table = add
// one import line below; its config comes along for free.
import * as projects from "./projects";
import * as comments from "./comments";
import * as views from "./views";
import * as activities from "./issue_activities";
import * as states from "./states";
import * as labels from "./labels";
import * as cycles from "./cycles";
import * as modules from "./modules";
import * as issues from "./issues";

export const { push, pull } = createSyncFunctions({
  component: components.convexLocalFirst,
  mutation,
  query,
  tables: collectTables({ projects, comments, views, activities, states, labels, cycles, modules, issues }),
  // Membership (I7): the server decides workspace access. scopeValue is the workspace
  // slug/id regardless of which field the table stores it in. All workspace tables
  // share ONE membership table (ws_members), so this is a single check.
  async isMember(ctx, { userId, scopeValue, membershipTable }) {
    const row = await ctx.db
      .query(membershipTable)
      .withIndex("by_user_ws", (q: any) => q.eq("user_id", userId).eq("workspace_id", scopeValue))
      .unique();
    return row !== null;
  },
  // Plane's EUserWorkspaceRoles guest rule (role 5): within a workspace a guest only
  // sees issues they created or are assigned to. Rows entering/leaving visibility
  // arrive as full-row upserts/deletes automatically, and guests can't patch/delete
  // rows they can't see.
  visibility: {
    issues: async (ctx, { userId, row }) => {
      const member = await ctx.db
        .query("ws_members")
        .withIndex("by_user_ws", (q: any) => q.eq("user_id", userId).eq("workspace_id", row.workspace_id))
        .unique();
      if ((member?.role ?? 0) > 5) return true; // admin/member: everything
      return row.created_by === userId || ((row.assignee_ids as string[] | undefined) ?? []).includes(userId);
    }
  },
  // Server-minted per-project issue numbers (PROJ-123). Runs inside the push
  // transaction, so the counter read-modify-write is race-free under Convex OCC.
  serverStamp: {
    issues: async (ctx, { value }) => {
      const key = `issue_seq:${value.project_id}`;
      const counter = await ctx.db
        .query("counters")
        .withIndex("by_key", (q: any) => q.eq("key", key))
        .unique();
      const next = (counter?.value ?? 0) + 1;
      if (counter) await ctx.db.patch(counter._id, { value: next });
      else await ctx.db.insert("counters", { key, value: next });
      return { sequence_id: next };
    }
  },
  // Local backend has no auth provider; identity comes from the client userId. Dev only.
  devUnsafeAllowClientUserId: true
});
