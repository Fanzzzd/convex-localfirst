import { v } from "convex/values";
import { lf, scopeWorkspace } from "./localfirst";

// Views: a saved set of filters/display options for a project (Plane's IProjectView).
// Scope field "workspace" (IProjectView.workspace, slug) — comment/project-style — and
// also carries "project" so the view store can filter views by project. Same byWorkspace
// shape as projects/comments.
const views = lf.table("views", {
  scope: scopeWorkspace,
  indexes: { byWorkspace: ["workspace", "created_at"] }
});

export const create = views.insert({
  args: {
    workspace: v.string(),
    project: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    access: v.optional(v.number()),
    rich_filters: v.optional(v.any()),
    display_filters: v.optional(v.any()),
    display_properties: v.optional(v.any()),
    query: v.optional(v.any()),
    query_data: v.optional(v.any()),
    logo_props: v.optional(v.any()),
    sort_order: v.optional(v.number()),
    created_by: v.optional(v.string())
  },
  value: ({ args, now }) => ({
    workspace: String(args.workspace),
    project: String(args.project),
    name: String(args.name),
    description: args.description,
    access: args.access,
    rich_filters: args.rich_filters,
    display_filters: args.display_filters,
    display_properties: args.display_properties,
    query: args.query,
    query_data: args.query_data,
    logo_props: args.logo_props,
    sort_order: args.sort_order,
    created_by: args.created_by,
    created_at: now,
    updated_at: now
  })
});

export const update = views.patch({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    access: v.optional(v.number()),
    rich_filters: v.optional(v.any()),
    display_filters: v.optional(v.any()),
    display_properties: v.optional(v.any()),
    query: v.optional(v.any()),
    query_data: v.optional(v.any()),
    logo_props: v.optional(v.any()),
    sort_order: v.optional(v.number())
  },
  patch: ({ args, now }) => ({
    name: args.name,
    description: args.description,
    access: args.access,
    rich_filters: args.rich_filters,
    display_filters: args.display_filters,
    display_properties: args.display_properties,
    query: args.query,
    query_data: args.query_data,
    logo_props: args.logo_props,
    sort_order: args.sort_order,
    updated_at: now
  })
});

export const remove = views.remove({ args: { id: v.string() } });
