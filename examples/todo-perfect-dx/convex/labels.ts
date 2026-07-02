import { v } from "convex/values";
import { lf } from "./localfirst";

// Relation target for issue.labels (many-to-many via the issue_labels join table).
export const labels = lf.table("labels", {
  shape: {
    workspaceId: v.string(),
    name: v.string(),
    color: v.string()
  },
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  indexes: { byWorkspace: ["workspaceId", "name"] }
});

export const create = labels.insert({
  args: { workspaceId: v.string(), name: v.string(), color: v.string() },
  value: ({ args }) => ({ workspaceId: args.workspaceId, name: args.name, color: args.color })
});

// The join table. A link is itself a workspace-scoped local-first row.
export const issueLabels = lf.table("issue_labels", {
  shape: {
    workspaceId: v.string(),
    issueId: v.string(),
    labelId: v.string()
  },
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  indexes: { byWorkspace: ["workspaceId", "issueId"] }
});

export const link = issueLabels.insert({
  args: { workspaceId: v.string(), issueId: v.string(), labelId: v.string() },
  value: ({ args }) => ({
    workspaceId: args.workspaceId,
    issueId: args.issueId,
    labelId: args.labelId
  })
});

export const unlink = issueLabels.remove({ args: { id: v.string() } });
