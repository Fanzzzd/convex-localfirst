import { compareValues } from "./ordering.js";
import type { RelationEntry, RelationSpec } from "./relations.js";
import type { RowValue } from "./types.js";

/**
 * A compiled local-first query plan: a pure where/order/limit refinement over the
 * rows a table already holds locally (its authorized, server-pulled scope), plus
 * optional in-memory relations attached from other local tables. It NEVER reaches
 * unsynced data — local query is refinement, not authorization. The server still
 * decides what syncs into the scope (Invariant I7), so a client predicate/relation
 * can only narrow/join what is already permitted, never widen it.
 *
 * `Row` is the base table row; `Rel` is the shape attached by .related() — the
 * result rows are `Row & Rel`.
 */
export type LocalQueryPlan<Row extends Record<string, unknown> = Record<string, unknown>, Rel = unknown> = {
  readonly __localFirstQuery: true;
  /**
   * Phantom: carries the `.related()` result shape `Rel` so `useLiveQuery` can
   * infer `Row & Rel` structurally. `Rel` appears in no other member (run() only
   * returns the base `Row[]`), so without this the parameter would be unbindable
   * and silently fall back to `unknown`. Never set at runtime.
   */
  readonly __rel?: Rel;
  readonly table: string;
  /** Scope field values (e.g. { workspaceId }); the engine builds the pull scope. */
  readonly scopeValues?: Record<string, unknown>;
  /** Relations to attach in memory (resolved by the engine across local tables). */
  readonly relations: readonly RelationEntry[];
  /** Apply where/order/limit to the base table's live rows. Pure. Relations are
   *  attached afterwards by the engine (they need other tables' rows). */
  run(rows: readonly RowValue[]): Row[];
};

/**
 * The result shape contributed by a named map of relation specs: each key maps
 * to `Target[]` for many/manyToMany, or `Target | undefined` for one. Lets
 * `.withRelations({...})` attach a reusable relation map in one typed call.
 */
export type RelationsResult<Specs extends Record<string, RelationSpec>> = {
  [K in keyof Specs]: Specs[K] extends RelationSpec<infer Target, infer Many>
    ? Many extends true
      ? Target[]
      : Target | undefined
    : never;
};

type Ops<Row> = {
  readonly scopeValues?: Record<string, unknown>;
  readonly predicates: ReadonlyArray<(row: Row) => boolean>;
  readonly orderKey?: keyof Row;
  readonly orderDir: "asc" | "desc";
  readonly limitN?: number;
  readonly relations: readonly RelationEntry[];
};

/**
 * Chainable, fully-typed client query builder — Zero/TanStack-style ergonomics,
 * Convex-idiomatic. `where` takes a plain typed JS predicate (we refine locally,
 * so no serializable filter DSL is needed); `.related()` attaches related local
 * tables with full type inference. Pass the result to `useLiveQuery`, or run it
 * directly via `engine.runLocalQuery`.
 */
export class LocalQuery<Row extends Record<string, unknown> = RowValue, Rel = unknown>
  implements LocalQueryPlan<Row, Rel>
{
  readonly __localFirstQuery = true as const;
  /** Phantom carrier for `Rel` (see LocalQueryPlan.__rel) — `declare` ⇒ no runtime field. */
  declare readonly __rel: Rel;

  constructor(
    readonly table: string,
    private readonly ops: Ops<Row> = { predicates: [], orderDir: "asc", relations: [] }
  ) {}

  /** Narrow to a workspace/project scope (typed to the row's scope fields). */
  scope(values: Partial<Row>): LocalQuery<Row, Rel> {
    return this.with({ scopeValues: values as Record<string, unknown> });
  }

  /** Keep rows matching a typed predicate. Chains as AND. */
  where(predicate: (row: Row) => boolean): LocalQuery<Row, Rel> {
    return this.with({ predicates: [...this.ops.predicates, predicate] });
  }

  /** Sort by a field; defaults to ascending. */
  order<K extends keyof Row>(field: K, direction: "asc" | "desc" = "asc"): LocalQuery<Row, Rel> {
    return this.with({ orderKey: field, orderDir: direction });
  }

  /** Cap the number of rows returned. */
  limit(n: number): LocalQuery<Row, Rel> {
    return this.with({ limitN: n });
  }

  /**
   * Attach a related local table under `name`. `one(...)` yields a single row (or
   * undefined); `many(...)`/`manyToMany(...)` yield an array. Fully typed: the
   * result rows become `Row & { [name]: Target | Target[] }`.
   */
  related<Name extends string, Target extends Record<string, unknown>, Many extends boolean>(
    name: Name,
    spec: RelationSpec<Target, Many>
  ): LocalQuery<Row, Rel & { [K in Name]: Many extends true ? Target[] : Target | undefined }> {
    return new LocalQuery<Row, Rel & { [K in Name]: Many extends true ? Target[] : Target | undefined }>(this.table, {
      ...this.ops,
      relations: [...this.ops.relations, { name, spec }]
    });
  }

  /**
   * Attach a whole map of named relations at once — the lazy path for the common
   * case where relations belong to the model, not the query. Define the map once
   * (next to your row type) and reuse it everywhere:
   *
   *   const issueRelations = {
   *     project: one<Doc<"projects">>("projects", "projectId"),
   *     comments: many<Doc<"comments">>("comments", "issueId"),
   *     labels: manyToMany<Doc<"labels">>("labels", "issue_labels", "issueId", "labelId")
   *   };
   *   collection<Issue>("issues").scope({ workspaceId }).withRelations(issueRelations)
   *
   * Fully typed: result rows become `Row & { project: ...; comments: ...[]; ... }`.
   * Equivalent to chaining `.related(name, spec)` for each entry.
   */
  withRelations<Specs extends Record<string, RelationSpec>>(specs: Specs): LocalQuery<Row, Rel & RelationsResult<Specs>> {
    const entries: RelationEntry[] = Object.keys(specs).map((name) => ({ name, spec: specs[name]! }));
    return new LocalQuery<Row, Rel & RelationsResult<Specs>>(this.table, {
      ...this.ops,
      relations: [...this.ops.relations, ...entries]
    });
  }

  get scopeValues(): Record<string, unknown> | undefined {
    return this.ops.scopeValues;
  }

  get relations(): readonly RelationEntry[] {
    return this.ops.relations;
  }

  run(rows: readonly RowValue[]): Row[] {
    const scopeValues = this.ops.scopeValues;
    let out = (rows as readonly Row[]).filter((row) => {
      if (scopeValues) {
        for (const key in scopeValues) {
          if ((row as Record<string, unknown>)[key] !== scopeValues[key]) return false;
        }
      }
      return this.ops.predicates.every((predicate) => predicate(row));
    });
    if (this.ops.orderKey !== undefined) {
      const key = this.ops.orderKey;
      const direction = this.ops.orderDir === "desc" ? -1 : 1;
      out = [...out].sort((a, b) => compareValues(a[key], b[key]) * direction);
    }
    if (this.ops.limitN !== undefined) {
      out = out.slice(0, Math.max(0, this.ops.limitN));
    }
    return out as Row[];
  }

  private with(patch: Partial<Ops<Row>>): LocalQuery<Row, Rel> {
    return new LocalQuery<Row, Rel>(this.table, { ...this.ops, ...patch });
  }
}

/** Start a typed local-first query over a table: `collection<Doc<"issues">>("issues")`. */
export function collection<Row extends Record<string, unknown> = RowValue>(table: string): LocalQuery<Row> {
  return new LocalQuery<Row>(table);
}
