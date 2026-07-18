import { v } from "convex/values";
import { lf, scopeWorkspaceId } from "./localfirst";

// Modules: a grouping of issues within a project (Plane's IModule). Same local-first
// byWorkspace shape as cycles; scope field "workspace_id" (IModule.workspace_id).
// member_ids is a SET field so concurrent member adds/removes merge (not clobber).
export const modules = lf.table("modules", {
  shape: {
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    start_date: v.optional(v.union(v.string(), v.null())),
    target_date: v.optional(v.union(v.string(), v.null())),
    lead_id: v.optional(v.union(v.string(), v.null())),
    member_ids: v.optional(v.array(v.string())),
    sort_order: v.optional(v.number())
  },
  scope: scopeWorkspaceId,
  timestamps: ["created_at", "updated_at"],
  indexes: { byWorkspace: ["workspace_id", "created_at"] },
  setFields: ["member_ids"]
});

export const create = modules.insert();
export const update = modules.patch();
export const remove = modules.remove();
