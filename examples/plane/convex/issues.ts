import { v } from "convex/values";
import { lf, scopeWorkspaceId } from "./localfirst";

// The core local-first entity. Optimistic + offline; the server enforces workspace
// membership on push/pull (I7). label_ids/assignee_ids/module_ids are arrays on the issue
// (the Plane frontend contract) — declared as SET FIELDS so concurrent adds/removes from
// different users MERGE (convergent) instead of last-writer-wins clobbering the whole
// array. Scalar fields (name/priority/state_id/…) merge field-by-field (LWW per field).
export const issues = lf.table("issues", {
  shape: {
    workspace_id: v.string(),
    project_id: v.string(),
    sequence_id: v.optional(v.number()), // server-minted (serverStamp in sync.ts) — clients never pick it
    name: v.string(),
    sort_order: v.number(),
    priority: v.string(), // "urgent"|"high"|"medium"|"low"|"none"
    label_ids: v.array(v.string()),
    assignee_ids: v.array(v.string()),
    state_id: v.optional(v.union(v.string(), v.null())),
    module_ids: v.optional(v.array(v.string())),
    estimate_point: v.optional(v.union(v.string(), v.null())),
    sub_issues_count: v.optional(v.number()),
    attachment_count: v.optional(v.number()),
    link_count: v.optional(v.number()),
    parent_id: v.optional(v.union(v.string(), v.null())),
    cycle_id: v.optional(v.union(v.string(), v.null())),
    type_id: v.optional(v.union(v.string(), v.null())),
    start_date: v.optional(v.union(v.string(), v.null())),
    target_date: v.optional(v.union(v.string(), v.null())),
    completed_at: v.optional(v.union(v.string(), v.null())),
    archived_at: v.optional(v.union(v.string(), v.null())),
    description_html: v.optional(v.string()),
    is_draft: v.optional(v.boolean()),
    created_by: v.string(),
    updated_by: v.optional(v.string()),
  },
  scope: scopeWorkspaceId,
  timestamps: ["created_at", "updated_at"],
  indexes: { byWorkspace: ["workspace_id", "created_at"] },
  setFields: ["label_ids", "assignee_ids", "module_ids"],
  // CLIENT-SIDE mirror of sync.ts's `access.write` (DX v4 §6). Declared here, in the SAME
  // isomorphic module the shape lives in: the server IGNORES it (createSyncFunctions stays
  // authoritative), the client evaluates it in `useCan` so buttons disable instead of the
  // push rejecting. Kept byte-for-byte in step with the server rule below. `role` is the
  // ws_members role the server ships per pull (admin/member ≥ 15, viewer 10, guest 5).
  clientCan: {
    write: ({ userId, role, action, before, proposed }) => {
      const r = role as number;
      if (r >= 15) return true; // admin / member
      if (r !== 5) return false; // viewer (10) is read-only
      const sees = (row: typeof before) =>
        !!row && (row.created_by === userId || (row.assignee_ids ?? []).includes(userId ?? ""));
      if (action === "insert") return proposed?.created_by === userId;
      return sees(before) && (action === "delete" || sees(proposed));
    },
  },
});

// Derived from the shape: create takes every field (timestamps stamped automatically),
// update takes `id` + any subset of fields (absent args are skipped, not clobbered) —
// the seam for Plane's patchIssue(Partial<TIssue>).
export const create = issues.insert();
export const update = issues.patch();
export const remove = issues.remove();
