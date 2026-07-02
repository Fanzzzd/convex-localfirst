import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { comments } from "./comments";
import { cycles } from "./cycles";
import { activities } from "./issue_activities";
import { issues } from "./issues";
import { labels } from "./labels";
import { modules } from "./modules";
import { projects } from "./projects";
import { states } from "./states";
import { views } from "./views";

// Plane, rebuilt on convex-localfirst — the REPLACEMENT for Plane's Django backend
// (apps/api). Field names match Plane's frontend TS contract (packages/types,
// snake_case). Storage is deliberately MINIMAL: only fields actually set at insert
// are required; the rewritten service layer is the mapper that fills the full
// TIssue/TProject/... contract (null/false/0/[] defaults, number->ISO timestamps,
// computed fields like state__group) when returning rows to the MobX stores. This
// keeps inserts tiny and the UI 1:1.
//
// Identity (demo): workspace.id === workspace.slug, single signed-in user. Scope:
// workspace management is regular Convex (membership = server authority); everything
// inside a workspace is local-first `byWorkspace` (scope VALUE = workspace slug; the
// scope FIELD name differs per table to match Plane's types — handled per-table).
export default defineSchema({
  // --- regular Convex: identity + membership (server authority) ----------------
  users: defineTable({
    id: v.string(),
    email: v.string(),
    display_name: v.string(),
    first_name: v.string(),
    last_name: v.string(),
    avatar_url: v.string(),
    is_active: v.boolean(),
    is_bot: v.boolean()
  }).index("byId", ["id"]),

  workspaces: defineTable({
    id: v.string(), // === slug; also the byWorkspace scope value
    name: v.string(),
    slug: v.string(),
    owner_id: v.string(),
    logo_url: v.optional(v.union(v.string(), v.null())),
    total_members: v.optional(v.number()),
    total_projects: v.optional(v.number()),
    organization_size: v.optional(v.string()),
    timezone: v.optional(v.string()),
    created_at: v.number(),
    created_by: v.optional(v.string())
  })
    .index("byId", ["id"])
    .index("by_slug", ["slug"]),

  ws_members: defineTable({
    user_id: v.string(),
    workspace_id: v.string(),
    role: v.number() // EUserWorkspaceRoles: 20 admin / 15 member / 5 guest
  })
    .index("by_user_ws", ["user_id", "workspace_id"])
    .index("by_ws", ["workspace_id"]),

  // --- local-first byWorkspace (idField "id"); scope field per Plane's type ----
  // projects: scope field = "workspace" (TProject.workspace)
  projects: projects.table(),
  // states: scope field = "workspace_id" (IState.workspace_id)
  states: states.table(),
  // labels: scope field = "workspace_id" (IIssueLabel.workspace_id)
  labels: labels.table(),
  // cycles: scope field = "workspace_id" (ICycle.workspace_id)
  cycles: cycles.table(),
  // issues: scope field = "workspace_id" (extra field beyond TBaseIssue; UI ignores)
  issues: issues.table(),
  // modules: scope field = "workspace_id" (IModule.workspace_id)
  modules: modules.table(),
  // views: scope field = "workspace" (IProjectView.workspace, slug); also carries "project"
  views: views.table(),
  // issue_activities: scope field = "workspace" (TIssueActivity.workspace, slug); carries
  // "project" + "issue". Emitted by the router on issue create / bounded field updates.
  issue_activities: activities.table(),
  // issue_comments: scope field = "workspace" (TIssueComment.workspace)
  issue_comments: comments.table()
});
