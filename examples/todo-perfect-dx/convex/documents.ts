import { v } from "convex/values";
import { lf } from "./localfirst";

// Notion-style pages: a workspace-scoped tree. Nesting is just a parentId FK to
// another document; the client builds the sidebar tree in memory (relations).
export const documents = lf.table("documents", {
  shape: {
    workspaceId: v.string(),
    title: v.string(),
    icon: v.optional(v.string()), // emoji
    parentId: v.optional(v.string()), // FK -> documents.localId (tree; root pages have none)
    position: v.number(), // sibling order
    createdAt: v.number(),
    updatedAt: v.number()
  },
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  indexes: { byWorkspace: ["workspaceId", "position"] }
});

export const create = documents.insert({
  args: {
    workspaceId: v.string(),
    title: v.string(),
    icon: v.optional(v.string()),
    parentId: v.optional(v.string()),
    position: v.number()
  },
  value: ({ args, now }) => ({
    workspaceId: args.workspaceId,
    title: args.title,
    icon: args.icon,
    parentId: args.parentId,
    position: args.position,
    createdAt: now,
    updatedAt: now
  })
});

export const rename = documents.patch({
  args: { id: v.string(), title: v.string() },
  patch: ({ args, now }) => ({ title: args.title, updatedAt: now })
});

export const setIcon = documents.patch({
  args: { id: v.string(), icon: v.string() },
  patch: ({ args, now }) => ({ icon: args.icon, updatedAt: now })
});

export const remove = documents.remove({ args: { id: v.string() } });
