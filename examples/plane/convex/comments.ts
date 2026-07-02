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
    created_at: v.number(),
    updated_at: v.number(),
    created_by: v.string()
  },
  scope: scopeWorkspace, // scope field = "workspace"
  indexes: { byWorkspace: ["workspace", "created_at"] }
});

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
  value: ({ args, now }) => ({
    workspace: String(args.workspace),
    project: String(args.project),
    issue: String(args.issue),
    actor: String(args.actor),
    comment_html: String(args.comment_html),
    comment_stripped: args.comment_stripped,
    access: args.access,
    created_by: String(args.actor),
    created_at: now,
    updated_at: now
  })
});

export const update = comments.patch({
  args: {
    id: v.string(),
    comment_html: v.optional(v.string()),
    comment_stripped: v.optional(v.string())
  },
  patch: ({ args, now }) => ({
    comment_html: args.comment_html,
    comment_stripped: args.comment_stripped,
    updated_at: now
  })
});

export const remove = comments.remove({ args: { id: v.string() } });
