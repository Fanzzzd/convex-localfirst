import { defineApp } from "convex/server";
import localfirst from "@convex-localfirst/component/convex.config.js";

// Mount the local-first component — same drop-in sync ledger the todo example uses.
const app = defineApp();
app.use(localfirst);

export default app;
