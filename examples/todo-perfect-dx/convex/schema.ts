import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The app declares its own domain tables. All local-first sync bookkeeping
// (ledger / change log / id map / cursors / tombstones) lives in the mounted
// @convex-localfirst/component — that is the whole point of the component.
export default defineSchema({
  // --- byUser local-first table (simple scope) ---
  todos: defineTable({
    localId: v.string(),
    ownerId: v.string(),
    listId: v.string(),
    text: v.string(),
    done: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number()
  })
    .index("by_localId", ["localId"])
    .index("by_owner", ["ownerId"])
    .index("byList", ["ownerId", "listId", "createdAt"]),

  // --- byWorkspace local-first table (membership-scoped, Linear-lite) ---
  issues: defineTable({
    localId: v.string(),
    workspaceId: v.string(),
    projectId: v.optional(v.string()), // FK -> projects.localId (relation: issue.project); optional so an issue can be unfiled
    title: v.string(),
    status: v.union(v.literal("backlog"), v.literal("in_progress"), v.literal("done")),
    priority: v.number(),
    assignee: v.string(),
    createdAt: v.number(),
    updatedAt: v.number()
  })
    .index("by_localId", ["localId"])
    .index("byWorkspace", ["workspaceId", "createdAt"]),

  // --- relation targets (all byWorkspace, so they sync + are membership-scoped) ---
  projects: defineTable({
    localId: v.string(),
    workspaceId: v.string(),
    name: v.string(),
    color: v.string(),
    createdAt: v.number()
  })
    .index("by_localId", ["localId"])
    .index("byWorkspace", ["workspaceId", "createdAt"]),

  comments: defineTable({
    localId: v.string(),
    workspaceId: v.string(),
    issueId: v.string(), // FK -> issues.localId (relation: issue.comments, one-to-many)
    author: v.string(),
    body: v.string(),
    createdAt: v.number()
  })
    .index("by_localId", ["localId"])
    .index("byWorkspace", ["workspaceId", "createdAt"]),

  labels: defineTable({
    localId: v.string(),
    workspaceId: v.string(),
    name: v.string(),
    color: v.string()
  })
    .index("by_localId", ["localId"])
    .index("byWorkspace", ["workspaceId", "name"]),

  // join table for issues <-> labels (relation: issue.labels, many-to-many)
  issue_labels: defineTable({
    localId: v.string(),
    workspaceId: v.string(),
    issueId: v.string(),
    labelId: v.string()
  })
    .index("by_localId", ["localId"])
    .index("byWorkspace", ["workspaceId", "issueId"]),

  // --- Notion-style documents (byWorkspace tree; nesting via parentId) ---
  documents: defineTable({
    localId: v.string(),
    workspaceId: v.string(),
    title: v.string(),
    icon: v.optional(v.string()), // emoji
    parentId: v.optional(v.string()), // FK -> documents.localId (tree; root pages have none)
    position: v.number(), // sibling order
    createdAt: v.number(),
    updatedAt: v.number()
  })
    .index("by_localId", ["localId"])
    .index("byWorkspace", ["workspaceId", "position"]),

  // --- collaborative document content: Yjs updates as INSERT-ONLY rows ---
  // Each row is one base64-encoded Yjs binary update. Yjs updates are commutative
  // + idempotent, so insert-only rows (never patched/deleted) with at-least-once,
  // any-order delivery converge to the same document on every client. This is how
  // a CRDT rides on our append-only local-first log.
  doc_updates: defineTable({
    localId: v.string(),
    workspaceId: v.string(),
    docId: v.string(), // FK -> documents.localId
    update: v.string(), // base64(Yjs update)
    createdAt: v.number()
  })
    .index("by_localId", ["localId"])
    .index("byWorkspace", ["workspaceId", "createdAt"])
    .index("byDoc", ["workspaceId", "docId", "createdAt"]),

  // --- workspace membership (a plain Convex table; the server checks it for I7) ---
  ws_members: defineTable({
    userId: v.string(),
    workspaceId: v.string()
  })
    .index("by_user_ws", ["userId", "workspaceId"])
    .index("by_ws", ["workspaceId"])
});
