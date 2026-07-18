import { v } from "convex/values";
import { lf, scopeWorkspaceId } from "./localfirst";

export const labels = lf.table("labels", {
  shape: {
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    color: v.string(),
    parent: v.optional(v.union(v.string(), v.null())),
    sort_order: v.optional(v.number())
  },
  scope: scopeWorkspaceId,
  timestamps: ["created_at", "updated_at"],
  indexes: { byWorkspace: ["workspace_id", "created_at"] }
});

export const create = labels.insert();
export const update = labels.patch();
export const remove = labels.remove();
