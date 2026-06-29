import { many, manyToMany, one } from "@convex-localfirst/react";
import type { Doc, TableNames } from "../../convex/_generated/dataModel";

// DataModel-aware relation helpers: the target Doc type is INFERRED from the
// table-name string (no `one<Doc<"projects">>("projects", …)` repetition), and the
// table name is type-checked against the schema (typos are compile errors).
//
//   issue.project  -> rel.one("projects", "projectId")
//   issue.comments -> rel.many("comments", "issueId")
//   issue.labels   -> rel.manyToMany("labels", "issue_labels", "issueId", "labelId")
//
// A real framework could codegen this next to dataModel; here it lives in the app.
export const rel = {
  one: <T extends TableNames>(table: T, foreignKey: string) => one<Doc<T>>(table, foreignKey),
  many: <T extends TableNames>(table: T, foreignKey: string) => many<Doc<T>>(table, foreignKey),
  manyToMany: <T extends TableNames>(table: T, through: TableNames, localKey: string, targetKey: string) =>
    manyToMany<Doc<T>>(table, through, localKey, targetKey)
};
