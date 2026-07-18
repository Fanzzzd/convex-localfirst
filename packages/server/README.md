# @convex-localfirst/server

The Convex-side DSL for local-first tables. Declare which tables are local-first with
`lf.table`, and generate the sync `push`/`pull` functions with `createSyncFunctions` — the
server enforces scope, ownership, membership, and idempotency. Convex stays authoritative.

```bash
npm install @convex-localfirst/server
```

```ts
import { lf } from "./localfirst";
import { v } from "convex/values";

const todos = lf.table("todos", {
  shape: { ownerId: v.string(), listId: v.string(), text: v.string(), done: v.boolean() },
  scope: lf.byUser("ownerId"),
  timestamps: true,
  indexes: { byList: ["ownerId", "listId", "createdAt"] }
});

export const list = todos.query({
  args: { listId: v.string() },
  index: "byList",
  key: ({ auth, args }) => [auth.userId, args.listId],
  initial: []
});
export const create = todos.insert(); // args derived from the shape
export const update = todos.patch();  // { id } + any subset of fields
export const remove = todos.remove(); // { id }
```

Peer dependency: `convex`. MIT
