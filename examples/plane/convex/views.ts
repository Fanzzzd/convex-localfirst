import { v } from "convex/values";
import { lf, scopeWorkspace } from "./localfirst";

// Views: a saved set of filters/display options for a project (Plane's IProjectView).
// Scope field "workspace" (IProjectView.workspace, slug) — comment/project-style — and
// also carries "project" so the view store can filter views by project.
export const views = lf.table("views", {
  shape: {
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
    created_by: v.optional(v.string()),
  },
  scope: scopeWorkspace,
  timestamps: ["created_at", "updated_at"],
  indexes: { byWorkspace: ["workspace", "created_at"] },
});

export const create = views.insert();
export const update = views.patch();
export const remove = views.remove();
