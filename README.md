# Convex Local-First

A DX-first **local-first framework for Convex**: keep writing Convex queries, mutations, and React hooks — the tables you declare local-first read and write optimistically, work offline, and sync in the background, with Convex as the source of truth.

The product goal is simple:

> Users keep writing Convex-style functions and React hooks. Local-first functions read and write locally by default. Convex remains authoritative. Ordinary Convex functions continue to work through fallback.

The intended public API has two modes:

1. **Explicit mode**: the user imports from `@convex-localfirst/react`.
2. **Server DSL mode**: the user defines local-first collections with `createLocalFirst` and `lf.table` in Convex modules.

The packages are published on npm under the `@convex-localfirst/*` scope. The design specs
(DX spec, security model, API contracts, test matrix) live in [`docs/`](./docs); the strict
milestone goal is in [`GOAL.md`](./GOAL.md).

## Documentation

User-facing docs live in [`website/`](./website) — a **Fumadocs** site (Next.js
App Router + MDX + Tailwind, the same stack Better Auth uses). Start there for
installation, the full setup walkthrough, the server DSL, the React hooks, and
the API reference.

```bash
cd website && npm install && npm run dev   # http://localhost:3000  (→ /docs)
```

The `docs/` directory holds the internal design specs (DX spec, security model,
API contracts, test matrix) — not the user-facing docs.

## Milestone 1 status (implemented + verified)

The strict goal lives in [`GOAL.md`](./GOAL.md). All three workspace gates are green:

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test   # 234 tests, all passing
pnpm --filter todo-perfect-dx dev                           # boots, offline-first
```

Live online sync **and a real-browser end-to-end suite** are verified too — see
below. The packages ship correct Node-ESM (relative imports carry `.js`), so the
built `dist` is consumable by a raw `node` ESM `import`, not only by bundlers.

What is built and tested (234 tests across 7 packages):

- **core** (122) — canonical-centric store where the live view is *derived*
  (`canonical + replay(pending)`), so server changes never clobber pending local
  ops (invariant I1); deterministic op ordering (I4); version-guarded
  `applyServerChange` for out-of-order safety (I5); real op status; IndexedDB
  adapter with a v1→v2 migration, blocked-upgrade reporting, transaction
  rollback, namespace isolation, closed-tab recovery, logout-clear;
  Web Locks multi-tab leader election (one tab syncs; auto-failover on close/crash);
  sync with schema-mismatch gating
  and exponential-backoff retry; opt-in convergent **set-field merge** (declare
  `setFields` → concurrent array adds/removes merge instead of clobber) and
  **counter merge** (declare `counterFields` → concurrent numeric increments
  accumulate instead of clobber; provably convergent — addition commutes).
- **react** (13) — Convex-compatible `useQuery`/`useMutation` with **full type
  inference** (args + result inferred from the function reference; no explicit
  generics), correct rules-of-hooks, Convex fallback, the hybrid `await call` /
  `.local` / `.server` contract, `useSyncStatus`/`useQueryMeta`, and an
  offline-first persistence test (create → refresh → still there) over IndexedDB.
- **server** (47) — the `lf.table` DSL (now fully typed: query results and
  closure `args` inferred from your schema) + `createSyncFunctions` (the whole
  server `sync.ts` in ~12 lines) + `collectTables` (derives the sync `tables`
  config straight from your imported `lf.table` modules, so scope/idField/conflict
  have ONE source of truth instead of being restated — and silently drifting — in
  `sync.ts`) + the pure, runtime-agnostic sync engine: byUser isolation,
  client-owner override, byWorkspace membership (read + write use the same
  configured table), schema mismatch (security); row versions live in the change
  log (never on the user row); local-first table handlers refuse direct calls
  instead of returning fake data (G7); opt-in **timestamp-ordered LWW** (declare
  `conflict: "timestampLww"` → a scalar field-write carries the op's logical
  timestamp + clientId tiebreaker, so a *newer* edit wins regardless of arrival
  order — the offline-first fix for arrival-order clobber; backed by a per-field
  write-clock table in the component, with set/counter delta fields exempt and a
  loud refusal if a custom store can't persist the clocks); a full two-engine
  end-to-end **journey** test (offline → reload → sync → 2nd client → idempotent →
  conflict → logout); plus the component matrix: ledger dedupe, append-only change
  log (deletes included), cursor-based incremental pull, id map, field clocks.
- **cli** (28) — `check` statically detects direct `ctx.db.insert/replace`
  writes to local-first tables; `codegen` derives the client manifest from the
  `lf.table` DSL (parses the `value`/`patch`/`id` closures, emits `byUser` **and
  `byWorkspace`/`byProject` pull scopes**, and skips modules it can't import
  standalone) — verified end-to-end through the engine, and the todo example now
  consumes the generated manifest. `dev` runs the codegen+check pipeline. Run
  under a TS loader, e.g. `node --import tsx .../cli/dist/index.js codegen`.
- **yjs** (13) — ship a **Yjs CRDT** (rich text, nested lists) over the local-first
  append-only log: each Yjs binary update is one insert-only row, so concurrent
  rich-text edits MERGE instead of last-writer-wins clobbering (the LWW data-loss
  fix for documents). Framework-agnostic base64 codec + isolated-failure apply +
  snapshot compaction, plus a backend-agnostic React `useCollaborativeDoc` hook
  (you supply the live rows + append/prune; it owns the Y.Doc lifecycle, dedup,
  apply, compaction, and echo-guard). `react`/`yjs` are peer deps. The todo example
  binds it to a BlockNote editor (`doc.getXmlFragment(...)`) in ~10 lines instead of
  ~145 of hand-rolled glue.

The **component** package (`@convex-localfirst/component`) is a real, mountable
Convex component. The example mounts it (`app.use(localfirst)`) and routes *all*
sync bookkeeping — ledger / change log / id map / field clocks — through it via
`components.convexLocalFirst.*`; only the app's own
`todos` table lives in
the app schema. It is validated by Convex codegen, typechecked with `tsc`, and
exercised end-to-end by the live scripts below.

### Live online sync (verified against a real Convex backend)

Stand up a local Convex backend (anonymous — no cloud account needed) and the
full online loop works end-to-end:

```bash
cd examples/todo-perfect-dx
npx convex dev --once --configure new --project todoperfectdx --dev-deployment local
npx convex dev &                       # deploys app + component, keeps backend running
node scripts/live-sync-check.mjs       # protocol: push → pull → idempotent → scope-isolated
node scripts/live-engine-e2e.mjs       # full stack: engine A pushes, engine B pulls (raw node ESM)
```

Both scripts pass against `http://127.0.0.1:3210`:

