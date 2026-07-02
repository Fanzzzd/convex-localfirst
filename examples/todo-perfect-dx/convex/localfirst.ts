import { createLocalFirst } from "convex-localfirst/server";

// The lf factory. Each table module declares its shape/scope/indexes ONCE with
// lf.table — the Convex schema derives from it (convex/schema.ts), the server
// sync config derives from it (convex/sync.ts, collectTables), and the client
// runs the same declarations locally (src/main.tsx, `modules`). Auth is resolved
// server-side at sync time (convex/sync.ts), not here.
export const lf = createLocalFirst();
