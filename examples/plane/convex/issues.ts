import { v } from "convex/values";
import { lf, scopeWorkspaceId } from "./localfirst";

// The core local-first entity. Optimistic + offline; the server enforces workspace
// membership on push/pull (I7). label_ids/assignee_ids/module_ids are arrays on the issue
// (the Plane frontend contract) — declared as SET FIELDS so concurrent adds/removes from
// different users MERGE (convergent) instead of last-writer-wins clobbering the whole
// array. Scalar fields (name/priority/state_id/…) use timestamp-ordered LWW: two users
// editing the same issue offline reconnect and the NEWER edit wins deterministically
// (arrival order doesn't decide it). Set fields stay convergent — exempt from the timestamp
// rule. This is the real concurrent-edit driver for `timestampLww`.
const issues = lf.table("issues", {
  scope: scopeWorkspaceId,
  conflict: lf.timestampLww(),
  indexes: { byWorkspace: ["workspace_id", "created_at"] },
  setFields: ["label_ids", "assignee_ids", "module_ids"]
});

export const create = issues.insert({
  args: {
    workspace_id: v.string(),
    project_id: v.string(),
    sequence_id: v.number(),
    name: v.string(),
    sort_order: v.number(),
    priority: v.string(),
    label_ids: v.array(v.string()),
    assignee_ids: v.array(v.string()),
    created_by: v.string(),
    state_id: v.optional(v.union(v.string(), v.null())),
    description_html: v.optional(v.string()),
    parent_id: v.optional(v.union(v.string(), v.null())),
    start_date: v.optional(v.union(v.string(), v.null())),
    target_date: v.optional(v.union(v.string(), v.null()))
  },
  value: ({ args, now }) => ({
    workspace_id: String(args.workspace_id),
    project_id: String(args.project_id),
    sequence_id: Number(args.sequence_id),
    name: String(args.name),
    sort_order: Number(args.sort_order),
    priority: String(args.priority),
    label_ids: args.label_ids,
    assignee_ids: args.assignee_ids,
    created_by: String(args.created_by),
    state_id: args.state_id,
    description_html: args.description_html,
    parent_id: args.parent_id,
    start_date: args.start_date,
    target_date: args.target_date,
    created_at: now,
    updated_at: now
  })
});

// Generic partial patch — the seam for Plane's patchIssue(Partial<TIssue>). The
// service passes only the changed keys; absent args are skipped (not clobbered).
export const update = issues.patch({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    sort_order: v.optional(v.number()),
    priority: v.optional(v.string()),
    state_id: v.optional(v.union(v.string(), v.null())),
    label_ids: v.optional(v.array(v.string())),
    assignee_ids: v.optional(v.array(v.string())),
    module_ids: v.optional(v.array(v.string())),
    parent_id: v.optional(v.union(v.string(), v.null())),
    cycle_id: v.optional(v.union(v.string(), v.null())),
    estimate_point: v.optional(v.union(v.string(), v.null())),
    start_date: v.optional(v.union(v.string(), v.null())),
    target_date: v.optional(v.union(v.string(), v.null())),
    completed_at: v.optional(v.union(v.string(), v.null())),
    description_html: v.optional(v.string()),
    is_draft: v.optional(v.boolean()),
    sub_issues_count: v.optional(v.number()),
    updated_by: v.optional(v.string())
  },
  patch: ({ args, now }) => ({
    name: args.name,
    sort_order: args.sort_order,
    priority: args.priority,
    state_id: args.state_id,
    label_ids: args.label_ids,
    assignee_ids: args.assignee_ids,
    module_ids: args.module_ids,
    parent_id: args.parent_id,
    cycle_id: args.cycle_id,
    estimate_point: args.estimate_point,
    start_date: args.start_date,
    target_date: args.target_date,
    completed_at: args.completed_at,
    description_html: args.description_html,
    is_draft: args.is_draft,
    sub_issues_count: args.sub_issues_count,
    updated_by: args.updated_by,
    updated_at: now
  })
});

export const remove = issues.remove({ args: { id: v.string() } });
