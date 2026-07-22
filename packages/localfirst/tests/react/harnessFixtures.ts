import { v } from "convex/values";
import { createLocalFirst } from "../../src/server/index.js";

// Isomorphic lf.table modules used by the test-harness and devtools tests. In jsdom the
// exports are metadata-only stubs (registerFunction is a no-op in the browser) — exactly
// what collectManifest / collectTables / createLocalDb read.
const lf = createLocalFirst({ schemaVersion: 1 });

// --- byUser todos -----------------------------------------------------------
const todosTable = lf.table("todos", {
  // The partition field (ownerId) is part of the shape — auth-derived on insert, but a
  // real synced column (like the plane/todo examples).
  shape: { ownerId: v.string(), text: v.string(), done: v.boolean() },
  scope: lf.byUser("ownerId"),
  timestamps: true,
  indexes: { byOwner: ["ownerId", "createdAt"] }
});
export const todos = {
  todos: todosTable,
  create: todosTable.insert({
    args: { text: v.string() },
    value: ({ auth, args }) => ({ ownerId: auth.userId, text: args.text, done: false })
  }),
  toggle: todosTable.patch({ args: { id: v.string(), done: v.boolean() } }),
  remove: todosTable.remove(),
  list: todosTable.query({ args: {}, index: "byOwner", key: ({ auth }) => [auth.userId], order: "asc", initial: [] })
};
export const todoModules = { todos };

// --- byWorkspace docs (drives the access.write rejection scenario) ----------
const docsTable = lf.table("docs", {
  shape: { wsId: v.string(), title: v.string() },
  scope: lf.byWorkspace({ workspaceIdField: "wsId", membershipTable: "members" }),
  indexes: { byWs: ["wsId", "title"] }
});
export const docs = {
  docs: docsTable,
  create: docsTable.insert(),
  rename: docsTable.patch(),
  remove: docsTable.remove()
};
export const docModules = { docs };
