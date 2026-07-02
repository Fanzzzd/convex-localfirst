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
    created_at: v.number(),
    updated_at: v.number(),
    created_by: v.string()
  },
  scope: scopeWorkspace,
  indexes: { byWorkspace: ["workspace", "created_at"] }
});

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
    comment: v.optional(v.string())
  },
  value: ({ args, now }) => ({
    workspace: String(args.workspace),
    project: String(args.project),
    issue: String(args.issue),
    actor: String(args.actor),
    verb: String(args.verb),
    field: args.field,
    old_value: args.old_value,
    new_value: args.new_value,
    old_identifier: args.old_identifier,
    new_identifier: args.new_identifier,
    comment: args.comment,
    created_at: now,
    updated_at: now,
    created_by: String(args.actor)
  })
});

export const remove = activities.remove({ args: { id: v.string() } });
