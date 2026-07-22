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
      v.literal("cancelled"),
    ),
    description: v.optional(v.string()),
    sequence: v.optional(v.number()),
    order: v.number(),
    default: v.optional(v.boolean()),
  },
  scope: scopeWorkspaceId,
  timestamps: ["created_at", "updated_at"],
  indexes: { byWorkspace: ["workspace_id", "created_at"] },
});

export const create = states.insert();
export const update = states.patch();
export const remove = states.remove();
