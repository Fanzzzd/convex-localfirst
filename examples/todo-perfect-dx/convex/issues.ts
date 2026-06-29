import { v } from "convex/values";
import { lf } from "./localfirst";

// A workspace-scoped local-first table (Linear-lite). Reads/writes are local +
// optimistic; the server enforces workspace membership on push and pull (I7).
const issues = lf.table("issues", {
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  idField: "localId",
  conflict: lf.fieldLww(),
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
    workspaceId: String(args.workspaceId),
    projectId: args.projectId, // optional; validator enforces string|undefined (codegen needs a bare arg ref)
    title: String(args.title),
    status: "backlog",
    priority: Number(args.priority),
    assignee: String(args.assignee),
    createdAt: now,
    updatedAt: now
  })
});

export const setStatus = issues.patch({
  args: { id: v.string(), status: v.string() },
  patch: ({ args, now }) => ({ status: String(args.status), updatedAt: now })
});

export const setPriority = issues.patch({
  args: { id: v.string(), priority: v.number() },
  patch: ({ args, now }) => ({ priority: Number(args.priority), updatedAt: now })
});

export const remove = issues.remove({ args: { id: v.string() } });
