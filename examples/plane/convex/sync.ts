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
  // Local backend has no auth provider; identity comes from the client userId. Dev only.
  devUnsafeAllowClientUserId: true
});
