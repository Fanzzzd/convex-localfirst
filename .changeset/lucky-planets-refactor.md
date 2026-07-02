---
"@convex-localfirst/core": minor
"@convex-localfirst/react": minor
"@convex-localfirst/server": minor
"@convex-localfirst/component": minor
"@convex-localfirst/cli": minor
"@convex-localfirst/yjs": minor
---

Declare once, run everywhere — the codegen step is gone.

- **No codegen.** The client builds its manifest at runtime from your imported
  `lf.table` modules (`collectManifest`, or just the provider's new `modules`
  option). The original `value`/`patch`/`key` closures run locally — arbitrary
  computation now works in specs (the old parser only understood bare
  arg/auth/now/const references). `convex-localfirst codegen`/`dev`, the
  generated `src/convex-localfirst/generated.ts`, and the tsx requirement are
  all removed; the CLI keeps `init` (scaffolds the new layout) and `check`.
- **Schema single source.** `lf.table` now declares the table's `shape`
  (validators), and `todos.table()` derives the Convex table definition —
  `defineSchema({ todos: todos.table() })` — auto-adding the id field and the
  declared indexes (plus optional server-only `extra` fields).
  `createLocalFirst()` no longer takes a schema.
- **Zero-config provider.** `localFirst={{ modules: { todos }, userId }}` is a
  complete setup: IndexedDB persistence (namespaced per user), the Convex
  transport against `api.sync.push`/`api.sync.pull`, and a client id are
  defaulted (all overridable). `createConvexLocalFirst` accepts `modules` too.
- In the browser, `lf.table` exports are metadata-only stubs — no Convex
  function is registered client-side (Convex forbids that), while deploys, SSR,
  and tests still register real functions.
- Fixed: a React StrictMode mount→cleanup→mount cycle left the engine deaf to
  browser online/offline events (the offline badge never flipped). The provider
  now `resume()`s the engine's connectivity listeners on mount.
