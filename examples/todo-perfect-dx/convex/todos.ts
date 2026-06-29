import { v } from "convex/values";
import { lf } from "./localfirst";

const todos = lf.table("todos", {
  scope: lf.byUser("ownerId"),
  idField: "localId",
  conflict: lf.fieldLww(),
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
    listId: String(args.listId),
    text: String(args.text),
    done: false,
    createdAt: now,
    updatedAt: now
  })
});

export const toggle = todos.patch({
  args: { id: v.string(), done: v.boolean() },
  patch: ({ args, now }) => ({
    done: Boolean(args.done),
    updatedAt: now
  })
});

export const remove = todos.remove({ args: { id: v.string() } });
