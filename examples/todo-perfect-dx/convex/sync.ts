import { collectTables, createSyncFunctions } from "convex-localfirst/server";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

// Import the local-first table modules so collectTables reads each one's
// scope/idField/conflict from the SAME lf.table(...) definition the client manifest
// is generated from — no restating scopes here (that drift was a silent footgun).
// labels.ts declares two tables (labels + issue_labels); collectTables picks up both.
import * as todos from "./todos";
import * as issues from "./issues";
import * as projects from "./projects";
import * as comments from "./comments";
import * as labels from "./labels";
import * as documents from "./documents";
import * as docUpdates from "./docUpdates";

export const { push, pull, presence, presenceList } = createSyncFunctions({
  component: components.convexLocalFirst,
  mutation,
  query,
  tables: collectTables({ todos, issues, projects, comments, labels, documents, docUpdates }),
  // Membership (I7): the server — never the client — decides workspace access.
  // All workspace-scoped tables share ONE membership table (ws_members).
  async isMember(ctx, { userId, scopeValue, membershipTable }) {
    const row = await ctx.db
      .query(membershipTable)
      .withIndex("by_user_ws", (q: any) => q.eq("userId", userId).eq("workspaceId", scopeValue))
      .unique();
    return row !== null;
  },
  // This demo runs on a local backend with NO auth provider, so identity can't
  // come from auth. Trust the client userId here only — never set this in prod.
  devUnsafeAllowClientUserId: true
});
