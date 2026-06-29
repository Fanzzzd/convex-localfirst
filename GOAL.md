# GOAL — Convex Local-First (Milestone 1)

Strict, binary goal for the implementation agent loop. Every item is pass/fail.
No weasel words. If a gate is not green, the milestone is **not** done — partial
credit does not exist. Demo magic without a safety check is a **reject**, not a
feature.

> One sentence: a Convex user installs a package, changes imports or adds a Vite
> plugin, declares which tables are local-first, and their app becomes
> offline-by-default **without learning a new sync service and without losing a
> single correctness guarantee**.

---

## 0. Starting line (current scaffold is ~10% real — do not trust it)

These are confirmed stubs/bugs in the extracted scaffold. The loop must treat
each as a known defect, not as working code:

- `packages/core/src/rebase.ts` exists but **is never imported**. `engine.ts`
  and `memoryStore.applyServerChange` overwrite the live row with canonical
  server data, **discarding pending local ops on every pull**. This is the
  spec's #1 forbidden pattern.
- `engine.operationStatus()` is hardcoded to `{ status: "pending" }` — status is
  fake.
- `packages/react/src/index.tsx` `useQuery` calls `ConvexReact.useQuery`
  conditionally and then calls more hooks after — **rules-of-hooks violation**;
  it also always uses `MemoryLocalStore` (IndexedDB never wired).
- `packages/server/src/index.ts` handlers return
  `{ __localFirstServerPlaceholder: true }` / `{ value }` — they **do not write
  to the db, enforce no scope, check no membership**.
- `packages/cli` `check` and `dev` are `console.log` no-ops. `check` being a
  no-op is a **security hole** (it must catch direct writes to LF tables).
- `useQueryMeta` returns a constant string. One test exists against a
  multi-section test matrix.

The loop does not get to declare these "done" by leaving them as-is.

---

## 1. Non-negotiable invariants (must hold at every commit)

A commit that breaks any invariant must not land. These are not features; they
are properties.

**Correctness**
- **I1. Rebase is the only apply path.** Every server change (push response +
  pull) is applied by: update canonical snapshot → replay pending local ops in
  deterministic order → recompute view. Direct mutation of the live view from a
  server change is forbidden. `rebaseAndReplay` (or its successor) is on the hot
  path and covered by tests. Grep proof: no code writes server data straight to
  the live row map.
- **I2. Idempotency.** Re-pushing the same `opId` never double-applies, never
  duplicates a row, never re-runs a side effect. Holds on client (outbox) and
  server (ledger), proven by test.
- **I3. Durability before ack.** `call.local` resolves only after the row **and**
  the outbox entry are durably written. After a simulated reload, pending ops
  and their local effects survive.
- **I4. Deterministic ordering.** Pending ops replay in a total order
  (createdAt, then opId tiebreak) that is identical across reloads and tabs.
  Out-of-order server responses cannot corrupt state (test required).
- **I5. Monotonic cursors.** A scope cursor never moves backward. A tombstone
  stays visible until every relevant cursor is past it.

**Security (client never decides authorization)**
- **I6. Every LF table has a sync scope.** No scope = build error. `sync all` is
  rejected in production mode.
- **I7. Server enforces scope on pull and ownership/membership/args on push.**
  `byUser` cannot read another user's rows; `byWorkspace`/`byProject` verifies
  membership server-side. Client-supplied owner/scope id is ignored or rejected.
- **I8. Side effects are server-only by default.** A server-only mutation never
  enters the outbox and never runs optimistically.
- **I9. Auth boundary.** Logout clears or namespaces local data; one user's data
  is never readable by the next session.
- **I10. No silent LF-table writes.** Arbitrary Convex mutations cannot write LF
  tables without the generated wrappers, and `convex-localfirst check` fails the
  build when they try.

**DX (must not regress Convex)**
- **I11. Drop-in.** `useQuery(api.m.f, args)` / `useMutation(api.m.f)` work
  unchanged. Non-LF functions fall through to the official Convex client with
  identical behavior. The wrapper never breaks existing Convex code.
- **I12. Hybrid promise contract.** `await call` resolves to the **server**
  result (Convex-identical). `call.local` and `call.server` are both awaitable;
  offline, `call.server` waits until pushed or rejects on server rejection.
