import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
  projects: defineTable({
    id: v.string(),
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
  })
    .index("byId", ["id"])
    .index("byWorkspace", ["workspace", "created_at"]),

  // states: scope field = "workspace_id" (IState.workspace_id)
  states: defineTable({
    id: v.string(),
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    color: v.string(),
    group: v.union(
      v.literal("backlog"),
      v.literal("unstarted"),
      v.literal("started"),
      v.literal("completed"),
      v.literal("cancelled")
    ),
    description: v.optional(v.string()),
    sequence: v.optional(v.number()),
    order: v.number(),
    default: v.optional(v.boolean()),
    created_at: v.number()
  })
    .index("byId", ["id"])
    .index("byWorkspace", ["workspace_id", "created_at"]),

  // labels: scope field = "workspace_id" (IIssueLabel.workspace_id)
  labels: defineTable({
    id: v.string(),
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    color: v.string(),
    parent: v.optional(v.union(v.string(), v.null())),
    sort_order: v.optional(v.number()),
    created_at: v.number()
  })
    .index("byId", ["id"])
    .index("byWorkspace", ["workspace_id", "created_at"]),

  // cycles: scope field = "workspace_id" (ICycle.workspace_id)
  cycles: defineTable({
    id: v.string(),
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    start_date: v.optional(v.union(v.string(), v.null())),
    end_date: v.optional(v.union(v.string(), v.null())),
    owned_by_id: v.optional(v.string()),
    sort_order: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number()
  })
    .index("byId", ["id"])
    .index("byWorkspace", ["workspace_id", "created_at"]),

  // issues: scope field = "workspace_id" (extra field beyond TBaseIssue; UI ignores)
  issues: defineTable({
    id: v.string(),
    workspace_id: v.string(),
    project_id: v.string(),
    sequence_id: v.number(),
    name: v.string(),
    sort_order: v.number(),
    priority: v.string(), // "urgent"|"high"|"medium"|"low"|"none"
    label_ids: v.array(v.string()),
    assignee_ids: v.array(v.string()),
    state_id: v.optional(v.union(v.string(), v.null())),
    module_ids: v.optional(v.array(v.string())),
    estimate_point: v.optional(v.union(v.string(), v.null())),
    sub_issues_count: v.optional(v.number()),
    attachment_count: v.optional(v.number()),
    link_count: v.optional(v.number()),
    parent_id: v.optional(v.union(v.string(), v.null())),
    cycle_id: v.optional(v.union(v.string(), v.null())),
    type_id: v.optional(v.union(v.string(), v.null())),
    start_date: v.optional(v.union(v.string(), v.null())),
    target_date: v.optional(v.union(v.string(), v.null())),
    completed_at: v.optional(v.union(v.string(), v.null())),
    archived_at: v.optional(v.union(v.string(), v.null())),
    description_html: v.optional(v.string()),
    is_draft: v.optional(v.boolean()),
    created_at: v.number(),
    updated_at: v.number(),
    created_by: v.string(),
    updated_by: v.optional(v.string())
  })
    .index("byId", ["id"])
    .index("byWorkspace", ["workspace_id", "created_at"]),

  // modules: scope field = "workspace_id" (IModule.workspace_id)
  modules: defineTable({
    id: v.string(),
    workspace_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    start_date: v.optional(v.union(v.string(), v.null())),
    target_date: v.optional(v.union(v.string(), v.null())),
    lead_id: v.optional(v.union(v.string(), v.null())),
    member_ids: v.optional(v.array(v.string())),
    sort_order: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number()
  })
    .index("byId", ["id"])
    .index("byWorkspace", ["workspace_id", "created_at"]),

  // views: scope field = "workspace" (IProjectView.workspace, slug); also carries "project"
  views: defineTable({
    id: v.string(),
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
    created_at: v.number(),
    updated_at: v.number(),
    created_by: v.optional(v.string())
  })
    .index("byId", ["id"])
    .index("byWorkspace", ["workspace", "created_at"]),

  // issue_activities: scope field = "workspace" (TIssueActivity.workspace, slug); carries
  // "project" + "issue". Emitted by the router on issue create / bounded field updates.
  issue_activities: defineTable({
    id: v.string(),
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
  })
    .index("byId", ["id"])
    .index("byWorkspace", ["workspace", "created_at"]),

  // issue_comments: scope field = "workspace" (TIssueComment.workspace)
  issue_comments: defineTable({
    id: v.string(),
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
  })
    .index("byId", ["id"])
    .index("byWorkspace", ["workspace", "created_at"])
});
