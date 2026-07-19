# Convex Local-First

Local-first collections for [Convex](https://convex.dev). Keep writing Convex
queries, mutations, and React hooks — the tables you declare local-first read
and write optimistically, work offline, and sync in the background, with Convex
as the source of truth. Ordinary Convex functions keep working unchanged.

```bash
npm install convex-localfirst
```

## React

```tsx
import { useMutation, useQuery, useSyncStatus } from "convex-localfirst";
import { api } from "../convex/_generated/api";

export function Todos({ listId }: { listId: string }) {
  const todos = useQuery(api.todos.list, { listId }, { initial: [] });
  const create = useMutation(api.todos.create);
  const sync = useSyncStatus();

  return (
    <button
      type="button"
      disabled={sync.blockedBySchemaMismatch}
      onClick={() => create({ listId, text: "Ship a better DX" })}
    >
      Add {todos.length} todos
    </button>
  );
}
```

`useQuery` and `useMutation` are Convex-compatible (same call signatures, full
type inference from the function reference). Local-first tables resolve
locally; everything else falls back to the official Convex client.

## Server

Declare each local-first table **once** — its shape, scope, and indexes together
with the functions your React code calls. The Convex schema derives from it
(`todos.table()`), the server sync config derives from it (`collectTables`), and
the client runs the same declaration locally (the provider's `modules`). There is
no codegen step and nothing to keep in sync.

```ts
import { v } from "convex/values";
import { lf } from "./localfirst";

export const todos = lf.table("todos", {
  shape: {
    ownerId: v.string(),
    listId: v.string(),
    text: v.string(),
    done: v.boolean()
  },
  scope: lf.byUser("ownerId"),
  timestamps: true, // adds createdAt/updatedAt, stamped automatically
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

// Derived from the shape: create takes { listId, text, done } (the owner comes
// from auth), update takes { id } + any subset of fields, remove takes { id }.
export const create = todos.insert();
export const update = todos.patch();
export const remove = todos.remove();
```

Server-side code (activity feeds, importers, crons) writes the same tables
through `serverWriter` — rows land in the change log, so every client syncs them:

```ts
export const { push, pull, serverWriter } = createSyncFunctions({ ... });

export const logActivity = mutation({
  handler: async (ctx) => {
    await serverWriter(ctx).insert("activities", { workspaceId, verb: "created" });
  }
});
```

```ts
// convex/schema.ts — derived, never restated
export default defineSchema({ todos: todos.table() });

// convex/sync.ts — derived, never restated
export const { push, pull } = createSyncFunctions({
  component: components.convexLocalFirst,
  mutation, query,
  tables: collectTables({ todos })
});
```

```tsx
// src/main.tsx — the client imports the same modules; store/transport/ids default
import * as todos from "../convex/todos";

<ConvexProvider client={convex} localFirst={{ modules: { todos }, userId }}>
```

The server stays authoritative: every pushed operation is validated against
auth, table scope (`byUser` / `byWorkspace` / `byProject`), row ownership or
membership, schema version, and an idempotency ledger.

## One package, subpath entries

`npm install convex-localfirst` is the whole install (like `convex` itself).
Everything lives behind subpath exports:

| Entry | What it is |
| --- | --- |
| [`convex-localfirst`](./packages/localfirst/src/react) | The client surface: Convex-compatible `useQuery` / `useMutation`, `useSyncStatus`, drop-in `ConvexProvider` |
| [`convex-localfirst/server`](./packages/localfirst/src/server) | The `lf.table` DSL and the server sync engine (`createSyncFunctions`, `collectTables`) |
| [`convex-localfirst/component`](./packages/localfirst/component) | Mountable Convex component holding the sync bookkeeping: ledger, change log (GC'd opportunistically), id map, row versions |
| [`convex-localfirst/core`](./packages/localfirst/src/core) | Local engine: derived live view (`canonical + replay(pending)`), IndexedDB store, multi-tab leader election, sync protocol, convergent merges |
| [`convex-localfirst/yjs`](./packages/localfirst/src/yjs) | Yjs CRDT (rich text) over the local-first append-only log, plus `useCollaborativeDoc` (optional `yjs` peer) |
| [`npx convex-localfirst`](./packages/localfirst/src/cli) | The CLI: `init` (scaffold a complete starter), `check` (no direct writes to local-first tables) |

(The pre-0.3 `@convex-localfirst/*` scoped packages are legacy — frozen at 0.2.1;
all future releases ship only `convex-localfirst`.)

## Documentation

The docs site lives in [`website/`](./website) — installation, the full setup
walkthrough, the server DSL, the React hooks, syncing and the trust model, and
the API reference.

```bash
cd website && npm install && npm run dev   # http://localhost:3000
```

## Examples

- [`examples/todo-perfect-dx`](./examples/todo-perfect-dx) — a Linear-lite
  board (`byWorkspace` issues + `byUser` todos) with the mounted component, a
  Playwright browser suite, and live-sync scripts against a real Convex backend.
- [`examples/plane`](./examples/plane) — a larger project-tracker example.

## Development

```bash
pnpm install
pnpm ci        # build + typecheck + test all packages
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the changeset/release flow.

## Design constraints

- No Convex backend in the browser; Convex remains authoritative for
  validation, auth, idempotency, and canonical ordering.
- Local-first is opt-in per table, with an explicit sync scope — never the
  whole database by default.
- Writes to local-first tables go through the DSL; the CLI's `check` catches
  direct `ctx.db` writes.
- Side-effecting actions stay server-only.

## License

MIT
