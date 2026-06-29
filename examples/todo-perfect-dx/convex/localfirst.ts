import { createLocalFirst } from "@convex-localfirst/server";
import schema from "./schema";

// The schema is inferred from `schema`, so `lf.table("issues", …)` knows the row
// type — `useQuery` then infers `Doc<"issues">[]` on the client with no explicit
// generics. Auth is resolved server-side at sync time (convex/sync.ts), not here.
export const lf = createLocalFirst({
  schema,
  defaults: {
    idField: "localId",
    conflict: "fieldLww"
  }
});
