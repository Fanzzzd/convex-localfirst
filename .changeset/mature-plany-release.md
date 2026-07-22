---
"convex-localfirst": minor
---

0.4.0 — the API a Plane-class app deserves. A large new client surface for building complex apps greenfield, on top of the untouched Convex-compatible adoption layer, plus an authorization rewrite, a server-side security pass, and packaging hardening. Pre-1.0, so breaking. Full before/after in [MIGRATION.md](./MIGRATION.md).

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
