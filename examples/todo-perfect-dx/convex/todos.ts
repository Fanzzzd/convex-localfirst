import { v } from "convex/values";
import { lf } from "./localfirst";

// A byUser local-first table (simple scope). This declaration is the single
// source of truth: shape, scope, and indexes live HERE — schema.ts derives the
// Convex table via todos.table(), and the client runs these same closures
// optimistically (no codegen).
export const todos = lf.table("todos", {
  shape: {
    ownerId: v.string(),
    listId: v.string(),
    text: v.string(),
    done: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number()
  },
  scope: lf.byUser("ownerId"),
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

export const create = todos.insert({
  args: { listId: v.string(), text: v.string() },
  value: ({ auth, args, now }) => ({
    ownerId: auth.userId,
    listId: args.listId,
    text: args.text,
    done: false,
    createdAt: now,
    updatedAt: now
  })
});

export const toggle = todos.patch({
  args: { id: v.string(), done: v.boolean() },
  patch: ({ args, now }) => ({
    done: args.done,
    updatedAt: now
  })
});

export const remove = todos.remove({ args: { id: v.string() } });
