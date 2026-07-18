# @convex-localfirst/component

A mountable [Convex component](https://docs.convex.dev/components) that holds all
local-first sync bookkeeping — the op ledger (idempotency), the change log (GC'd
opportunistically after the retention window), the local→server id map, and per-row
versions — so your app schema only carries its own tables.

```bash
npm install @convex-localfirst/component
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import localfirst from "@convex-localfirst/component/convex.config.js";

const app = defineApp();
app.use(localfirst);
export default app;
```

Peer dependency: `convex`. MIT
