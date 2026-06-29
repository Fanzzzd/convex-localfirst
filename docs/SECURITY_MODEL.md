# Security Model

## Rule 1: server authority

The client may speculate but cannot authorize. Convex validates all pushed operations.

## Rule 2: explicit scopes

Every local-first table has a sync scope.

Accepted initial scopes:

- by user
- by workspace
- by project

A production build must not allow global sync unless the developer explicitly enables an unsafe development flag.

## Rule 3: generated push validates every operation

The generated server push function enforces, server-side (the client cannot bypass):

- authenticated user (identity from Convex auth, never the client envelope)
- schema version
- the sync envelope shape (Convex validators on the push/pull arguments). NOTE: the
  per-operation `value` / `patch` payload is accepted as `v.any()` and is NOT re-validated
  against the original local mutation's argument validators, nor recomputed from args —
  see "Business-rule re-execution" below. Type/shape safety for stored rows comes from
  the app's own Convex row schema, not from this endpoint.
- table scope (derived from the authenticated user / stored row, never client-supplied)
- row ownership or membership (from the stored row, not `op.value`)
- partition integrity (a patch cannot move a row across scopes or rewrite its id)
- idempotency (the operation ledger dedupes by `(userId, opId)`)

**Not yet enforced server-side (current limitation, by design — see [syncing.mdx](../website/content/docs/syncing.mdx) "Trust model"):**

- **Conflict policy / `baseVersion`.** The conflict policy (e.g. `fieldLww`) is applied
  CLIENT-side during rebase/replay; the server accepts writes in arrival order
  (last-writer-wins) and does NOT reject on a stale `baseVersion`. Server-side
  per-policy enforcement requires the client to send `baseVersion` and is a known
  follow-up. Because scope/ownership/partition ARE enforced, this cannot be used to
  write another user's data — only to lose a concurrent same-scope edit under racing writers.
- **Business-rule re-execution.** The server trusts the client's computed `value`/`patch`
  (validated for type/shape, not recomputed from args), so the model is
  client-authoritative within an authorized scope.

## Rule 4: generated pull filters every change

The generated server pull function must filter changes by the authenticated user's scope.

## Rule 5: direct writes are checked

If a Convex mutation writes to a local-first table directly through `ctx.db`, `convex-localfirst check` must report it. Generated wrappers or local-first DSL functions are the allowed write path.

## Rule 6: side effects are not offline

Email, billing, external APIs, AI calls, role changes, and destructive admin actions are server-only unless a specific safe local-first protocol is implemented.

## Rule 7: logout clears or isolates local data

Local data must be namespaced by deployment and authenticated user. On logout, the app must clear the namespace or switch to another namespace.
