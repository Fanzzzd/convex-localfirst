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
  scope: lf.byUser("ownerId"),
  idField: "localId",
  conflict: lf.fieldLww(),
  indexes: { byList: ["ownerId", "listId", "createdAt"] }
});

export const list = todos.query({ args: { listId: v.string() }, index: "byList", initial: [] });
export const create = todos.insert({ args: { text: v.string() }, value: ({ auth, args, now }) => ({ ... }) });
```

Peer dependency: `convex`. MIT
