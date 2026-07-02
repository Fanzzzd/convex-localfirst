import { v } from "convex/values";
import { lf, scopeWorkspaceId } from "./localfirst";

export const labels = lf.table("labels", {
  shape: {
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    color: v.string(),
    parent: v.optional(v.union(v.string(), v.null())),
    sort_order: v.optional(v.number()),
    created_at: v.number()
  },
  scope: scopeWorkspaceId,
  indexes: { byWorkspace: ["workspace_id", "created_at"] }
});

export const create = labels.insert({
  args: {
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    color: v.string(),
    parent: v.optional(v.union(v.string(), v.null())),
    sort_order: v.optional(v.number())
  },
  value: ({ args, now }) => ({
    workspace_id: String(args.workspace_id),
    project_id: String(args.project_id),
    name: String(args.name),
    color: String(args.color),
    parent: args.parent,
    sort_order: args.sort_order,
    created_at: now
  })
});

export const update = labels.patch({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    parent: v.optional(v.union(v.string(), v.null())),
    sort_order: v.optional(v.number())
  }
  // no patch() → defaults to "forward every arg except id" (exactly these fields)
});

export const remove = labels.remove({ args: { id: v.string() } });
