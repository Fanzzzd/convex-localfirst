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
    sort_order: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number()
  },
  scope: scopeWorkspaceId,
  indexes: { byWorkspace: ["workspace_id", "created_at"] },
  setFields: ["member_ids"]
});

export const create = modules.insert({
  args: {
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
  value: ({ args, now }) => ({
    workspace_id: String(args.workspace_id),
    project_id: String(args.project_id),
    name: String(args.name),
    description: args.description,
    status: args.status,
    start_date: args.start_date,
    target_date: args.target_date,
    lead_id: args.lead_id,
    member_ids: args.member_ids,
    sort_order: args.sort_order,
    created_at: now,
    updated_at: now
  })
});

export const update = modules.patch({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    start_date: v.optional(v.union(v.string(), v.null())),
    target_date: v.optional(v.union(v.string(), v.null())),
    lead_id: v.optional(v.union(v.string(), v.null())),
    member_ids: v.optional(v.array(v.string())),
    sort_order: v.optional(v.number())
  },
  patch: ({ args, now }) => ({
    name: args.name,
    description: args.description,
    status: args.status,
    start_date: args.start_date,
    target_date: args.target_date,
    lead_id: args.lead_id,
    member_ids: args.member_ids,
    sort_order: args.sort_order,
    updated_at: now
  })
});

export const remove = modules.remove({ args: { id: v.string() } });
