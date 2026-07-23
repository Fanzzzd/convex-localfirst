import { v } from "convex/values";
import { lf, scopeWorkspaceId } from "./localfirst";

// Cycles: time-boxed iterations within a project (Plane's ICycle). Same local-first
// byWorkspace shape as states/labels; scope field "workspace_id" (ICycle.workspace_id).
export const cycles = lf.table("cycles", {
  shape: {
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    start_date: v.optional(v.union(v.string(), v.null())),
    end_date: v.optional(v.union(v.string(), v.null())),
    owned_by_id: v.optional(v.string()),
    sort_order: v.optional(v.number()),
  },
  scope: scopeWorkspaceId,
  timestamps: ["created_at", "updated_at"],
  indexes: { byWorkspace: ["workspace_id", "created_at"] },
});

export const create = cycles.insert();
export const update = cycles.patch();
export const remove = cycles.remove();
