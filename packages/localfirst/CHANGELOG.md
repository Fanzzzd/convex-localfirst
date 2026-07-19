# convex-localfirst

## 0.3.1

### Patch Changes

- 9475e93: Ship the README with the package (the npm page was blank after the one-package consolidation).

## 0.3.0

### Minor Changes

- 7da6dfa: One package. `convex-localfirst` is now the only published package — the six
  `@convex-localfirst/*` scoped packages are legacy (frozen at 0.2.1) and all
  their code ships here behind subpath exports, matching how `convex` itself is
  structured:

  - `convex-localfirst` / `convex-localfirst/react` — the client surface
  - `convex-localfirst/server` — the `lf.table` DSL + sync engine
  - `convex-localfirst/component` — the mountable Convex component
  - `convex-localfirst/core` (+ `/core/internal`) — the engine, stores, transport
  - `convex-localfirst/yjs` — document mode (`yjs` is an optional peer)
  - `npx convex-localfirst` — the CLI (`init`, `check`) is now the package bin

  Migration: replace every `@convex-localfirst/<sub>` import with
  `convex-localfirst/<sub>` and drop the scoped packages from package.json —
  `npm install convex-localfirst` is the whole install. `react`, `yjs`, and
  `typescript` are optional peers; nothing else changed.

## 0.2.1

### Patch Changes

- 410d35c: Releases are now published via npm trusted publishing (GitHub Actions OIDC) — no npm tokens involved. No library changes.
  - @convex-localfirst/core@0.2.1
  - @convex-localfirst/react@0.2.1
  - @convex-localfirst/server@0.2.1

## 0.2.0

### Minor Changes

- bd9a415: One-line install, one-number schema migrations, and hardening.

  - **`convex-localfirst` meta package.** `npm install convex-localfirst` is the
    whole install: the client surface at the root import, the DSL at
    `convex-localfirst/server`, and the mountable component (vendored at build
    time) at `convex-localfirst/component/convex.config.js`. The scoped
    `@convex-localfirst/*` packages remain published individually.
  - **Schema migrations are one number.** Declare
    `createLocalFirst({ schemaVersion: 2 })` and it flows everywhere: the server
    sync gate (via `collectTables`) rejects stale clients, and each upgraded
    client's default IndexedDB store is namespaced by the version — a clean local
    reset + full resync instead of a mismatch-blocked dead end.
  - **`viaIds` relation.** `rel.viaIds("labels", "label_ids")` joins an id-array
    field straight to its target rows — the natural pair for a `setFields`
    id-array, no join table needed.
  - **Component hardening.** All `(table, localId)` lookups are deterministic
    under legacy duplicate rows (first-by-index) instead of wedging every
    push/pull with a `.unique()` crash; conflicting id-map claims stay
    fail-closed rejected.

- 293c1c3: Presence, and byUser queries that run everywhere.

  - **`usePresence` — live "who's here".** Heartbeats into the mounted
    component's new ephemeral presence table, TTL-expired reads, delivery over
    plain Convex reactivity (no polling). Scopes are sync scopes: the server
    enforces the same membership rules as pull, failing SOFT on both sides so a
    beat racing a just-sent workspace join converges on its own. Export
    `presence` / `presenceList` from `createSyncFunctions` and render
    `usePresence({ workspace }, { name, color })`.
  - **byUser queries execute server-side.** The same `todos.query` declaration
    the local engine interprets now runs for real in SSR loaders, scripts,
    `npx convex run`, and plain Convex clients — identity from `ctx.auth`, the
    declared index walked with the key closure, failing closed unless the walk is
    provably confined to the caller. byWorkspace/byProject queries and all writes
    still refuse (G7).

- f9f162e: Snapshot bootstrap, change-log GC, derived mutation specs, serverWriter — and the conflict-policy option is gone.

  - **Snapshot bootstrap.** A client with no cursor for a scope now loads the
    _current rows_ (paged, driven by the new per-row version authority) instead of
    replaying the whole change history. Interrupted bootstraps never lose data:
    rows are evicted only after the snapshot completes, and only rows the snapshot
    didn't deliver.
  - **Change-log GC.** Old change entries are pruned opportunistically during
    appends (`changeRetentionMs`, default 30 days, `Infinity` disables). Row
    versions live in a dedicated component table that survives GC, so idempotency,
    version folding, and bootstrap all stay correct with a pruned log.
  - **Derived mutation specs.** `todos.insert()` / `todos.patch()` /
    `todos.remove()` with no arguments derive their validators and behavior from
    the table's `shape` — and `timestamps: true` auto-stamps
    `createdAt`/`updatedAt`. A full CRUD surface is now three lines.
  - **`serverWriter`.** A trusted server-side write path through the change log
    for activity feeds, importers, and crons — server-originated rows sync to
    clients like any other change.
  - **Row-level visibility.** A per-table `visibility` hook filters rows _within_
    an authorized scope (Plane-style guest rules): bootstrap rows are filtered, a
    row entering visibility arrives as a full-row upsert, one leaving arrives as a
    delete, and writes obey "can't see → can't touch".
  - **Server-minted fields.** A per-table `serverStamp` hook merges
    server-computed fields into every insert (client push and `serverWriter`) —
    atomic sequence numbers (`PROJ-123`) inside the push transaction.
  - **Membership revocation.** Pulls report `deniedScopes`; the client evicts the
    scope's rows and forgets its cursor.
  - **Cheaper reactivity.** The reactive watch subscribes with a content-free
    `doorbell` flag (reads at most one change per scope) instead of a full pull.
  - **Server-only fields never leak.** Bootstrap snapshots project rows to the
    table's declared sync surface (`syncedFields`), so `extra` columns stay
    server-side.
  - **Removed: per-field conflict policies.** `conflict: "timestampLww"` /
    `"fieldLww"` and the fieldClocks table are gone — arrival-order LWW plus the
    convergent `setFields`/`counterFields` merges cover the real cases with far
    less machinery. Old clients that still send `timestamp` on ops keep working
    (the field is accepted and ignored).

### Patch Changes

- Updated dependencies [bd9a415]
- Updated dependencies [293c1c3]
- Updated dependencies [216591c]
- Updated dependencies [f9f162e]
  - @convex-localfirst/core@0.2.0
  - @convex-localfirst/react@0.2.0
  - @convex-localfirst/server@0.2.0
