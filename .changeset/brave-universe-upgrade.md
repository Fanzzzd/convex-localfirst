---
"convex-localfirst": minor
"@convex-localfirst/core": minor
"@convex-localfirst/react": minor
"@convex-localfirst/server": minor
"@convex-localfirst/component": minor
"@convex-localfirst/cli": minor
"@convex-localfirst/yjs": minor
---

One-line install, one-number schema migrations, and hardening.

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
