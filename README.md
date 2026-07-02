# Convex Local-First

Local-first collections for [Convex](https://convex.dev). Keep writing Convex
queries, mutations, and React hooks — the tables you declare local-first read
and write optimistically, work offline, and sync in the background, with Convex
as the source of truth. Ordinary Convex functions keep working unchanged.

```bash
npm install @convex-localfirst/react @convex-localfirst/server @convex-localfirst/component
```

## React

```tsx
import { useMutation, useQuery, useSyncStatus } from "@convex-localfirst/react";
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

Declare local-first tables with the `lf.table` DSL in your Convex modules:

```ts
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
    listId: args.listId,
    text: args.text,
    done: false,
    createdAt: now,
    updatedAt: now
  })
});
```

The server stays authoritative: every pushed operation is validated against
auth, table scope (`byUser` / `byWorkspace` / `byProject`), row ownership or
membership, schema version, and an idempotency ledger.

## Packages

| Package | What it is |
| --- | --- |
| [`@convex-localfirst/core`](./packages/core) | Local engine: derived live view (`canonical + replay(pending)`), IndexedDB store, multi-tab leader election, sync protocol, convergent merges (set / counter / timestamp-LWW) |
| [`@convex-localfirst/react`](./packages/react) | Convex-compatible `useQuery` / `useMutation`, `useSyncStatus`, Convex fallback |
| [`@convex-localfirst/server`](./packages/server) | The `lf.table` DSL and the server sync engine (`createSyncFunctions`, `collectTables`) |
| [`@convex-localfirst/component`](./packages/component) | Mountable Convex component holding the sync bookkeeping: ledger, change log, id map, field clocks |
| [`@convex-localfirst/cli`](./packages/cli) | `codegen` (client manifest from the DSL), `check` (no direct writes to local-first tables), `dev` |
| [`@convex-localfirst/yjs`](./packages/yjs) | Yjs CRDT (rich text) over the local-first append-only log, plus `useCollaborativeDoc` |

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
