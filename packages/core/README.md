# @convex-localfirst/core

The local-first engine for [Convex](https://convex.dev): a canonical-centric store
where the live view is derived (`canonical + replay(pending)`), so server changes never
clobber pending local ops. Includes the sync protocol, deterministic op ordering, an
IndexedDB adapter with migrations, Web Locks multi-tab leadership, and opt-in convergent
merges (set / counter / timestamp-LWW).

Most apps use [`@convex-localfirst/react`](https://www.npmjs.com/package/@convex-localfirst/react)
or [`@convex-localfirst/server`](https://www.npmjs.com/package/@convex-localfirst/server)
rather than this package directly.

```bash
npm install @convex-localfirst/core
```

MIT
