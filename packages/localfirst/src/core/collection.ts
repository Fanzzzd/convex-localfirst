import { compareValues } from "./ordering.js";
import { matchesFilter, type FilterSpec } from "./filter.js";
import type { RelationEntry, RelationSpec } from "./relations.js";
import type { RowValue } from "./types.js";

export type LocalQueryGroupKey = string | null;

export type LocalQueryResult<
  Row extends Record<string, unknown>,
  Rel,
  Group extends string = never,
> = [Group] extends [never] ? Array<Row & Rel> : ReadonlyMap<LocalQueryGroupKey, Array<Row & Rel>>;

export type LocalQueryCountResult<Group extends PropertyKey = never> = [Group] extends [never]
  ? number
  : Record<string, number>;

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
export type LocalQueryPlan<
  Row extends Record<string, unknown> = Record<string, unknown>,
  Rel = unknown,
  Group extends string = never,
> = {
  readonly __localFirstQuery: true;
  /**
   * Phantom: carries the `.related()` result shape `Rel` so `useLiveQuery` can
   * infer `Row & Rel` structurally. `Rel` appears in no other member (run() only
   * returns the base `Row[]`), so without this the parameter would be unbindable
   * and silently fall back to `unknown`. Never set at runtime.
   */
  readonly __rel?: Rel;
  /** Phantom carrier for the field selected by `.groupBy()`. */
  readonly __group?: Group;
  readonly table: string;
  /** Scope field values (e.g. { workspaceId }); the engine builds the pull scope. */
  readonly scopeValues?: Record<string, unknown>;
  /** Relations to attach in memory (resolved by the engine across local tables). */
  readonly relations: readonly RelationEntry[];
  /**
   * Declared sort, exposed so the incremental query engine can pick a matching
   * secondary index and maintain a sorted result by binary-search splice. `run`
   * remains the authority for actual filtering/sorting; this is planning metadata.
   * (Named `orderBy`/`rowLimit` to avoid colliding with the `.order()`/`.limit()`
   * chainable builder methods.)
   */
  readonly orderBy?: { readonly field: string; readonly dir: "asc" | "desc" };
  /** Planning metadata for typed roots, whose public `.orderBy()` method occupies
   *  the legacy metadata name. Existing collection plans expose both fields. */
  readonly orderSpec?: { readonly field: string; readonly dir: "asc" | "desc" };
  /** Declared row cap, exposed for incremental maintenance (the sorted result is
   *  kept in full and sliced to this on output). */
  readonly rowLimit?: number;
  /** Number of chained `.where(...)` predicates — part of the structural signature the
   *  React hook keys an incremental subscription on (predicate closures are opaque, so a
   *  changed COUNT is what signals a re-plan). */
  readonly predicateCount?: number;
  /** Serializable filters are planning metadata as well as executable predicates. */
  readonly filters?: readonly FilterSpec[];
  /** Present when `.groupBy(field)` changes the terminal result into a live Map. */
  readonly groupField?: string;
  /** Test a single already-scope-authorized row without applying order/limit. */
  readonly matchesRow?: (row: Record<string, unknown>) => boolean;
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

type Ops<Row extends Record<string, unknown>> = {
  readonly scopeValues?: Record<string, unknown>;
  readonly predicates: ReadonlyArray<(row: Row) => boolean>;
  readonly filters: readonly FilterSpec<Row>[];
  readonly orderKey?: keyof Row;
  readonly orderDir: "asc" | "desc";
  readonly limitN?: number;
  readonly relations: readonly RelationEntry[];
  readonly groupKey?: Extract<keyof Row, string>;
};

/**
 * Chainable, fully-typed client query builder — Zero/TanStack-style ergonomics,
 * Convex-idiomatic. `where` takes a plain typed JS predicate (we refine locally,
 * so no serializable filter DSL is needed); `.related()` attaches related local
 * tables with full type inference. Pass the result to `useLiveQuery`, or run it
 * directly via `engine.runLocalQuery`.
 */
export class LocalQuery<
  Row extends Record<string, unknown> = RowValue,
  Rel = unknown,
  Group extends string = never,
> implements LocalQueryPlan<Row, Rel, Group> {
  readonly __localFirstQuery = true as const;
  /** Phantom carrier for `Rel` (see LocalQueryPlan.__rel) — `declare` ⇒ no runtime field. */
  declare readonly __rel: Rel;
  declare readonly __group: Group;

  constructor(
    readonly table: string,
    private readonly ops: Ops<Row> = {
      predicates: [],
      filters: [],
      orderDir: "asc",
      relations: [],
    },
  ) {}

  /** Narrow to a workspace/project scope (typed to the row's scope fields). */
  scope(values: Partial<Row>): LocalQuery<Row, Rel, Group> {
    return this.with({ scopeValues: values as Record<string, unknown> });
  }

  /** Keep rows matching a serializable, planner-visible typed filter. Chains as AND. */
  filter(filter: FilterSpec<Row>): LocalQuery<Row, Rel, Group> {
    return this.with({ filters: [...this.ops.filters, filter] });
  }

  /** Keep rows matching a typed predicate. Chains as AND. Because closures are
   * opaque to the planner, `.where()` is always evaluated after candidate scanning. */
  where(predicate: (row: Row) => boolean): LocalQuery<Row, Rel, Group> {
    return this.with({ predicates: [...this.ops.predicates, predicate] });
  }

  /** Sort by a field; defaults to ascending. */
  order<K extends keyof Row>(
    field: K,
    direction: "asc" | "desc" = "asc",
  ): LocalQuery<Row, Rel, Group> {
    return this.with({ orderKey: field, orderDir: direction });
  }

  /** Cap the number of rows returned. */
  limit(n: number): LocalQuery<Row, Rel, Group> {
    return this.with({ limitN: n });
  }

  /** Group the terminal live result. Rows inside each group retain `.order()` order. */
  groupBy<Field extends Extract<keyof Row, string>>(field: Field): LocalQuery<Row, Rel, Field> {
    return new LocalQuery<Row, Rel, Field>(this.table, { ...this.ops, groupKey: field });
  }

  /**
   * Attach a related local table under `name`. `one(...)` yields a single row (or
   * undefined); `many(...)`/`manyToMany(...)` yield an array. Fully typed: the
   * result rows become `Row & { [name]: Target | Target[] }`.
   */
  related<Name extends string, Target extends Record<string, unknown>, Many extends boolean>(
    name: Name,
    spec: RelationSpec<Target, Many>,
  ): LocalQuery<
    Row,
    Rel & { [K in Name]: Many extends true ? Target[] : Target | undefined },
    Group
  > {
    return new LocalQuery<
      Row,
      Rel & { [K in Name]: Many extends true ? Target[] : Target | undefined },
      Group
    >(this.table, {
      ...this.ops,
      relations: [...this.ops.relations, { name, spec }],
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
  withRelations<Specs extends Record<string, RelationSpec>>(
    specs: Specs,
  ): LocalQuery<Row, Rel & RelationsResult<Specs>, Group> {
    const entries: RelationEntry[] = Object.keys(specs).map((name) => ({
      name,
      spec: specs[name]!,
    }));
    return new LocalQuery<Row, Rel & RelationsResult<Specs>, Group>(this.table, {
      ...this.ops,
      relations: [...this.ops.relations, ...entries],
    });
  }

  get scopeValues(): Record<string, unknown> | undefined {
    return this.ops.scopeValues;
  }

  get relations(): readonly RelationEntry[] {
    return this.ops.relations;
  }

  /** Planning metadata (see LocalQueryPlan.orderBy). Populated from `.order(...)`. */
  get orderBy(): { readonly field: string; readonly dir: "asc" | "desc" } | undefined {
    return this.ops.orderKey !== undefined
      ? { field: String(this.ops.orderKey), dir: this.ops.orderDir }
      : undefined;
  }

  get orderSpec(): { readonly field: string; readonly dir: "asc" | "desc" } | undefined {
    return this.orderBy;
  }

  /** Planning metadata (see LocalQueryPlan.rowLimit). Populated from `.limit(...)`. */
  get rowLimit(): number | undefined {
    return this.ops.limitN;
  }

  /** Planning metadata (see LocalQueryPlan.predicateCount). */
  get predicateCount(): number {
    return this.ops.predicates.length;
  }

  get filters(): readonly FilterSpec[] {
    return this.ops.filters as readonly FilterSpec[];
  }

  get groupField(): string | undefined {
    return this.ops.groupKey === undefined ? undefined : String(this.ops.groupKey);
  }

  matchesRow(value: Record<string, unknown>): boolean {
    const row = value as Row;
    const scopeValues = this.ops.scopeValues;
    if (scopeValues) {
      for (const key in scopeValues) {
        if ((row as Record<string, unknown>)[key] !== scopeValues[key]) return false;
      }
    }
    return (
      this.ops.filters.every((filter) => matchesFilter(row, filter)) &&
      this.ops.predicates.every((predicate) => predicate(row))
    );
  }

  run(rows: readonly RowValue[]): Row[] {
    let out = (rows as readonly Row[]).filter((row) => this.matchesRow(row));
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

  private with(patch: Partial<Ops<Row>>): LocalQuery<Row, Rel, Group> {
    return new LocalQuery<Row, Rel, Group>(this.table, { ...this.ops, ...patch });
  }
}

/** Start a typed local-first query over a table: `collection<Doc<"issues">>("issues")`. */
export function collection<Row extends Record<string, unknown> = RowValue>(
  table: string,
): LocalQuery<Row> {
  return new LocalQuery<Row>(table);
}
