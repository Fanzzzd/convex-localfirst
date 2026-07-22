---
"convex-localfirst": minor
---

Product-grade release (pre-1.0 breaking): authorization rewrite, new capabilities, and packaging hardening.

**Breaking**

- Authorization is now `access = { member, read, write }`, replacing `isMember` and `visibility`. `member` returns a role (any value) or null/undefined to deny; `read` filters rows within a scope; `write` authorizes every accepted op including inserts (fixes insert-time authz gaps). Omitted `read`/`write` default to allowing members. `byUser` tables stay owner-only.
- `useCollaborativeDoc` now returns `{ doc, status }` instead of a bare `Y.Doc`. It filters update rows to `docId` internally and drives durable, retried appends with server-confirmed compaction.
- The server-authoritative user id now defaults to `identity.tokenIdentifier` (was `identity.subject`), preventing cross-provider `sub` collisions from granting cross-user access. Override via `getUserId(ctx)`.

**New**

- `onWrite` — a transactional, exactly-once hook (client push and `serverWriter`; skipped on ledger replay) for activities, notifications, and denormalized counters.
- `gc` — `createSyncFunctions` returns an internal mutation to prune expired ledger and change-log rows; wire it with `crons.interval` (appends also do an opportunistic prune).
- `useSearch` + `searchFields` — incremental, memory-resident local full-text search (search-as-you-type) over declared fields.
- Fractional ranking helpers (`rankBetween`, `rankCompare`, `isValidRank`, `rebalance`) for kanban / manual ordering.
- Offline-capable attachments pipeline: `createAttachmentFunctions` (server) plus `useCreateAttachment` / `useAttachmentUpload` (client) — blob persisted locally first, leader-tab background upload with retries, server-stamped `storageId`.
- Incremental query engine with local secondary indexes: subscribed queries update by single-row deltas instead of re-scanning; indexed equality/range lookups and pre-sorted iteration.
- `useSyncRecovery` — surfaces rejected writes, operations stranded in older schema-version namespaces, and failed attachment uploads for export/migrate/discard.
- Production Yjs provider plus a `convex-localfirst/yjs/awareness` subpath (`useDocAwareness`) for cursor/selection presence, keeping the main `yjs` entry free of the optional `y-protocols` peer.

**Security fixes**

Closes a set of server-side classes: writable-field/function allowlists derived from declared mutation specs (no arbitrary `v.any()` field writes), insert-time authorization, row visibility evaluated against current state on incremental pulls, `serverWriter` projected to synced fields only, retired/deconfigured tables dropped from the shared change log, atomic op commit vs. ledger status, schema-version-checked ledger replay, and pull scope dedupe/cap/global budget. Plus client correctness fixes for stale-pull/logout epoch fences, delete-ack tombstone retention, and push timeouts.

**Packaging**

- The Convex component now ships compiled JS + `.d.ts` under `dist/component`, with the raw TypeScript kept behind the `@convex-dev/component-source` export condition (used by the Convex bundler's live-sources mode).
- `convex` peer range corrected to `>=1.16.1` (components requirement; tested against `^1.41`).
- CLI lazy-loads the `check` command's TypeScript dependency, so `init`/`help` work without the optional `typescript` peer installed, and `check` prints a clear install instruction if it is missing.
- `useQuery` / `useMutation` now mirror Convex's arg arity (`OptionalRestArgs`): queries/mutations with required args require them; empty-args ones may be omitted.
- ESM-only (documented support matrix: Node >=18 ESM, Next.js app router, Vite, Metro >=0.82).
- LICENSE and CHANGELOG are now in the published tarball; source maps, declaration maps, and `src/` ship for go-to-definition.
