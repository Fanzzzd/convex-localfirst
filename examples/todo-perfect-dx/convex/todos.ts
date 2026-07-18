import { v } from "convex/values";
import { lf } from "./localfirst";

// A byUser local-first table (simple scope). This declaration is the single
// source of truth: shape, scope, and indexes live HERE — schema.ts derives the
// Convex table via todos.table(), and the client runs these same closures
// optimistically (no codegen). `timestamps: true` adds createdAt/updatedAt and
// stamps them automatically.
export const todos = lf.table("todos", {
  shape: {
    ownerId: v.string(),
    listId: v.string(),
    text: v.string(),
    done: v.boolean()
  },
  scope: lf.byUser("ownerId"),
  timestamps: true,
  indexes: {
    byList: ["ownerId", "listId", "createdAt"]
  }
});

export const list = todos.query({
  args: { listId: v.string() },
  index: "byList",
  key: ({ auth, args }) => [auth.userId, args.listId],
  order: "asc",
  initial: []
});

// Custom insert: `done` defaults to false instead of being a caller arg. The
// owner comes from auth, timestamps stamp automatically.
export const create = todos.insert({
  args: { listId: v.string(), text: v.string() },
  value: ({ auth, args }) => ({ ownerId: auth.userId, listId: args.listId, text: args.text, done: false })
});

// No patch() closure: args forward 1:1 (updatedAt stamps automatically).
export const toggle = todos.patch({
  args: { id: v.string(), done: v.boolean() }
});

export const remove = todos.remove();
