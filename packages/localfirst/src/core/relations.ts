import type { RowValue } from "./types.js";

/**
 * Client-side relations for the local query builder. Because sync is scope-based
 * (every authorized row is already on the device), a "join" is just an in-memory
 * association across collections that are already local — no SQL, no extra round
 * trip, reactive through the same store subscription. We do NOT compile relations
 * to a serializable form (Zero/TanStack must, to drive query-driven sync); we
 * resolve them locally, which is simpler and more flexible.
 *
 * Four shapes cover what an app like Linear needs:
 *  - one          issue.project   (issue.projectId -> projects._id)
 *  - many         issue.comments  (comments.issueId -> issue._id)
 *  - manyToMany   issue.labels    (via an issue_labels join table)
 *  - viaIds       issue.labels    (issue.label_ids: string[] -> labels._id — the
 *                 natural pair for a `setFields` id-array, no join table needed)
 */
export type RelationSpec<_Target = unknown, _Many extends boolean = boolean> = {
  readonly kind: "one" | "many" | "manyToMany" | "viaIds";
  readonly table: string;
  /** one: the base row's FK field -> target._id. many: the target row's FK field
   *  -> base._id. viaIds: the base row's id-ARRAY field -> target._id (per entry). */
  readonly foreignKey: string;
  /** manyToMany only: the join table and its two FK fields. */
  readonly through?: string;
  readonly localKey?: string;
  readonly targetKey?: string;
  /** Declared `lf.one(...)` relations use null for a missing target. The legacy
   *  per-query `one(...)` combinator omits this and keeps returning undefined. */
  readonly nullWhenMissing?: true;
};

/** Pure relation descriptors stored by `lf.table({ relations })`. Target row
 * types are intentionally resolved later by `createLocalDb`, once every module
 * (and therefore every target table) is present. */
export type OneRelationDescriptor<
  Table extends string = string,
  ForeignKey extends string = string,
> = {
  readonly kind: "one";
  readonly table: Table;
  readonly foreignKey: ForeignKey;
};

export type ManyRelationDescriptor<Table extends string = string, Via extends string = string> = {
  readonly kind: "many";
  readonly table: Table;
  readonly via: Via;
};

export type BackrefRelationDescriptor<
  Table extends string = string,
  ForeignKey extends string = string,
> = {
  readonly kind: "backref";
  readonly table: Table;
  readonly foreignKey: ForeignKey;
};

export type DeclaredRelationDescriptor =
  | OneRelationDescriptor
  | ManyRelationDescriptor
  | BackrefRelationDescriptor;

export type DeclaredRelations = Readonly<Record<string, DeclaredRelationDescriptor>>;

/** base[foreignKey] === target._id. Returns the single target (or undefined). */
export function one<Target extends Record<string, unknown> = RowValue>(
  table: string,
  foreignKey: string,
): RelationSpec<Target, false> {
  return { kind: "one", table, foreignKey };
}

/** target[foreignKey] === base._id. Returns the matching targets as an array. */
export function many<Target extends Record<string, unknown> = RowValue>(
  table: string,
  foreignKey: string,
): RelationSpec<Target, true> {
  return { kind: "many", table, foreignKey };
}

/** base._id -> through[localKey], through[targetKey] -> target._id. Returns targets. */
export function manyToMany<Target extends Record<string, unknown> = RowValue>(
  table: string,
  through: string,
  localKey: string,
  targetKey: string,
): RelationSpec<Target, true> {
  return { kind: "manyToMany", table, through, localKey, targetKey, foreignKey: "" };
}

/** base[idsField] (an array of target ids) -> targets, in the array's order.
 *  The natural join for a `setFields` id-array (e.g. `label_ids`). */
export function viaIds<Target extends Record<string, unknown> = RowValue>(
  table: string,
  idsField: string,
): RelationSpec<Target, true> {
  return { kind: "viaIds", table, foreignKey: idsField };
}

export type RelationEntry = { readonly name: string; readonly spec: RelationSpec };

/** Every table a set of relations reads from (targets + join tables). */
export function relationTables(relations: readonly RelationEntry[]): string[] {
  const tables = new Set<string>();
  for (const { spec } of relations) {
    tables.add(spec.table);
    if (spec.through) {
      tables.add(spec.through);
    }
  }
  return [...tables];
}

/**
 * Attach related rows to each base row, in memory. `rowsByTable` must hold every
 * relation's target (and `through`) table. Each relation is indexed once, so the
 * whole attach is O(base + targets), not O(base × targets). Pure.
 */
export function attachRelations(
  baseRows: readonly Record<string, unknown>[],
  relations: readonly RelationEntry[],
  rowsByTable: Record<string, readonly RowValue[]>,
): Record<string, unknown>[] {
  if (relations.length === 0) {
    // No relations: hand back the same rows (and their identities) so the React
    // hook's stable-reference optimization holds for the common case.
    return baseRows as Record<string, unknown>[];
  }

  const resolvers = relations.map(({ name, spec }) => {
    const targets = rowsByTable[spec.table] ?? [];
    if (spec.kind === "one") {
      const byId = new Map(targets.map((t) => [t._id, t]));
      return {
        name,
        resolve: (row: Record<string, unknown>) =>
          byId.get(row[spec.foreignKey] as string) ?? (spec.nullWhenMissing ? null : undefined),
      };
    }
    if (spec.kind === "many") {
      const byFk = groupBy(targets, (t) => t[spec.foreignKey]);
      return { name, resolve: (row: Record<string, unknown>) => byFk.get(row._id) ?? [] };
    }
    if (spec.kind === "viaIds") {
      const byId = new Map(targets.map((t) => [t._id, t]));
      return {
        name,
        resolve: (row: Record<string, unknown>) => {
          const ids = row[spec.foreignKey];
          if (!Array.isArray(ids)) return [];
          return ids
            .map((id) => byId.get(id as string))
            .filter((t): t is RowValue => t !== undefined);
        },
      };
    }
    // manyToMany
    const through = rowsByTable[spec.through as string] ?? [];
    const targetIdsByLocal = new Map<unknown, Set<unknown>>();
    for (const link of through) {
      const localId = link[spec.localKey as string];
      let set = targetIdsByLocal.get(localId);
      if (!set) {
        set = new Set();
        targetIdsByLocal.set(localId, set);
      }
      set.add(link[spec.targetKey as string]);
    }
    const byId = new Map(targets.map((t) => [t._id, t]));
    return {
      name,
      resolve: (row: Record<string, unknown>) => {
        const ids = targetIdsByLocal.get(row._id);
        if (!ids) {
          return [];
        }
        return [...ids]
          .map((id) => byId.get(id as string))
          .filter((t): t is RowValue => t !== undefined);
      },
    };
  });

  return baseRows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const { name, resolve } of resolvers) {
      out[name] = resolve(row);
    }
    return out;
  });
}

function groupBy(
  rows: readonly RowValue[],
  key: (row: RowValue) => unknown,
): Map<unknown, RowValue[]> {
  const map = new Map<unknown, RowValue[]>();
  for (const row of rows) {
    const k = key(row);
    let bucket = map.get(k);
    if (!bucket) {
      bucket = [];
      map.set(k, bucket);
    }
    bucket.push(row);
  }
  return map;
}
