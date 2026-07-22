import type {
  FunctionName,
  OperationPlan,
  RowValue,
  SyncScope,
  TableName
} from "./types.js";

export type ScopeDefinition =
  | {
      readonly kind: "byUser";
      readonly field: string;
    }
  | {
      readonly kind: "byWorkspace";
      readonly workspaceIdField: string;
      readonly membershipTable: string;
    }
  | {
      readonly kind: "byProject";
      readonly projectIdField: string;
      readonly membershipTable: string;
    };

// Merge model (there is exactly one, so it is not configurable): field-level
// last-writer-wins. Patches are field-scoped, so concurrent edits to DIFFERENT
// fields both survive; same-field collisions resolve by arrival order at the
// server. Convergent merges are declared per FIELD (`setFields`/`counterFields`)
// and are exempt from the LWW rule — they never clobber.
export type LocalTableDefinition = {
  readonly table: TableName;
  readonly idField: string;
  readonly scope: ScopeDefinition;
  readonly indexes: Record<string, readonly string[]>;
  // Array fields merged as SETS (convergent add/remove) instead of last-writer-wins
  // whole-array replace — so concurrent adds to e.g. `label_ids` don't clobber. Opt-in:
  // absent/empty = every field is plain LWW (unchanged behavior). See setMerge.ts.
  readonly setFields?: readonly string[];
  // Numeric fields merged as CONVERGENT COUNTERS (concurrent increments accumulate)
  // instead of last-writer-wins whole-number replace — so concurrent edits to e.g. a
  // `vote_count` don't clobber. Opt-in: absent/empty = plain LWW. See setMerge.ts.
  readonly counterFields?: readonly string[];
  // Fields fed to the local full-text search index, in priority order (earlier fields
  // weigh more in ranking). Purely a CLIENT concern — the incremental inverted index
  // (search.ts) is built from these and maintained from row deltas. Absent/empty = the
  // table is not searchable (useSearch yields nothing). See search.ts.
  readonly searchFields?: readonly string[];
};

export type LocalQueryContext = {
  readonly now: number;
  /** The engine's authenticated user (null when anonymous) — what `auth.userId`
   *  resolves to when a query's key closure runs locally. */
  readonly userId?: string | null;
};

export type LocalQueryDefinition<TArgs = unknown, TResult = unknown> = {
  readonly kind: "query";
  readonly name: FunctionName;
  readonly table: TableName;
  readonly initial?: TResult;
  readonly scope?: (args: TArgs) => SyncScope;
  readonly run: (rows: readonly RowValue[], args: TArgs, context: LocalQueryContext) => TResult;
};

export type LocalMutationContext = {
  readonly now: number;
  readonly clientId: string;
  readonly userId: string | null;
  readonly localId: (table: TableName) => string;
};

export type LocalMutationDefinition<TArgs = unknown, TResult = unknown> = {
  readonly kind: "mutation";
  readonly name: FunctionName;
  readonly table: TableName;
  readonly serverResult?: TResult;
  readonly plan: (args: TArgs, context: LocalMutationContext) => OperationPlan;
};

export type LocalFirstManifest = {
  readonly schemaVersion: number;
  readonly tables: Record<TableName, LocalTableDefinition>;
  // ponytail: a heterogeneous registry of differently-typed query/mutation defs.
  // Function-arg contravariance makes <unknown,unknown> reject concrete defs, so
  // the container is intentionally <any, any>; per-call generics stay precise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly queries: Record<FunctionName, LocalQueryDefinition<any, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly mutations: Record<FunctionName, LocalMutationDefinition<any, any>>;
};

export function defineLocalFirstManifest<T extends LocalFirstManifest>(manifest: T): T {
  return manifest;
}

export function localTable(definition: LocalTableDefinition): LocalTableDefinition {
  return definition;
}

export function localQuery<TArgs, TResult>(
  definition: LocalQueryDefinition<TArgs, TResult>
): LocalQueryDefinition<TArgs, TResult> {
  return definition;
}

export function localMutation<TArgs, TResult = unknown>(
  definition: LocalMutationDefinition<TArgs, TResult>
): LocalMutationDefinition<TArgs, TResult> {
  return definition;
}

export function byUser(field: string): ScopeDefinition {
  return { kind: "byUser", field };
}

export function byWorkspace(input: {
  workspaceIdField: string;
  membershipTable: string;
}): ScopeDefinition {
  return { kind: "byWorkspace", ...input };
}

export function byProject(input: {
  projectIdField: string;
  membershipTable: string;
}): ScopeDefinition {
  return { kind: "byProject", ...input };
}
