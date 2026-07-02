import type {
  FunctionName,
  OperationPlan,
  RowValue,
  SyncScope,
  TableName
} from "./types.js";

/**
 * Per-table conflict policy. Only REAL, server-enforced policies live here — declaring one
 * that silently no-ops would be a footgun, so unimplemented options are not offered (they'd
 * be a compile error, not a silent surprise).
 *
 * - `fieldLww` (default): field-level last-writer-wins. Patches are field-scoped deltas, so
 *   concurrent edits to *different* fields both survive; same-field collisions resolve by
 *   arrival order at the server. Free — falls out of `ctx.db.patch` + client replay.
 * - `timestampLww`: same field-level merge, but same-field collisions resolve by the op's
 *   logical timestamp (+ clientId tiebreaker) instead of arrival order — a NEWER edit wins
 *   regardless of arrival, backed by per-field write clocks on the server. The offline-first fix.
 *
 * Orthogonal convergent merges are declared per FIELD, not as a whole-row policy:
 * `setFields` (array add/remove) and `counterFields` (numeric increments). They compose with
 * either policy above (delta fields are exempt from the LWW rule — they never clobber).
 */
export type ConflictPolicyName = "fieldLww" | "timestampLww";

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

export type LocalTableDefinition = {
  readonly table: TableName;
  readonly idField: string;
  readonly scope: ScopeDefinition;
  readonly conflict: ConflictPolicyName;
  readonly indexes: Record<string, readonly string[]>;
  // Array fields merged as SETS (convergent add/remove) instead of last-writer-wins
  // whole-array replace — so concurrent adds to e.g. `label_ids` don't clobber. Opt-in:
  // absent/empty = every field is plain LWW (unchanged behavior). See setMerge.ts.
  readonly setFields?: readonly string[];
  // Numeric fields merged as CONVERGENT COUNTERS (concurrent increments accumulate)
  // instead of last-writer-wins whole-number replace — so concurrent edits to e.g. a
  // `vote_count` don't clobber. Opt-in: absent/empty = plain LWW. See setMerge.ts.
  readonly counterFields?: readonly string[];
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

// These helpers tag a table with a conflict policy — see ConflictPolicyName for what each does.
export function fieldLww(): ConflictPolicyName {
  return "fieldLww";
}

export function timestampLww(): ConflictPolicyName {
  return "timestampLww";
}
