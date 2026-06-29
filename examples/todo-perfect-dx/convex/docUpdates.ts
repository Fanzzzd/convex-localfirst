import { v } from "convex/values";
import { lf } from "./localfirst";

// Collaborative document content. Each row is ONE base64-encoded Yjs binary
// update. Updates are commutative + idempotent, so rows delivered in any order,
// at least once, converge to the same Y.Doc on every client — no conflict
// resolution needed. This is the whole trick that lets a CRDT ride our log.
//
// COMPACTION: to keep a doc's row count bounded, a client periodically writes a
// SNAPSHOT row (Y.encodeStateAsUpdate — itself a valid update that reproduces the
// whole doc) and PRUNES the rows it subsumed. Pruning is safe precisely because a
// snapshot encodes the effect of every row it replaces: a peer that later pulls
// the snapshot + the deletes still ends up with identical content, and any
// concurrent/late update merges on top (CRDT). Deletes of immutable rows commute,
// so even two clients compacting at once is safe (just redundant).
const docUpdates = lf.table("doc_updates", {
  scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
  idField: "localId",
  conflict: lf.fieldLww(),
  indexes: { byWorkspace: ["workspaceId", "createdAt"], byDoc: ["workspaceId", "docId", "createdAt"] }
});

export const append = docUpdates.insert({
  args: { workspaceId: v.string(), docId: v.string(), update: v.string() },
  value: ({ args, now }) => ({
    workspaceId: String(args.workspaceId),
    docId: String(args.docId),
    update: String(args.update),
    createdAt: now
  })
});

// Prune a row subsumed by a snapshot (compaction). Safe: its effect lives on in
// the snapshot, so removing it never loses content.
export const prune = docUpdates.remove({ args: { id: v.string() } });
