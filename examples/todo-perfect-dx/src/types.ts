// Row types are derived straight from the Convex schema — the single source of
// truth. `useQuery(api.issues.list, …)` already infers `Doc<"issues">[]` on its
// own; these aliases are just for the few places the UI names the type, and add
// the optional `_conflict` overlay the engine attaches to a conflicted row.
import type { Doc } from "../convex/_generated/dataModel";
import { rel } from "./convex-localfirst/relations";

export type Todo = Doc<"todos"> & { _conflict?: unknown };
export type Issue = Doc<"issues"> & { _conflict?: unknown };
export type IssueStatus = Doc<"issues">["status"];

// Relations belong to the MODEL, not to each query: declare them once here and
// reuse via `collection<Issue>("issues").withRelations(issueRelations)` anywhere.
// Table names are type-checked + their Doc types inferred (see ./convex-localfirst/relations).
export const issueRelations = {
  project: rel.one("projects", "projectId"), // issue.projectId -> projects
  comments: rel.many("comments", "issueId"), // comments.issueId -> issue (1:N)
  labels: rel.manyToMany("labels", "issue_labels", "issueId", "labelId"), // via join table (N:N)
};
