import { v } from "convex/values";
import { lf, scopeWorkspace } from "./localfirst";

// Collaborative rich-text documents (Plane's issue description / pages), stored as a Yjs
// CRDT over the local-first append-only log. Each row is ONE Yjs binary update, base64.
// Because Yjs updates are commutative + idempotent, this insert-only stream needs zero
// conflict handling and converges under any delivery order — the whole reason a doc rides
// the same sync engine as every other table.
//
// `doc` scopes a row to one document (an issue id, a page id, ...); the provider filters
// rows to a single `doc` on the client. Workspace-scoped, so doc access rides the SAME
// membership/access rules as issues (P6: doc-level permissions through the table's scope).
export const docUpdates = lf.table("doc_updates", {
  shape: {
    workspace: v.string(),
    doc: v.string(),
    // A base64 Yjs update OR a compaction snapshot (a full-state update). Both are just
    // updates as far as the log is concerned.
    update: v.string(),
  },
  scope: scopeWorkspace, // scope field = "workspace" (shares ws_members with every table)
  indexes: { byWorkspace: ["workspace"], byDoc: ["workspace", "doc"] },
});

// append: one new update row (args: { workspace, doc, update }). Insert-only — never
// patched. The provider calls this for every local Yjs edit and for each snapshot.
export const append = docUpdates.insert();

// remove: prune a row subsumed by a confirmed snapshot (args: { id }). The provider only
// calls this AFTER the snapshot append is confirmed server-side (crash-safe compaction).
export const remove = docUpdates.remove();
