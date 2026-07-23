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
  },
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  timestamps: true,
  indexes: { byWorkspace: ["workspaceId", "position"] },
});

export const create = documents.insert();

// No patch() closures: args forward 1:1 (updatedAt stamps automatically).
export const rename = documents.patch({
  args: { id: v.string(), title: v.string() },
});

export const setIcon = documents.patch({
  args: { id: v.string(), icon: v.string() },
});

export const remove = documents.remove();