- **I13. No new vocabulary.** Public API is exactly the list in §6. Anything else
  is internal/generated.

---

## 2. Definition of Done — the milestone gate

Done = **all** of the following pass on a clean checkout, in order, with zero
manual steps:

```bash
pnpm install
pnpm build      # every package compiles, tsc strict, zero errors
pnpm test       # full matrix green (§4), zero skips, zero .only
pnpm --filter todo-perfect-dx dev   # example boots
```

Then the end-to-end journey passes **as an automated test** (not just by hand):

1. Create a todo while offline → appears in the list immediately.
2. Reload the page → the todo is still there, still pending.
3. Go online → it pushes to Convex; status flips to acked.
4. Second client → pulls the todo.
5. Re-push the same op → **no duplicate** (idempotent).
6. Force a conflict → a **clear, queryable conflict status** appears (no silent
   data loss, no crash).
7. Call an ordinary Convex function → works via fallback.
8. Logout → local namespace cleared/isolated.

Each of steps 1–8 maps to at least one named test in §4. "It worked when I
clicked around" is not acceptance.

---

## 3. Quality gates (CI-equivalent, all binary)

- **G1. Build:** `tsc --strict` clean across all packages. No `// @ts-ignore`,
  no `// @ts-expect-error` without an adjacent issue reference.
- **G2. No `any` / `unknown` leaks in public API.** Exported signatures in §6 are
  fully typed. Internal `any` is tolerated only behind a `ponytail:`/TODO with a
  reason.
- **G3. Lint clean.** No unused exports in public packages. No dead code on the
  hot path (e.g. an unused `rebase.ts` is a fail).
- **G4. Tests:** every test in §4 present and green. No `.only`, no `.skip`, no
  commented-out assertions. Flaky = failing.
- **G5. Coverage floor on `packages/core`:** rebase/replay, outbox lifecycle,
  idempotency, and conflict paths are line-covered. Uncovered branch on the
  apply path = fail.
- **G6. Determinism:** time and ids are injectable (`clock`, `idFactory`); no
  test depends on wall-clock `Date.now()` or `Math.random()`. Run the suite
  twice → identical results.
- **G7. No fabricated state:** no function returns a hardcoded placeholder that
  pretends to be real (`operationStatus`, `useQueryMeta`, server
  `__placeholder`, `check` no-op all must be real or explicitly throw
  "unsupported").
- **G8. Every non-trivial unsupported path throws a clear error** instead of
  silently doing the wrong thing.

---

## 4. Test matrix (the checklist — each line is one named test that must exist and pass)

**DX**
- [ ] explicit import mode works
- [ ] alias mode works in a Vite fixture
- [ ] normal Convex function fallback works (query + mutation)
- [ ] LF function detected by generated manifest
- [ ] `useQuery` honors `{ initial }`
- [ ] `useMutation` result is awaitable like a promise (`await call` → server result)
- [ ] `useMutation` result exposes `.local` and `.server`

**Core runtime**
- [ ] insert updates local query before server ack
- [ ] patch updates local query before server ack
- [ ] delete creates a tombstone
- [ ] duplicate op id is idempotent
- [ ] pending operations survive reload
- [ ] server rejection marks op AND row conflicted
- [ ] pull applies canonical changes
- [ ] pull applies tombstones
- [ ] **rebase: pull applies server changes THEN replays pending local ops** (a
      pending edit is not lost when a server change for the same row arrives)
- [ ] out-of-order server responses do not corrupt state

**Storage**
- [ ] IndexedDB migration v1 → v2
- [ ] blocked upgrade is reported
- [ ] transaction rollback works
- [ ] multi-tab elects exactly one sync leader
- [ ] closed-tab pending op recovered by a new tab
- [ ] logout clears the user namespace

**Sync**
- [ ] push accepted / push duplicate / push rejected
- [ ] pull from empty cursor / from existing cursor / multiple scopes
- [ ] schema mismatch blocks sync safely (no partial corruption)
- [ ] network failure retries with backoff

**Security**
- [ ] `byUser` cannot pull another user's rows
- [ ] `byWorkspace` checks membership
- [ ] server-only mutation never enters outbox
- [ ] `check` catches a direct write to an LF table
- [ ] client-supplied owner id is ignored/rejected when inappropriate

