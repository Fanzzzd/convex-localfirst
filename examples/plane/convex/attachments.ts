import { v } from "convex/values";
import { lf, scopeWorkspaceId } from "./localfirst";

// Issue attachments: an ORDINARY local-first metadata table (created optimistically,
// synced like any row). The blob is uploaded in the background by the client's leader
// tab; `storageId` is SERVER-controlled — stamped by the finalize mutation (see sync.ts)
// via serverWriter once the upload completes, then synced to every client.
export const attachments = lf.table("attachments", {
  shape: {
    workspace_id: v.string(),
    project_id: v.string(),
    issue_id: v.string(),
    name: v.string(),
    size: v.number(),
    mime_type: v.string(),
    // Convex storage id, set by finalize (never by a client insert/patch).
    storageId: v.optional(v.union(v.string(), v.null())),
  },
  scope: scopeWorkspaceId, // scope field = "workspace_id" (shared ws_members membership)
  timestamps: ["created_at", "updated_at"],
  indexes: { byIssue: ["workspace_id", "issue_id", "created_at"] },
});

// Custom insert: `storageId` is omitted from the client args — it is server-controlled,
// so a client can never set it. (timestamps are still stamped automatically.)
export const create = attachments.insert({
  args: {
    workspace_id: v.string(),
    project_id: v.string(),
    issue_id: v.string(),
    name: v.string(),
    size: v.number(),
    mime_type: v.string(),
  },
  value: ({ args }) => ({ ...args }),
});

// Deleting a not-yet-uploaded attachment cancels its pending upload client-side (the
// engine drops the durable blob when the metadata row's delete delta fires).
export const remove = attachments.remove();
