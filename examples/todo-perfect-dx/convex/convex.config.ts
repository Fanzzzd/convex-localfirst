import { defineApp } from "convex/server";
import localfirst from "convex-localfirst/component/convex.config.js";

// Mount the local-first component. This is the whole "no hand-written backend"
// promise: the app gets the sync ledger / change log / id map / row versions
// as a drop-in, referenced via `components.convexLocalFirst.*`.
const app = defineApp();
app.use(localfirst);

export default app;