**Component**
- [ ] op ledger dedupes by (user, client, opId)
- [ ] change log is append-only
- [ ] cursor advances monotonically
- [ ] id map resolves local→server id
- [ ] tombstone visible until all relevant cursors pass it

---

## 5. Reject-if list (auto-fail even if the demo looks perfect)

- ❌ Server changes applied without rebase/replay (pending op clobbered).
- ❌ Any authorization decision made on the client.
- ❌ An LF table with no scope, or a `sync all` path reachable in prod.
- ❌ A side effect that runs twice on push retry.
- ❌ `await call` resolving to the local result instead of the server result.
- ❌ Conditional React hook calls (rules-of-hooks) in the adapter.
- ❌ A stub left on a shipped code path that returns fake-success.
- ❌ A passing test that asserts nothing meaningful, or a `.skip` shipped green.
- ❌ Breaking an existing plain-Convex query/mutation through the wrapper.

---

## 6. Public API surface (frozen — adding to this list requires explicit approval)

**App-author API** (the names a feature developer writes every day):

```
createLocalFirst, lf.table, table.query, table.insert, table.patch, table.remove
ConvexReactClient, ConvexProvider, useQuery, useMutation, useSyncStatus, useQueryMeta
convexLocalFirst (Vite plugin)
```

Plus the **wiring helpers an app instantiates once** at the root (to choose
persistence + transport): `IndexedDbStore`, `createConvexTransport`,
`createClientId`, and the `LocalStore` / `SyncTransport` interfaces they satisfy,
and the `localFirst` provider-config type. Plus Convex pass-throughs re-exported
for drop-in (`Authenticated`, `useConvex`, … — Convex's own vocabulary, not new).

Everything else — the **engine, rebase, ledger, the concrete store internals,
codegen output** — is internal or generated and must NOT appear in the public
type surface. Specifically: no `LocalFirstEngine` leak (e.g. via a public
`useLocalFirstEngine`), no `rebase`/replay types, no manifest interpreters.

---

## 7. Build order (do not skip ahead; each step lands green before the next)

1. `packages/core` robust + memory-store tests (rebase wired, idempotent outbox).
2. Hybrid mutation promise complete (`.local`/`.server`/`await`).
3. Rebase + replay with deterministic tests (the I1 invariant).
4. IndexedDB adapter (migrations, blocked upgrade, rollback).
5. React hooks: fallback + fixtures, rules-of-hooks correct, IndexedDB wired.
6. Server DSL real enough for the todo example (actual db writes + scope).
7. Generated manifest + generated sync functions.
8. Component helpers (ledger, change log, cursors, id map, tombstone GC).
9. CLI `codegen` + `check` (real static analysis).
10. Vite alias plugin verified in a fixture.
11. Devtools (after runtime is reliable).
12. CRDT document adapters (after CRUD sync is stable).

---

## 8. Working agreement for the loop

- **Tests before broad feature work.** Add the failing test from §4, then make
  it pass. No feature is "done" without its matrix line green.
- **Every iteration ends green or reverts.** No leaving the tree red "to fix
  next time."
- **Read prior art via tests, not just docs** (Replicache mutation lifecycle,
  Zero mutator/tracker, Electric offsets, RxDB replication/leadership, Dexie
  upgrade pitfalls) — but borrow the *correctness lesson*, not the architecture.
- **Lazy where safe, never where correctness/security lives.** Smallest diff
  that satisfies the invariant. Mark deliberate ceilings with `ponytail:` +
  upgrade path. Do not simplify away I1–I13.
- **No new dependency** for what a few lines do; no abstraction with one
  implementation.

---

## 9. Explicitly out of scope for Milestone 1 (so "strict" ≠ "infinite")

- **CRDT document mode** — now SHIPS: `@convex-localfirst/yjs` (Yjs rich text over the
  append-only log: codec + compaction + `useCollaborativeDoc`). Field-level convergence
  (`setFields` / `counterFields` / `timestampLww`) is wired into core sync directly.
  Still deferred: an **Automerge** adapter (same append-only-log approach) and **awareness/presence**.
- Devtools beyond a minimal op-log/pending/conflict view.
- Next.js plugin — document the alias strategy; full plugin is later.
- Presence/awareness, multi-region.

Deferring these is allowed. Faking I1–I13 to fit them in is not.
