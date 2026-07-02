import { v } from "convex/values";
import { lf, scopeWorkspaceId } from "./localfirst";

export const states = lf.table("states", {
  shape: {
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    color: v.string(),
    group: v.union(
      v.literal("backlog"),
      v.literal("unstarted"),
      v.literal("started"),
      v.literal("completed"),
      v.literal("cancelled")
    ),
    description: v.optional(v.string()),
    sequence: v.optional(v.number()),
    order: v.number(),
    default: v.optional(v.boolean()),
    created_at: v.number()
  },
  scope: scopeWorkspaceId,
  indexes: { byWorkspace: ["workspace_id", "created_at"] }
});

export const create = states.insert({
  args: {
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    color: v.string(),
    group: v.string(),
    order: v.number(),
    description: v.optional(v.string()),
    sequence: v.optional(v.number()),
    default: v.optional(v.boolean())
  },
  value: ({ args, now }) => ({
    workspace_id: String(args.workspace_id),
    project_id: String(args.project_id),
    name: String(args.name),
    color: String(args.color),
    group: String(args.group),
    order: Number(args.order),
    description: args.description,
    sequence: args.sequence,
    default: args.default,
    created_at: now
  })
});

export const update = states.patch({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    group: v.optional(v.string()),
    order: v.optional(v.number()),
    description: v.optional(v.string()),
    default: v.optional(v.boolean())
  }
  // no patch() → defaults to "forward every arg except id" (exactly these fields)
});

export const remove = states.remove({ args: { id: v.string() } });
