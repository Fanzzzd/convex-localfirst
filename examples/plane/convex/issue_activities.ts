import { v } from "convex/values";
import { lf, scopeWorkspace } from "./localfirst";

// Issue activities: the per-issue history feed (Plane's TIssueActivity). The router EMITS
// a row from this table on issue create and on bounded field updates (name/state/priority),
// then returns them newest-first on the /history/ route. Scope field "workspace" (slug,
// comment-style) + carries "project" and "issue" so the route can filter by issue.
// Append-only in practice (no update/remove), but we expose remove for completeness/parity.
export const activities = lf.table("issue_activities", {
  shape: {
    workspace: v.string(),
    project: v.string(),
    issue: v.string(),
    actor: v.string(),
    verb: v.string(),
    field: v.optional(v.union(v.string(), v.null())),
    old_value: v.optional(v.union(v.string(), v.null())),
    new_value: v.optional(v.union(v.string(), v.null())),
    old_identifier: v.optional(v.union(v.string(), v.null())),
    new_identifier: v.optional(v.union(v.string(), v.null())),
    comment: v.optional(v.string()),
    created_by: v.string(),
  },
  scope: scopeWorkspace,
  timestamps: ["created_at", "updated_at"],
  indexes: { byWorkspace: ["workspace", "created_at"] },
});

// created_by mirrors the actor; everything else is derived from the shape.
export const create = activities.insert({
  args: {
    workspace: v.string(),
    project: v.string(),
    issue: v.string(),
    actor: v.string(),
    verb: v.string(),
    field: v.optional(v.union(v.string(), v.null())),
    old_value: v.optional(v.union(v.string(), v.null())),
    new_value: v.optional(v.union(v.string(), v.null())),
    old_identifier: v.optional(v.union(v.string(), v.null())),
    new_identifier: v.optional(v.union(v.string(), v.null())),
    comment: v.optional(v.string()),
  },
  value: ({ args }) => ({ ...args, created_by: args.actor }),
});

export const remove = activities.remove();
