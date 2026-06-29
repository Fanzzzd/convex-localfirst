import { v } from "convex/values";
import { lf } from "./localfirst";

// Relation target for issue.labels (many-to-many via the issue_labels join table).
const labels = lf.table("labels", {
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  idField: "localId",
  conflict: lf.fieldLww(),
  indexes: { byWorkspace: ["workspaceId", "name"] }
});

export const create = labels.insert({
  args: { workspaceId: v.string(), name: v.string(), color: v.string() },
  value: ({ args }) => ({ workspaceId: String(args.workspaceId), name: String(args.name), color: String(args.color) })
});

// The join table. A link is itself a workspace-scoped local-first row.
const issueLabels = lf.table("issue_labels", {
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  idField: "localId",
  conflict: lf.fieldLww(),
  indexes: { byWorkspace: ["workspaceId", "issueId"] }
});

export const link = issueLabels.insert({
  args: { workspaceId: v.string(), issueId: v.string(), labelId: v.string() },
  value: ({ args }) => ({
    workspaceId: String(args.workspaceId),
    issueId: String(args.issueId),
    labelId: String(args.labelId)
  })
});

export const unlink = issueLabels.remove({ args: { id: v.string() } });
