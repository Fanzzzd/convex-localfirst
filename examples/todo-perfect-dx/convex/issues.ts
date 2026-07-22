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
  },
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  timestamps: true,
  relations: {
    project: lf.one("projects", "projectId"),
    comments: lf.backref("comments", "issueId"),
  },
  indexes: {
    byWorkspace: ["workspaceId", "createdAt"],
  },
});

export const list = issues.query({
  args: { workspaceId: v.string() },
  index: "byWorkspace",
  key: ({ args }) => [args.workspaceId],
  order: "asc",
  initial: [],
});

// Custom insert: status starts at "backlog" instead of being a caller arg.
export const create = issues.insert({
  args: {
    workspaceId: v.string(),
    projectId: v.optional(v.string()),
    title: v.string(),
    priority: v.number(),
    assignee: v.string(),
  },
  value: ({ args }) => ({ ...args, status: "backlog" }),
});

// No patch() closures: args forward 1:1 (updatedAt stamps automatically).
export const setStatus = issues.patch({
  args: { id: v.string(), status: v.string() },
});

export const setPriority = issues.patch({
  args: { id: v.string(), priority: v.number() },
});

export const remove = issues.remove();
