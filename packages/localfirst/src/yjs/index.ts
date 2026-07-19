// convex-localfirst/yjs — wire a Yjs CRDT (rich text, nested lists) onto a
// local-first append-only log. The codec is framework-agnostic; the hook is React.
export {
  bytesToBase64,
  base64ToBytes,
  applyUpdateSafe,
  makeSnapshot,
  REMOTE_ORIGIN
} from "./yjsSync.js";
export {
  useCollaborativeDoc,
  type CollaborativeDocRow,
  type UseCollaborativeDocOptions
} from "./useCollaborativeDoc.js";
