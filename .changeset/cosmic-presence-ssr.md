---
"convex-localfirst": minor
"@convex-localfirst/core": minor
"@convex-localfirst/react": minor
"@convex-localfirst/server": minor
"@convex-localfirst/component": minor
"@convex-localfirst/cli": minor
"@convex-localfirst/yjs": minor
---

Presence, and byUser queries that run everywhere.

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
