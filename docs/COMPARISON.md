# How this compares to other local-first stacks

Honest positioning, not marketing. The goal is to be best-in-class on DX and
correctness for **Convex** apps specifically — you keep writing Convex
(`useQuery`/`useMutation`, server modules) and opt tables into local-first.
Where another tool made a different architectural choice that fits its model
better, we say so rather than pretend.

Legend: **lead** = we do this and it's at least as good as anyone; **parity** =
comparable; **different** = a deliberate architectural choice with a real
trade-off; **behind** = they do something we don't (and why).

## Correctness / edge cases (where we deliberately push past mainstream)

These were closed with tests + an adversarial clean-context review (see
`.codex-review/round-log.md`). Most local-first libraries get *some* of these;
the bar here is **all** of them, verified:

- **Clock-skew-proof op ordering** — replay order uses a per-engine monotonic
  timestamp (seeded across reloads from pending ops), so an NTP/manual clock
  step backward can't make an older edit win. (Many LWW stacks order by wall
  clock.) **lead**
- **Race-free multi-tab logout** — `clear()` bumps a durable IndexedDB epoch in
  its own transaction; a concurrent apply in another tab reads the epoch in the
  *same* transaction and aborts, so logout can't be resurrected by an in-flight
  pull. IndexedDB serializes the two transactions across tabs → no window. **lead**
- **Scope-correct local reads** — the client caches every scope a user can see;
  a custom query can't observe another scope's cached rows (engine enforces the
  scope on read, mirroring server I7). **lead**
- **Lossless value fidelity** — synced row values round-trip the full Convex
  value range (bigint, bytes, nested undefined) via Convex's own
  `convexToJson`/`jsonToConvex`, instead of `JSON.stringify` throwing on bigint
  or silently dropping shape. **lead**
- **Atomic, single-transaction server apply** — `applyServerChanges` is one
  IndexedDB readwrite tx (get→version-fold→put, no await between requests), so a
  concurrent apply can't regress a row version even across tabs. **parity/lead**
- **Push-coverage invariant** — a malformed push response that accounts for an op
  in neither `accepted` nor `rejected` leaves it owed instead of silently
  stranding it. **lead**
- **Stale-schema guard** — the server rejects an offline op built under a prior
  schema instead of applying semantically stale data. **parity** (Replicache has
  client-group schema versions; ours is a hard reject + documented migration path)
- **Partial / complete sync state** — `hasMore` drives the drain to completion
  and surfaces `status.partial` (Zero/Electric-style) for a large cold start.
  **parity**
- **Static safety lint** — `convex-localfirst check` does a sound AST taint pass
  flagging `ctx.db.patch/delete/replace` on ids traceable to a local-first table
  (the "don't write the synced table directly" footgun). No mainstream package
  ships this. **lead**

## Per-competitor

### Replicache / Zero (Rocicorp)
- **They lead:** server-authoritative mutators (the mutation re-runs on the
  server, enabling server read-modify-write + authoritative conflict resolution);
  Zero adds query-driven sync and server-side query authorization.
- **Us — different:** our DSL mutations are *blind* (`plan = args → value/patch`,
  no server-side read of current state), so server re-execution would produce the
  identical patch — no benefit. Security (auth/scope/ownership/partition/
  idempotency) **is** server-enforced. Field merge is client-side, **field-level
  LWW**: patches are field-scoped deltas merged field-by-field (client view + server
  `db.patch`), so concurrent edits to *different* fields of a row both survive.
  Same-field collisions resolve last-writer-wins — by **arrival order** under the
  default `fieldLww`, or by the op's **logical timestamp** (+ clientId tiebreaker)
  under opt-in `timestampLww` (a newer edit wins regardless of arrival order, backed
  by server-side per-field write clocks). **Convergent set AND counter merge are
  wired** (opt-in): declare `setFields: ["label_ids"]` → a patch to that array becomes
  an add/remove delta (concurrent adds/removes merge instead of clobber); declare
  `counterFields: [...]` → numeric increments accumulate (addition commutes). Delta
  fields are exempt from the LWW rule. Rich-text CRDTs ship too
  (`@convex-localfirst/yjs` over the append-only log). Full server-authority — opt-in
  baseVersion *conflict detection* / `serverWins` — remains a deliberate non-goal for
  now (timestampLww already gives deterministic convergence); it'd be added only with
  a real driver, never as a silently-no-op policy name.
- **Us — lead:** zero-config for Convex apps (no separate sync server), reactive
  `useQuery`/`useLiveQuery`, the correctness list above.

### ElectricSQL / PowerSync
- **They lead:** Postgres/SQLite-backed shapes, column projection, progressive
  partial replication; PowerSync has broad native (mobile) SDKs + sync rules.
- **Us — different:** sync is **scope-based** (a whole authorized scope is local),
  which is what lets queries be plain typed JS predicates (no query DSL compiled
  to SQL). `hasMore`/`partial` covers large cold starts; per-query partial
  replication is a deliberate non-goal for the scope model.
- **Us — behind:** no SQLite/native storage backend (IndexedDB/web first).

### RxDB
- **They lead:** pluggable storage backends, schema migrations, encryption-at-rest
  + attachments (some premium).
- **Us — different/behind:** encryption-at-rest has architectural tension here —
  WebCrypto is async but the atomic apply tx callbacks are sync, and field-level
  merge needs plaintext field values — so it's a documented roadmap item, not a
  quick win. Storage is IndexedDB (memory store for tests/SSR).

### Triplit / Jazz
- **They lead:** relational querying with row-level permissions, richer conflict
  types.
- **Us — parity/different:** client relations (`one`/`many`/`manyToMany`) resolve
  in-memory over already-authorized local tables; permissions are server-enforced
  at the scope boundary (I7), not per-row ACLs.

### TinyBase
- **They lead:** embeddable mergeable store + many synchronizer media.
- **Us — different:** we're a Convex sync framework, not a standalone store;
  convergent field merge (`setFields` / `counterFields` / `timestampLww`) and Yjs
  rich text (`@convex-localfirst/yjs`) cover the mergeable cases.

### Yjs / Automerge
- **They lead:** rich-text/list CRDTs, editor bindings, presence/awareness.
- **Us — parity (collab) / behind (presence):** Yjs rich-text is integrated in the
  example (docs ride the append-only log as insert-only rows + compaction).
  Presence/awareness is a documented future capability (ephemeral channel).

### Convex's own reactivity
- **Us — lead (for local-first):** optimistic local writes, offline + flush,
  IndexedDB persistence, client rebase (derived view), all on top of Convex's
  reactive queries — `useQuery` stays a drop-in but becomes offline-capable.

## Honest summary

For a **Convex** app that wants local-first with the least ceremony and no
separate infrastructure, this is the strongest option, and it leads the field on
the correctness/edge-case axis above. It is **not** a drop-in replacement for a
SQLite-native mobile stack (PowerSync) or a server-authoritative-mutator model
(Replicache/Zero) — those are different architectures with their own trade-offs,
documented here so the choice is informed.
