import { v } from "convex/values";
import { lf, scopeWorkspaceId } from "./localfirst";

// Cycles: time-boxed iterations within a project (Plane's ICycle). Same local-first
// byWorkspace shape as states/labels; scope field "workspace_id" (ICycle.workspace_id).
const cycles = lf.table("cycles", {
  scope: scopeWorkspaceId,
  indexes: { byWorkspace: ["workspace_id", "created_at"] }
});

export const create = cycles.insert({
  args: {
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    start_date: v.optional(v.union(v.string(), v.null())),
    end_date: v.optional(v.union(v.string(), v.null())),
    owned_by_id: v.optional(v.string()),
    sort_order: v.optional(v.number())
  },
  value: ({ args, now }) => ({
    workspace_id: String(args.workspace_id),
    project_id: String(args.project_id),
    name: String(args.name),
    description: args.description,
    start_date: args.start_date,
    end_date: args.end_date,
    owned_by_id: args.owned_by_id,
    sort_order: args.sort_order,
    created_at: now,
    updated_at: now
  })
});

export const update = cycles.patch({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    start_date: v.optional(v.union(v.string(), v.null())),
    end_date: v.optional(v.union(v.string(), v.null())),
    sort_order: v.optional(v.number())
  },
  patch: ({ args, now }) => ({
    name: args.name,
    description: args.description,
    start_date: args.start_date,
    end_date: args.end_date,
    sort_order: args.sort_order,
    updated_at: now
  })
});

export const remove = cycles.remove({ args: { id: v.string() } });
