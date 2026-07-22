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
export const { push, pull, gc, serverWriter } = createSyncFunctions({ ... });

export const logActivity = mutation({
  handler: async (ctx) => {
    await serverWriter(ctx, actingUserId).insert("activities", { workspaceId, verb: "created" });
  }
});
```

```ts
// convex/schema.ts — derived, never restated
export default defineSchema({ todos: todos.table() });

// convex/sync.ts — derived, never restated
export const { push, pull, gc } = createSyncFunctions({
  component: components.convexLocalFirst,
  mutation, internalMutation, query,
  tables: collectTables({ todos, issues }),
  access: {
    // Called once per requested scope. null/undefined denies pull and push.
    member: async (ctx, { userId, scopeValue }) =>
      await roleForWorkspace(ctx, userId, scopeValue),
    read: (_ctx, { role, userId, row }) =>
      role !== "guest" || row.createdBy === userId,
    write: (_ctx, { role, userId, action, before, proposed }) =>
      role === "admin" ||
      (role === "guest" &&
        (action === "insert" ? proposed?.createdBy === userId : before?.createdBy === userId))
  },
  // Transactional and exactly once on first acceptance; ledger replay skips it.
  onWrite: async (ctx, write) => recordActivity(ctx, write)
});
```

`byUser` tables remain owner-only and do not call `access.member`. Workspace and
project scopes require `access.member`; `read` and `write` default to allowing
members when omitted. Authentication uses `identity.tokenIdentifier` by default,
with `getUserId(ctx)` available for custom identity mapping. Schedule the returned
internal `gc` mutation to prune expired ledger and change-log rows; appends also do
a small opportunistic prune.

```tsx
// src/main.tsx — the client imports the same modules; store/transport/ids default
import * as todos from "../convex/todos";

<ConvexProvider client={convex} localFirst={{ modules: { todos }, userId }}>
```

The server stays authoritative: every pushed operation is validated against
auth, table scope (`byUser` / `byWorkspace` / `byProject`), row ownership or
membership, schema version, and an idempotency ledger.

### Garbage collection (cron)

`createSyncFunctions` returns an internal `gc` mutation (pass Convex's
`internalMutation` so it's exposed as an internal function). Schedule it to prune
expired ledger and change-log rows — appends also do a small opportunistic prune:

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("localfirst gc", { hours: 1 }, internal.sync.gc, {});
export default crons;
```

## More building blocks

### Full-text search

Declare `searchFields` on a table (priority order; HTML fields are tag-stripped),
then search-as-you-type with `useSearch` — a memory-resident incremental index, no
debounce needed:

```ts
export const issues = lf.table("issues", {
  shape: { title: v.string(), description_html: v.string() /* … */ },
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "members" }),
  searchFields: ["title", "description_html"]
});
```

```tsx
const { results, total } = useSearch("issues", query, { scope: { workspaceId }, limit: 20 });
```

### Fractional ranking (kanban / manual order)

Rank helpers keep a stable client-side order between two neighbours without
renumbering — ideal for drag-and-drop:

```ts
import { rankBetween, rankCompare, isValidRank, rebalance } from "convex-localfirst";

const rank = rankBetween(prev?.rank ?? null, next?.rank ?? null); // store on the row
issues.sort((a, b) => rankCompare(a.rank, b.rank));
```

### Attachments (offline-capable)

The blob is persisted locally first (creating offline succeeds), then the leader
tab uploads to Convex file storage in the background with retries; the server
stamps the `storageId` on the synced metadata row.

```ts
// server: compose the upload endpoints, authorized by the SAME access config
export const { getUploadUrl, finalize } = createAttachmentFunctions({
  component: components.convexLocalFirst, mutation, query,
  tables, access, table: "attachments",
  generateUploadUrl: (ctx) => ctx.storage.generateUploadUrl()
});
```

```tsx
// client: insert the metadata row + persist the blob, then watch upload progress
const create = useCreateAttachment(api.attachments.create);
const { localId } = await create({ metadata: { issue_id, name, size, mime_type }, blob });
const upload = useAttachmentUpload(localId); // { state, progress }
```

### Collaborative docs (Yjs)

`useCollaborativeDoc` returns `{ doc, status }` (a live `Y.Doc` plus durability
status). Content syncs through an append-only log with durable, retried appends and
server-confirmed compaction. Cursor/selection awareness lives at the
`convex-localfirst/yjs/awareness` subpath (so the main entry never pulls the
optional `y-protocols` peer).

```tsx
import { useCollaborativeDoc } from "convex-localfirst/yjs";
import { useDocAwareness } from "convex-localfirst/yjs/awareness";

const updates = useLiveQuery(collection("doc_updates").scope({ workspace })) ?? [];
const appendRow = useMutation(api.doc_updates.append);
const pruneRow = useMutation(api.doc_updates.remove);
const { doc, status } = useCollaborativeDoc({
  docId, updates, idField: "id",
  append: (update) => appendRow({ workspace, doc: docId, update }),
  prune: (id) => pruneRow({ id })
});
// Bind an editor to doc.getXmlFragment(...); TipTap → ySyncPlugin(doc.getXmlFragment("prosemirror"))
const { awareness } = useDocAwareness(doc, { docId, scope: { workspace }, state: { user } });
```

### Recovering stuck writes

`useSyncRecovery` surfaces durable writes needing attention — operations the server
rejected, operations stranded in an older schema-version namespace, and failed
attachment uploads — so the app can export, migrate, or discard them:

```tsx
const { rejectedOperations, olderSchemaOperations, failedAttachments } = useSyncRecovery();
```

## Module format

This package is **ESM-only** — there is no CommonJS (`require`) build. It targets
Node **>=18** with ESM (`"type": "module"` or `.mjs`), Next.js (app router),
Vite, and Metro **>=0.82** (React Native / Expo). A `require("convex-localfirst")`
from a CommonJS module is not supported; use `import`, or `await import(...)` from CJS.

## One package, subpath entries

`npm install convex-localfirst` is the whole install (like `convex` itself).
Everything lives behind subpath exports:

| Entry | What it is |
| --- | --- |
| [`convex-localfirst`](./packages/localfirst/src/react) | The client surface: Convex-compatible `useQuery` / `useMutation`, `useSyncStatus`, drop-in `ConvexProvider` |
| [`convex-localfirst/server`](./packages/localfirst/src/server) | The `lf.table` DSL and the server sync engine (`createSyncFunctions`, `collectTables`) |
| [`convex-localfirst/component`](./packages/localfirst/component) | Mountable Convex component holding the sync bookkeeping: slim replay ledger, change log (cron + opportunistic GC), id map, row versions |
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
