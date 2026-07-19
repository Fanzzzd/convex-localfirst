import { createLocalFirst } from "convex-localfirst/server";

// Auth is resolved server-side at sync time (convex/sync.ts → createSyncFunctions),
// not here — this factory only declares the local-first tables.
export const lf = createLocalFirst({
  // Plane entities key on `id`; field-level LWW is the merge policy.
  defaults: { idField: "id" }
});

// Two scope helpers because Plane's types name the workspace field differently per
// table ("workspace" on projects/comments, "workspace_id" elsewhere). Both resolve to
// the same workspace value + share ws_members, so membership is one check.
export const scopeWorkspace = lf.byWorkspace({ workspaceIdField: "workspace", membershipTable: "ws_members" });
export const scopeWorkspaceId = lf.byWorkspace({ workspaceIdField: "workspace_id", membershipTable: "ws_members" });
