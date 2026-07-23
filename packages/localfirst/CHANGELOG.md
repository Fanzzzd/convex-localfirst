# convex-localfirst

## 0.4.0

### Minor Changes

- 179587c: 0.4.0 — the API a Plane-class app deserves. A large new client surface for building complex apps greenfield, on top of the untouched Convex-compatible adoption layer, plus an authorization rewrite, a server-side security pass, and packaging hardening. Pre-1.0, so breaking. Full before/after in [MIGRATION.md](./MIGRATION.md).

  **Breaking**

  - Authorization is now `access = { member, read, write }`, replacing `isMember` and `visibility`. `member` returns a role (any value) or null/undefined to deny; `read` filters rows within a scope; `write` authorizes every accepted op including inserts (fixes insert-time authz gaps). Omitted `read`/`write` default to allowing members; `byUser` tables stay owner-only. _Migrate:_ move the two callbacks into `access` (MIGRATION §1).
  - `serverStamp` entries are now `{ fields, stamp }` (was a bare function). `fields` lists the server-minted field names, rejected from client writes before the hook runs. _Migrate:_ wrap the function (MIGRATION §2).
  - `useCollaborativeDoc` returns `{ doc, status }` instead of a bare `Y.Doc`. It filters update rows to `docId` internally and drives durable, retried appends with server-confirmed compaction; `append`/`prune` now take the whole `useMutation` call, not `.local`. _Migrate:_ destructure `{ doc }`, drop `.local` (MIGRATION §3).
  - The server-authoritative user id now defaults to `identity.tokenIdentifier` (was `identity.subject`), preventing cross-provider `sub` collisions from granting cross-user access. **Scope keys derive from it, so existing user ids change.** _Migrate:_ keep old ids with `getUserId: (ctx) => …subject`, or re-key data to `tokenIdentifier` (MIGRATION §4 — read before deploying).
  - `convex` peer range is now `>=1.16.1` (component requirement; tested against `^1.41`).
  - `useQuery` / `useMutation` mirror Convex's `OptionalRestArgs`: required-args functions require the args parameter; empty-args ones may omit it.

  **New — typed client & queries**

  - `createLocalDb(modules)` — a fully-typed `db` root derived from the same imported `lf.table` modules: row types, scope keys, filter/order fields, and relation names all flow from the schema. `collection()` remains the untyped escape hatch.
  - Declared relations on `lf.table({ relations })` — `lf.one` / `lf.many({ via })` / `lf.backref` — queried by name with `.with("state", "labels")`, incrementally resolved and typed.
  - Serializable filter AST — `.filter({ … })` with eq sugar, `in`/`nin`/`lt`/`lte`/`gt`/`gte`/`ne`, set-field `contains`/`overlaps`, and `OR`/`AND`/`NOT`; index-plannable and persistable as saved views (`serializeFilter` / `parseFilter` / `matchesFilter`). `.where(fn)` stays as the closure escape hatch.
  - Incrementally-maintained grouping and counts — `.groupBy(field)` makes `useLiveQuery` return a live `Map`; `useLiveCounts(...)` returns per-group counts with no row materialization.
  - Incremental query engine with local secondary indexes: subscribed queries update by single-row deltas instead of re-scanning; indexed equality/range lookups and pre-sorted iteration.
  - Fractional ranking helpers (`rankBetween`, `rankCompare`, `isValidRank`, `rebalance`) for kanban / manual ordering.
  - `useSearch` + `searchFields` — incremental, memory-resident local full-text search (search-as-you-type).

  **New — writes, permissions & polish**

  - `useBatch()` — atomic write groups: several local-first mutations apply optimistically in order, push together, and commit or reject as one unit (rejection reverts the group and surfaces once in `useSyncRecovery().failedGroups`).
  - Permission-aware UI — `useRole` (the synced role per scope), `useCan` (client mirror of `access.write`, declared once as `clientCan` on `lf.table`), advisory only; the server stays authoritative.
  - `useUndo` — scope-aware undo/redo emitting ordinary local-first mutations (a batch group undoes as one unit); undo-of-delete resurrection re-mints `serverFields`.
  - `useScopeStatus` — per-scope `{ hydrated, partial, syncing, denied }` so first paint can skeleton instead of flashing empty.
  - `useSyncRecovery` — surfaces rejected writes, ops stranded in older schema-version namespaces, failed attachment uploads, and rejected batches for export/migrate/discard/retry.
  - Offline-capable attachments — `createAttachmentFunctions` (server) plus `useCreateAttachment` / `useAttachmentUpload` (client): blob persisted locally first, leader-tab background upload with retries, server-stamped `storageId`.
  - Production Yjs provider plus a `convex-localfirst/yjs/awareness` subpath (`useDocAwareness`) for cursor/selection presence, keeping the main `yjs` entry free of the optional `y-protocols` peer.
  - `usePresence` — ephemeral live presence (avatars, "N online", typing) over the mounted component, access-gated like pull.
  - `onWrite` — a transactional, exactly-once hook (client push and `serverWriter`; skipped on ledger replay) for activities, notifications, and denormalized counters.
  - `gc` — `createSyncFunctions` returns an internal mutation to prune expired ledger and change-log rows; wire it with `crons.interval` (appends also prune opportunistically).

  **New — trust & tooling**

  - `convex-localfirst/testing` — `createTestHarness` packages the real engine + a fake in-process server (real `handlePush`/`handlePull`), a deterministic clock, and controllable connectivity: test "offline edit → conflict → recovery" in ~10 lines.
  - `convex-localfirst/devtools` — `<LocalFirstDevtools />`, a dev-only, zero-dependency inspector (outbox, per-scope sync/role, live queries with index explain, storage, simulate-offline toggle).

  **Security fixes**

  Closes a set of server-side classes: writable-field/function allowlists derived from declared mutation specs (no arbitrary `v.any()` field writes), insert-time authorization, row visibility evaluated against current state on incremental pulls, `serverWriter` projected to synced fields only, retired/deconfigured tables dropped from the shared change log, atomic op commit vs. ledger status, schema-version-checked ledger replay, and pull scope dedupe/cap/global budget. Plus client correctness fixes for stale-pull/logout epoch fences, delete-ack tombstone retention, and push timeouts.

  **Packaging**

  - The Convex component now ships compiled JS + `.d.ts` under `dist/component`, with the raw TypeScript behind the `@convex-dev/component-source` export condition (the Convex bundler's live-sources mode).
  - CLI lazy-loads the `check` command's TypeScript dependency, so `init`/`help` work without the optional `typescript` peer, and `check` prints a clear install instruction if it is missing.
  - ESM-only (documented support matrix: Node >=18 ESM, Next.js app router, Vite, Metro >=0.82).
  - LICENSE and CHANGELOG ship in the published tarball; source maps, declaration maps, and `src/` ship for go-to-definition.

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
