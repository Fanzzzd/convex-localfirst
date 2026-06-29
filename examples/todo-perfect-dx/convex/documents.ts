import { v } from "convex/values";
import { lf } from "./localfirst";

// Notion-style pages: a workspace-scoped tree. Nesting is just a parentId FK to
// another document; the client builds the sidebar tree in memory (relations).
const documents = lf.table("documents", {
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  idField: "localId",
  conflict: lf.fieldLww(),
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
    workspaceId: String(args.workspaceId),
    title: String(args.title),
    icon: args.icon, // optional; validator enforces string|undefined (codegen needs a bare arg ref)
    parentId: args.parentId, // optional FK; same
    position: Number(args.position),
    createdAt: now,
    updatedAt: now
  })
});

export const rename = documents.patch({
  args: { id: v.string(), title: v.string() },
  patch: ({ args, now }) => ({ title: String(args.title), updatedAt: now })
});

export const setIcon = documents.patch({
  args: { id: v.string(), icon: v.string() },
  patch: ({ args, now }) => ({ icon: String(args.icon), updatedAt: now })
});

export const remove = documents.remove({ args: { id: v.string() } });
