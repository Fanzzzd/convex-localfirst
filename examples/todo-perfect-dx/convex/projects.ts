import { v } from "convex/values";
import { lf } from "./localfirst";

// Relation target for issue.project (one). Workspace-scoped, membership-enforced.
export const projects = lf.table("projects", {
  shape: {
    workspaceId: v.string(),
    name: v.string(),
    color: v.string(),
    createdAt: v.number()
  },
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  indexes: { byWorkspace: ["workspaceId", "createdAt"] }
});

export const create = projects.insert({
  args: { workspaceId: v.string(), name: v.string(), color: v.string() },
  value: ({ args, now }) => ({
    workspaceId: args.workspaceId,
    name: args.name,
    color: args.color,
    createdAt: now
  })
});
