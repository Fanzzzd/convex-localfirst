import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { comments } from "./comments";
import { docUpdates } from "./docUpdates";
import { documents } from "./documents";
import { issues } from "./issues";
import { issueLabels, labels } from "./labels";
import { projects } from "./projects";
import { todos } from "./todos";

// The schema is DERIVED from the lf.table declarations — each .table() call adds
// the localId field + the declared indexes, so a table's shape lives in exactly
// one place (its module). All local-first sync bookkeeping (ledger / change log /
// id map / row versions) lives in the mounted convex-localfirst/component.
export default defineSchema({
  todos: todos.table(),
  issues: issues.table(),
  projects: projects.table(),
  comments: comments.table(),
  labels: labels.table(),
  issue_labels: issueLabels.table(),
  documents: documents.table(),
  doc_updates: docUpdates.table(),

  // --- workspace membership (a plain Convex table; the server checks it for I7) ---
  ws_members: defineTable({
    userId: v.string(),
    workspaceId: v.string(),
  })
    .index("by_user_ws", ["userId", "workspaceId"])
    .index("by_ws", ["workspaceId"]),
});
