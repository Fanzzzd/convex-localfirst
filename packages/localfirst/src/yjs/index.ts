// convex-localfirst/yjs — wire a Yjs CRDT (rich text, nested lists) onto a
// local-first append-only log. The codec is framework-agnostic; `createCollaborativeDoc`
// is the headless provider; `useCollaborativeDoc` is its React binding.
//
// Cursor/selection awareness lives at the `convex-localfirst/yjs/awareness` subpath so
// this entry never pulls in the optional `y-protocols` peer.
export {
  bytesToBase64,
  base64ToBytes,
  applyUpdateSafe,
  makeSnapshot,
  REMOTE_ORIGIN
} from "./yjsSync.js";
export {
  createCollaborativeDoc,
  type CollaborativeDoc,
  type CreateCollaborativeDocOptions,
  type CompactionOptions,
  type DocPersistence,
  type DocStatus,
  type DocUpdateRow,
  type MutationLike,
  type MutationStages
} from "./provider.js";
export {
  useCollaborativeDoc,
  type CollaborativeDocRow,
  type UseCollaborativeDocOptions,
  type UseCollaborativeDocResult
} from "./useCollaborativeDoc.js";
