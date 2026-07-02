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
    created_at: v.number(),
    updated_at: v.number(),
    created_by: v.optional(v.string()),
    updated_by: v.optional(v.string())
  },
  scope: scopeWorkspace,
  indexes: { byWorkspace: ["workspace", "created_at"] }
});

export const create = projects.insert({
  args: {
    workspace: v.string(),
    name: v.string(),
    identifier: v.string(),
    logo_props: v.optional(v.any()),
    network: v.optional(v.number()),
    created_by: v.optional(v.string())
  },
  value: ({ args, now }) => ({
    workspace: String(args.workspace),
    name: String(args.name),
    identifier: String(args.identifier),
    logo_props: args.logo_props,
    network: args.network,
    created_by: args.created_by,
    created_at: now,
    updated_at: now
  })
});

// Generic partial patch: every field optional, so the service passes only what
// changed (absent args resolve to undefined and are skipped — never clobbered).
export const update = projects.patch({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    identifier: v.optional(v.string()),
    description: v.optional(v.string()),
    logo_props: v.optional(v.any()),
    network: v.optional(v.number()),
    sort_order: v.optional(v.number()),
    is_favorite: v.optional(v.boolean()),
    project_lead: v.optional(v.union(v.string(), v.null())),
    default_assignee: v.optional(v.union(v.string(), v.null())),
    default_state: v.optional(v.union(v.string(), v.null())),
    cover_image: v.optional(v.union(v.string(), v.null())),
    archived_at: v.optional(v.union(v.string(), v.null())),
    updated_by: v.optional(v.string())
  },
  patch: ({ args, now }) => ({
    name: args.name,
    identifier: args.identifier,
    description: args.description,
    logo_props: args.logo_props,
    network: args.network,
    sort_order: args.sort_order,
    is_favorite: args.is_favorite,
    project_lead: args.project_lead,
    default_assignee: args.default_assignee,
    default_state: args.default_state,
    cover_image: args.cover_image,
    archived_at: args.archived_at,
    updated_by: args.updated_by,
    updated_at: now
  })
});

export const remove = projects.remove({ args: { id: v.string() } });
