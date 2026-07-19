---
"convex-localfirst": minor
---

One package. `convex-localfirst` is now the only published package — the six
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
