import { v } from "convex/values";
import { lf, scopeWorkspace } from "./localfirst";

export const projects = lf.table("projects", {
  shape: {
    workspace: v.string(),
    name: v.string(),
    identifier: v.string(),
    description: v.optional(v.string()),
    network: v.optional(v.number()),
    sort_order: v.optional(v.number()),
    logo_props: v.optional(v.any()),
    cover_image: v.optional(v.union(v.string(), v.null())),
    archived_at: v.optional(v.union(v.string(), v.null())),
    project_lead: v.optional(v.union(v.string(), v.null())),
    default_assignee: v.optional(v.union(v.string(), v.null())),
    default_state: v.optional(v.union(v.string(), v.null())),
    cycle_view: v.optional(v.boolean()),
    module_view: v.optional(v.boolean()),
    page_view: v.optional(v.boolean()),
    intake_view: v.optional(v.boolean()),
    issue_views_view: v.optional(v.boolean()),
    is_favorite: v.optional(v.boolean()),
    members: v.optional(v.array(v.string())),
    timezone: v.optional(v.string()),
    created_by: v.optional(v.string()),
    updated_by: v.optional(v.string())
  },
  scope: scopeWorkspace,
  timestamps: ["created_at", "updated_at"],
  indexes: { byWorkspace: ["workspace", "created_at"] }
});

export const create = projects.insert();
export const update = projects.patch();
export const remove = projects.remove();
