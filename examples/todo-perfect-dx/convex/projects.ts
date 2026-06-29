import { v } from "convex/values";
import { lf } from "./localfirst";

// Relation target for issue.project (one). Workspace-scoped, membership-enforced.
const projects = lf.table("projects", {
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  idField: "localId",
  conflict: lf.fieldLww(),
  indexes: { byWorkspace: ["workspaceId", "createdAt"] }
});

export const create = projects.insert({
  args: { workspaceId: v.string(), name: v.string(), color: v.string() },
  value: ({ args, now }) => ({
    workspaceId: String(args.workspaceId),
    name: String(args.name),
    color: String(args.color),
    createdAt: now
  })
});
