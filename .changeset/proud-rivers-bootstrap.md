---
"convex-localfirst": minor
"@convex-localfirst/core": minor
"@convex-localfirst/react": minor
"@convex-localfirst/server": minor
"@convex-localfirst/component": minor
"@convex-localfirst/cli": minor
"@convex-localfirst/yjs": minor
---

Snapshot bootstrap, change-log GC, derived mutation specs, serverWriter — and the conflict-policy option is gone.

- **Snapshot bootstrap.** A client with no cursor for a scope now loads the
  *current rows* (paged, driven by the new per-row version authority) instead of
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
- **Row-level visibility.** A per-table `visibility` hook filters rows *within*
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
