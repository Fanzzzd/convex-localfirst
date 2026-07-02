import { many, manyToMany, one, viaIds } from "@convex-localfirst/react";
import type { Doc, TableNames } from "../../convex/_generated/dataModel";

// DataModel-aware relation helpers: the target Doc type is INFERRED from the
// table-name string and the table name is type-checked against the schema.
//   issue.state  -> rel.one("states", "stateId")
//   issue.labels -> rel.viaIds("labels", "label_ids")   (id-array on the issue row)
export const rel = {
  one: <T extends TableNames>(table: T, foreignKey: string) => one<Doc<T>>(table, foreignKey),
  many: <T extends TableNames>(table: T, foreignKey: string) => many<Doc<T>>(table, foreignKey),
  manyToMany: <T extends TableNames>(table: T, through: TableNames, localKey: string, targetKey: string) =>
    manyToMany<Doc<T>>(table, through, localKey, targetKey),
  viaIds: <T extends TableNames>(table: T, idsField: string) => viaIds<Doc<T>>(table, idsField)
};
