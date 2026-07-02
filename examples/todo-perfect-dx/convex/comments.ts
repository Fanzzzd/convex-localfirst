import { v } from "convex/values";
import { lf } from "./localfirst";

// Relation target for issue.comments (one-to-many via comments.issueId).
export const comments = lf.table("comments", {
  shape: {
    workspaceId: v.string(),
    issueId: v.string(), // FK -> issues.localId (relation: issue.comments, one-to-many)
    author: v.string(),
    body: v.string(),
    createdAt: v.number()
  },
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  indexes: { byWorkspace: ["workspaceId", "createdAt"] }
});

export const add = comments.insert({
  args: { workspaceId: v.string(), issueId: v.string(), author: v.string(), body: v.string() },
  value: ({ args, now }) => ({
    workspaceId: args.workspaceId,
    issueId: args.issueId,
    author: args.author,
    body: args.body,
    createdAt: now
  })
});

export const remove = comments.remove({ args: { id: v.string() } });
