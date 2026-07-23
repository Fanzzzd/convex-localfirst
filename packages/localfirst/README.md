# Convex Local-First

Build a Linear-class app on [Convex](https://convex.dev) — a typed local store,
declared relations, live grouped queries, atomic write groups, and drag-and-drop
ordering — where every read and write is **optimistic, offline-capable, and
reactive across clients**, with Convex as the source of truth. Already have a
Convex app? The Convex-compatible `useQuery` / `useMutation` layer is a drop-in
adoption wedge — see [below](#already-on-convex-the-drop-in-layer).

```bash
npm install convex-localfirst
```

ESM-only. Peers: `convex >=1.16.1`, `react >=18` (optional). No codegen step.

## Declare a table once — shape, scope, relations

A table's declaration is its single source of truth: the Convex schema derives
from it (`.table()`), the server sync config derives from it (`collectTables`),
and the client runs the same declaration locally (the provider's `modules`).

```ts
// convex/issues.ts
import { v } from "convex/values";
import { lf } from "./localfirst";

export const issues = lf.table("issues", {
  shape: {
    workspace_id: v.string(),
    title: v.string(),
    description_html: v.string(),
    state_id: v.string(),
    priority: v.string(),
    assignee_ids: v.array(v.string()),
    label_ids: v.array(v.string()),
    parent_id: v.optional(v.string()),
    created_by: v.string(),
    sort_order: v.string()               // a fractional rank (see rankBetween)
  },
  scope: lf.byWorkspace({ workspaceIdField: "workspace_id", membershipTable: "members" }),
  timestamps: true,                      // createdAt/updatedAt, stamped automatically
  setFields: ["assignee_ids", "label_ids"], // convergent set-merge, never clobbers
  searchFields: ["title", "description_html"],
  indexes: { byState: ["workspace_id", "state_id", "sort_order"] },
  relations: {
    state:     lf.one("states", "state_id"),        // FK -> states._id
    labels:    lf.many("labels", { via: "label_ids" }), // set-field id array
    assignees: lf.many("members", { via: "assignee_ids" }),
    parent:    lf.one("issues", "parent_id"),
    subIssues: lf.backref("issues", "parent_id"),   // reverse FK
    comments:  lf.backref("comments", "issue_id")
  }
});

// Args derive from the shape: insert() takes the non-stamped fields, patch()
// takes { id } + any subset, remove() takes { id }.
export const create = issues.insert();
export const update = issues.patch();
export const remove = issues.remove();
```

## A typed client root — kill the strings

Derive a fully-typed `db` from the same imported modules. Row types, scope keys,
filter/order fields, and relation names all flow from the schema — end to end,
no client generics, no restated shapes.

```ts
// src/lib/db.ts
import { createLocalDb } from "convex-localfirst";
import * as issues from "../../convex/issues";
import * as states from "../../convex/states";
import * as labels from "../../convex/labels";
import * as members from "../../convex/members";
import * as comments from "../../convex/comments";

export const db = createLocalDb({ issues, states, labels, members, comments });
```

## The board is the app — live groups, joins, ranking

```tsx
import {
  useLiveQuery, useLiveCounts, useMutation, useBatch, rankBetween
} from "convex-localfirst";
import { api } from "../convex/_generated/api";
import { db } from "./lib/db";

function Board({ workspaceId }: { workspaceId: string }) {
  // Map<state_id, Issue[]> — each column sorted by fractional rank, with `state`
  // and `labels` joined in. Reads straight off the local store; re-renders on
  // every local change; pushed live from other clients. Grouping is incremental —
  // a moved card only touches two columns.
  const columns = useLiveQuery(
    db.issues
      .scope({ workspace_id: workspaceId })
      .with("state", "labels")
      .order("sort_order")
      .groupBy("state_id")
  );
  // Record<state_id, number> — no rows materialized.
  const counts = useLiveCounts(db.issues.scope({ workspace_id: workspaceId }).groupBy("state_id"));

  const update = useMutation(api.issues.update);
  // Drag-and-drop: a stable rank between two neighbours, no renumbering.
  const move = (id: string, state_id: string, prev: Issue | null, next: Issue | null) =>
    update({ id, state_id, sort_order: rankBetween(prev?.sort_order ?? null, next?.sort_order ?? null) });

  // ...render columns from the Map, badges from counts...
}
```

## Atomic write groups

Create an issue **and** its first comment as one offline-durable unit that lands
or rejects together. Read a fresh insert's id synchronously from the call's `.id`.

```tsx
const create = useMutation(api.issues.create);
const comment = useMutation(api.comments.create);
const batch = useBatch();

await batch(() => {
  const { id } = create({ workspace_id, title, state_id, sort_order, /* … */ });
  comment({ workspace_id, issue_id: id, body: "kickoff" });
}).local;
// All-or-nothing on the server; a rejected group reverts as one unit and
// surfaces once in useSyncRecovery().failedGroups.
```

## Server setup — one file, still authoritative

The server stays the security boundary: every pushed op is validated against
auth, scope/membership, row ownership, schema version, and an idempotency ledger.

```ts
// convex/sync.ts
import { collectTables, createSyncFunctions } from "convex-localfirst/server";
import { components } from "./_generated/api";
import { mutation, internalMutation, query } from "./_generated/server";
import * as issues from "./issues";
// ...import the rest...

export const { push, pull, presence, presenceList, gc } = createSyncFunctions({
  component: components.convexLocalFirst,
  mutation, internalMutation, query,
  tables: collectTables({ issues, states, labels, members, comments }),
  access: {
    // Called once per requested scope; return a role (any value) or null to deny.
    member: (ctx, { userId, scopeValue }) => roleForWorkspace(ctx, userId, scopeValue),
    // Optional per-row filters within a scope the caller already belongs to.
    read:  (_ctx, { role, userId, row }) => role !== "guest" || row.created_by === userId,
    write: (_ctx, { role, userId, action, before, proposed }) =>
      role === "admin" ||
      (action === "insert" ? proposed?.created_by === userId : before?.created_by === userId)
  },
  // Transactional, exactly-once on first acceptance (ledger replay skips it).
  onWrite: (ctx, write) => recordActivity(ctx, write)
});
```

```ts
// convex/schema.ts — derived, never restated
export default defineSchema({ issues: issues.table(), /* … */ });

// convex/crons.ts — prune expired ledger + change-log rows (appends also prune opportunistically)
crons.interval("localfirst gc", { hours: 1 }, internal.sync.gc, {});
```

`byUser` tables stay owner-only and never call `access.member`. Workspace/project
scopes require it; `read`/`write` default to allowing members. Identity comes from
`ctx.auth` (`identity.tokenIdentifier` by default; override with `getUserId(ctx)`).

## More building blocks

**Filters & saved views.** A serializable, typed filter AST — persist a view as
`JSON.stringify(filter)`, replay it later:

```ts
db.issues.scope({ workspace_id }).filter({
  state_id: { in: stateIds },
  priority: "urgent",                 // eq sugar
  assignee_ids: { contains: userId }, // set-field membership
  OR: [{ is_draft: false }, { created_by: userId }]
});
// serializeFilter(spec) -> string; parseFilter<Shape>(json) -> { ok, value | error }
// .where(row => …) stays as the closure escape hatch (post-index, not serializable).
```

**Full-text search.** Declare `searchFields`, then search-as-you-type (incremental
in-memory index, no debounce):

```tsx
const { results, total } = useSearch("issues", query, { scope: { workspace_id }, limit: 20 });
```

**Offline attachments.** The blob persists locally first (creating offline
succeeds), then the leader tab uploads to Convex file storage with retries; the
server stamps `storageId` on the synced row.

```ts
// server: authorized by the SAME access config
export const { getUploadUrl, finalize } = createAttachmentFunctions({
  component: components.convexLocalFirst, mutation, query,
  tables, access, table: "attachments",
  generateUploadUrl: (ctx) => ctx.storage.generateUploadUrl()
});
```
```tsx
// client
const create = useCreateAttachment(api.attachments.create);
const { localId } = await create({ metadata: { issue_id, name, size, mime_type }, blob });
const { state, progress } = useAttachmentUpload(localId); // queued|uploading|done|failed
```

**Collaborative docs (Yjs).** `useCollaborativeDoc` returns `{ doc, status }` — a
live `Y.Doc` plus durability status — syncing through a durable append-only log
with server-confirmed compaction. Cursor/selection awareness lives at
`convex-localfirst/yjs/awareness` (so the main entry never pulls the optional
`y-protocols` peer):

```tsx
import { useCollaborativeDoc } from "convex-localfirst/yjs";
import { useDocAwareness } from "convex-localfirst/yjs/awareness";

const { doc, status } = useCollaborativeDoc({
  docId, updates, idField: "id",
  append: (update) => appendRow({ workspace, doc: docId, update }),
  prune: (id) => pruneRow({ id })
});
const { awareness } = useDocAwareness(doc, { docId, scope: { workspace }, state: { user } });
```

**Permission-aware UI.** Ship the role to the client and mirror `write` rules
(declared once on the table as `clientCan`, isomorphic like `shape`) — advisory,
the server stays authoritative:

```tsx
const role = useRole<Role>({ workspace_id });        // Role | null (denied) | undefined (syncing)
const can  = useCan<typeof modules>();               // mirrors access.write client-side
<Button disabled={!can.patch("issues", issue, { title })} />
```

**Undo/redo.** Every local op has an inverse; undo emits ordinary mutations that
sync like any op (a batch group undoes as one unit):

```tsx
const { undo, redo, canUndo, canRedo } = useUndo({ workspace_id });
```

**Offline & recovery.** `useScopeStatus` gives per-scope hydration so first paint
skeletons correctly; `useSyncRecovery` surfaces durable writes needing attention:

```tsx
const { hydrated, partial } = useScopeStatus({ workspace_id });
const { rejectedOperations, olderSchemaOperations, failedAttachments, failedGroups } = useSyncRecovery();
```

**Devtools.** Mount `<LocalFirstDevtools />` (dev-only) for outbox/op states,
per-scope sync + role, live queries with index explain, storage usage, and a
simulate-offline toggle:

```tsx
import { LocalFirstDevtools } from "convex-localfirst/devtools";
{import.meta.env.DEV && <LocalFirstDevtools />}
```

**Testing.** `createTestHarness` packages the real engine + a fake in-process
server, so you can test "offline edit → conflict → recovery" in ~10 lines:

```ts
import { createTestHarness } from "convex-localfirst/testing";

const t = createTestHarness({ modules: { issues, states } });
t.server.seed("issues", [/* … */]);
const { result } = renderHook(() => useLiveQuery(t.db.issues.scope({ workspace_id })), { wrapper: t.Provider });
t.goOffline(); /* …mutate… */ t.goOnline(); await t.settled();
```

## Already on Convex? The drop-in layer

The v3 Convex-compatible surface is untouched — the adoption wedge for an existing
app. `useQuery` / `useMutation` keep Convex's exact signatures and full inference;
declared local-first tables resolve locally, everything else falls through to the
official Convex client.

```tsx
import { useQuery, useMutation, useSyncStatus } from "convex-localfirst";
import { api } from "../convex/_generated/api";

export function Todos({ listId }: { listId: string }) {
  const todos = useQuery(api.todos.list, { listId }, { initial: [] });
  const create = useMutation(api.todos.create);
  const sync = useSyncStatus();
  return (
    <button disabled={sync.blockedBySchemaMismatch} onClick={() => create({ listId, text: "Ship it" })}>
      Add {todos.length} todos
    </button>
  );
}
```

Wire it with the drop-in provider — the client imports the same modules;
store/transport/ids default:

```tsx
import * as todos from "../convex/todos";
<ConvexProvider client={convex} localFirst={{ modules: { todos, issues }, userId }}>
```

Migrating from 0.3.x? See the [migration guide](./MIGRATION.md) — every breaking
change with before/after code, plus the old→new mapping for the v4 surface.

## Module format

This package is **ESM-only** — no CommonJS (`require`) build. It targets Node
**>=18** with ESM (`"type": "module"` or `.mjs`), Next.js (app router), Vite, and
Metro **>=0.82** (React Native / Expo). `require("convex-localfirst")` from CJS is
not supported; use `import`, or `await import(...)`.

## One package, subpath entries

`npm install convex-localfirst` is the whole install (like `convex` itself).

| Entry | What it is |
| --- | --- |
| [`convex-localfirst`](./packages/localfirst/src/react) | The client surface: typed `db` + `useLiveQuery`/`useLiveCounts`, `useBatch`, `useRole`/`useCan`, `useUndo`, `useSearch`, ranking, the Convex-compatible `useQuery`/`useMutation`, drop-in `ConvexProvider` |
| [`convex-localfirst/server`](./packages/localfirst/src/server) | The `lf.table` DSL and the server sync engine (`createSyncFunctions`, `collectTables`, `createAttachmentFunctions`) |
| [`convex-localfirst/component`](./packages/localfirst/component) | Mountable Convex component: replay ledger, change log (cron + opportunistic GC), id map, row versions |
| [`convex-localfirst/core`](./packages/localfirst/src/core) | Local engine: derived live view, IndexedDB store, multi-tab leader election, sync protocol, convergent merges |
| [`convex-localfirst/yjs`](./packages/localfirst/src/yjs) | Yjs CRDT (rich text) over the local-first log + `useCollaborativeDoc` (optional `yjs` peer); `…/yjs/awareness` for cursors (optional `y-protocols` peer) |
| [`convex-localfirst/testing`](./packages/localfirst/src/testing) | `createTestHarness` — the real engine + a fake in-process server, deterministic clock, controllable connectivity |
| [`convex-localfirst/devtools`](./packages/localfirst/src/devtools) | `<LocalFirstDevtools />` — dev-only inspector (zero deps beyond React) |
| [`npx convex-localfirst`](./packages/localfirst/src/cli) | The CLI: `init` (scaffold a starter), `check` (no direct writes to local-first tables) |

(The pre-0.3 `@convex-localfirst/*` scoped packages are legacy — frozen at 0.2.1;
all future releases ship only `convex-localfirst`.)

## Documentation

The docs site lives in [`website/`](./website) — installation, the server DSL,
the typed client, queries and writes, permissions, sync internals, tooling, and
the full API reference.

```bash
cd website && npm install && npm run dev   # http://localhost:3000
```

## Examples

- [`examples/todo-perfect-dx`](./examples/todo-perfect-dx) — a Linear-lite board
  (`byWorkspace` issues + `byUser` todos) with the mounted component, a Playwright
  browser suite, and live-sync scripts against a real Convex backend.
- [`examples/plane`](./examples/plane) — a larger project-tracker example.

## Development

```bash
pnpm install
pnpm run ci      # build + typecheck + test all packages
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the changeset/release flow.

## Design constraints

- No Convex backend in the browser; Convex remains authoritative for validation,
  auth, idempotency, and canonical ordering.
- Local-first is opt-in per table, with an explicit sync scope — never the whole
  database by default.
- Writes to local-first tables go through the DSL; the CLI's `check` catches
  direct `ctx.db` writes.
- Side-effecting actions stay server-only.

## License

MIT
