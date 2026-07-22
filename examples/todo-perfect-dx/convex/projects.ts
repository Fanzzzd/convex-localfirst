import { v } from "convex/values";
import { lf } from "./localfirst";

// Relation target for issue.project (one). Workspace-scoped, membership-enforced.
export const projects = lf.table("projects", {
  shape: {
    workspaceId: v.string(),
    name: v.string(),
    color: v.string(),
  },
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  timestamps: true,
  indexes: { byWorkspace: ["workspaceId", "createdAt"] },
});

export const create = projects.insert();
