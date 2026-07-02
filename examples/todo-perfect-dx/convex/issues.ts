import { v } from "convex/values";
import { lf } from "./localfirst";

// A workspace-scoped local-first table (Linear-lite). Reads/writes are local +
// optimistic; the server enforces workspace membership on push and pull (I7).
export const issues = lf.table("issues", {
  shape: {
    workspaceId: v.string(),
    projectId: v.optional(v.string()), // FK -> projects.localId (relation: issue.project); optional so an issue can be unfiled
    title: v.string(),
    status: v.union(v.literal("backlog"), v.literal("in_progress"), v.literal("done")),
    priority: v.number(),
    assignee: v.string(),
    createdAt: v.number(),
    updatedAt: v.number()
  },
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  indexes: {
    byWorkspace: ["workspaceId", "createdAt"]
  }
});

export const list = issues.query({
  args: { workspaceId: v.string() },
  index: "byWorkspace",
  key: ({ args }) => [args.workspaceId],
  order: "asc",
  initial: []
});

export const create = issues.insert({
  args: { workspaceId: v.string(), projectId: v.optional(v.string()), title: v.string(), priority: v.number(), assignee: v.string() },
  value: ({ args, now }) => ({
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    title: args.title,
    status: "backlog",
    priority: args.priority,
    assignee: args.assignee,
    createdAt: now,
    updatedAt: now
  })
});

export const setStatus = issues.patch({
  args: { id: v.string(), status: v.string() },
  patch: ({ args, now }) => ({ status: args.status, updatedAt: now })
});

export const setPriority = issues.patch({
  args: { id: v.string(), priority: v.number() },
  patch: ({ args, now }) => ({ priority: args.priority, updatedAt: now })
});

export const remove = issues.remove({ args: { id: v.string() } });
