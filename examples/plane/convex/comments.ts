import { v } from "convex/values";
import { lf, scopeWorkspace } from "./localfirst";

export const comments = lf.table("issue_comments", {
  shape: {
    workspace: v.string(),
    project: v.string(),
    issue: v.string(),
    actor: v.string(),
    comment_html: v.string(),
    comment_stripped: v.optional(v.string()),
    access: v.optional(v.string()),
    created_by: v.string()
  },
  scope: scopeWorkspace, // scope field = "workspace"
  timestamps: ["created_at", "updated_at"],
  indexes: { byWorkspace: ["workspace", "created_at"] }
});

// Custom insert (created_by is derived from the actor, not passed by the caller);
// timestamps are still stamped automatically.
export const create = comments.insert({
  args: {
    workspace: v.string(),
    project: v.string(),
    issue: v.string(),
    actor: v.string(),
    comment_html: v.string(),
    comment_stripped: v.optional(v.string()),
    access: v.optional(v.string())
  },
  value: ({ args }) => ({ ...args, created_by: args.actor })
});

export const update = comments.patch();
export const remove = comments.remove();
