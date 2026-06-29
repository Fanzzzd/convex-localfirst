import { v } from "convex/values";
import { lf } from "./localfirst";

// Relation target for issue.comments (one-to-many via comments.issueId).
const comments = lf.table("comments", {
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  idField: "localId",
  conflict: lf.fieldLww(),
  indexes: { byWorkspace: ["workspaceId", "createdAt"] }
});

export const add = comments.insert({
  args: { workspaceId: v.string(), issueId: v.string(), author: v.string(), body: v.string() },
  value: ({ args, now }) => ({
    workspaceId: String(args.workspaceId),
    issueId: String(args.issueId),
    author: String(args.author),
    body: String(args.body),
    createdAt: now
  })
});

export const remove = comments.remove({ args: { id: v.string() } });