- `live-sync-check.mjs` — client A pushes an insert (server forces ownership),
  client B pulls it, a re-push is idempotent (ledger dedupe), and another user
  sees nothing (scope isolation).
- `live-engine-e2e.mjs` — two real `LocalFirstEngine` instances syncing through
  `createConvexTransport` + the real `sync.push`/`sync.pull` functions: engine A's
  optimistic insert reaches the server and engine B pulls it.

The example's `convex/sync.ts` composes `serverSync`: the user rows (`todos`,
`issues`) go to `ctx.db`, while every bookkeeping operation is delegated to the
mounted component (`ctx.runMutation`/`ctx.runQuery` into
`components.convexLocalFirst.*`). Real Convex codegen produced both
`convex/_generated` and the component's `_generated`.

### Browser end-to-end (a Linear-lite board, real Chromium)

The example is a small **Linear-lite** board: workspaces → `issues` scoped
`byWorkspace`, so the server's **membership** check (I7) runs live, plus a plain
Convex `workspaces.join`/`memberCount` to exercise the drop-in fallback (I11).
A Playwright suite drives it in a real browser against the live backend:

```bash
cd examples/todo-perfect-dx
npx convex dev &            # live backend
pnpm test:e2e              # 5 browser tests in Chromium
```

It covers: optimistic create + sync, patch/move across columns, IndexedDB
persistence across reload, offline create → reconnect flush, and a second
(fresh-device) client pulling the first's issue. This browser pass surfaced and
fixed several integration bugs unit tests missed — an infinite render loop (the
`api` proxy returns a fresh ref per access, so effects must key on the resolved
function *name*, not the object), a stale `online`/pending indicator (status now
flows on its own notification channel + browser online/offline events), and a
`_version` field that broke real Convex schema validation on patch (row versions
now live in the change log).

### Deferred (GOAL §9 — bounded, not faked)

- **Yjs rich-text now ships** (`@convex-localfirst/yjs`) — the codec + compaction +
  `useCollaborativeDoc` hook are real and tested. Still deferred: an **Automerge**
  adapter (same append-only-log approach as Yjs), and **awareness/presence**
  (cursors are an ephemeral channel, separate from document content).
- A devtools UI; full Next.js plugin (alias strategy is documented); multi-region.

## Quick map

```text
packages/core       local engine, store contract, sync protocol, op log, rebase skeleton
packages/react      Convex-compatible shadow hooks and provider
packages/server     Convex-side DSL for local-first tables, queries, mutations, scopes
packages/component  mountable Convex component: sync ledger / change log / id map / field clocks
packages/cli        init, codegen, check commands
packages/yjs        Yjs CRDT over the local-first log: codec + compaction + useCollaborativeDoc hook
examples/todo-perfect-dx  Linear-lite board (byWorkspace issues) + todos; live scripts + Playwright e2e
```

## The ideal user-facing React code

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
      onClick={() => {
        const call = create({ listId, text: "Ship a better DX" });
        void call.local;
        void call.server;
      }}
    >
      Add {todos.length} todos
    </button>
  );
}
```

## The ideal user-facing Convex code

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

## Non-negotiable product constraints

- Do not run a Convex backend in the browser.
- Do not promise arbitrary Convex functions become local-first automatically.
- Do not synchronize an entire application database by default.
- Convex remains authoritative for validation, auth, idempotency, and canonical ordering.
- Local-first tables require explicit scope declarations.
- Side-effecting actions are server-only by default.
- Writes to local-first tables must pass through the local-first DSL or generated wrappers.
