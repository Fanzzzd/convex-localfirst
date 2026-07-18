import { v } from "convex/values";
import { lf } from "./localfirst";

// Relation target for issue.comments (one-to-many via comments.issueId).
export const comments = lf.table("comments", {
  shape: {
    workspaceId: v.string(),
    issueId: v.string(), // FK -> issues.localId (relation: issue.comments, one-to-many)
    author: v.string(),
    body: v.string()
  },
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  timestamps: true,
  indexes: { byWorkspace: ["workspaceId", "createdAt"] }
});

export const add = comments.insert();
export const remove = comments.remove();
