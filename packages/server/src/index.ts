import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  GenericSchema,
  RegisteredMutation,
  RegisteredQuery,
  SchemaDefinition,
  TableNamesInDataModel
} from "convex/server";
import type { ObjectType, PropertyValidators } from "convex/values";
import type { ConflictPolicyName, ScopeDefinition } from "@convex-localfirst/core";
import type { ServerTableConfig } from "./serverSync.js";

export * from "./serverSync.js";
export * from "./createSyncFunctions.js";

// Non-enumerable key under which each lf.table fn carries its sync config (scope /
// idField / conflict / …). Shared by attachMetadata (writer) and collectTables
// (reader) so the magic string lives in exactly one place.
const LF_METADATA_KEY = "__convexLocalFirst";

// Identity is NOT configured here: this factory only declares local-first tables
// and their spec closures. The server-authoritative user id is resolved at sync
// time by createSyncFunctions (ctx.auth.getUserIdentity, with an opt-in dev
// fallback) — see ./createSyncFunctions.ts.
export type CreateLocalFirstOptions<Schema extends SchemaDefinition<GenericSchema, boolean>> = {
  readonly schema: Schema;
  readonly defaults?: {
    readonly idField?: string;
    readonly conflict?: ConflictPolicyName;
  };
};

export type TableOptions = {
  readonly scope: ScopeDefinition;
  readonly idField?: string;
  readonly conflict?: ConflictPolicyName;
  readonly indexes?: Record<string, readonly string[]>;
  // Array fields merged as SETS (convergent add/remove) instead of whole-array LWW — so
  // concurrent adds to e.g. `label_ids` don't clobber. Opt-in; omit for plain LWW fields.
  readonly setFields?: readonly string[];
  // Numeric fields merged as CONVERGENT COUNTERS (concurrent increments accumulate) instead
  // of whole-number LWW — so concurrent edits to e.g. `vote_count` don't clobber. Opt-in.
  readonly counterFields?: readonly string[];
};

// Spec shapes are generic over the validator record `A` (so the `args` passed to
// closures — and inferred by the client hooks — are precisely typed) and the
// row type `Row` (so `useQuery` infers the result element type, not `never`).
export type QuerySpec<A extends PropertyValidators, Row> = {
  readonly args: A;
  readonly index: string;
  readonly key: (input: { auth: { userId: string }; args: ObjectType<A> }) => readonly unknown[];
  readonly order?: "asc" | "desc";
  readonly initial?: Row[];
};

// The write closures get a precisely-typed `args` (from the validators) but a
// loose row return: the engine assigns the id field and merges, so forcing every
// caller to restate the full document (incl. system/id fields) would be noise.
export type InsertSpec<A extends PropertyValidators, Ctx> = {
  readonly args: A;
  readonly value: (input: {
    ctx: Ctx;
    auth: { userId: string };
    args: ObjectType<A>;
    now: number;
    localId: string;
  }) => Record<string, unknown>;
};

export type PatchSpec<A extends PropertyValidators, Ctx> = {
  readonly args: A;
  // Omit `id` to default the row id to the table's idField (the arg must then be named
  // after idField, e.g. `id`). Provide it only for a differently-named id arg.
  readonly id?: (input: { args: ObjectType<A> }) => string;
  // Omit `patch` to default to "forward every arg 1:1 except the id arg" — the common
  // "update these fields" case. Provide it to map/rename fields or set computed values
  // (e.g. updated_at: now).
  readonly patch?: (input: {
    ctx: Ctx;
    auth: { userId: string };
    args: ObjectType<A>;
    now: number;
  }) => Record<string, unknown>;
};

export type RemoveSpec<A extends PropertyValidators> = {
  readonly args: A;
  // Omit `id` to default the row id to the table's idField (see PatchSpec.id).
  readonly id?: (input: { args: ObjectType<A> }) => string;
};

export function createLocalFirst<
  Ctx = unknown,
  Schema extends SchemaDefinition<GenericSchema, boolean> = SchemaDefinition<GenericSchema, boolean>
>(options: CreateLocalFirstOptions<Schema>) {
  type DataModel = DataModelFromSchemaDefinition<Schema>;

  return {
    byUser(field: string): ScopeDefinition {
      return { kind: "byUser", field };
    },
    byWorkspace(input: { workspaceIdField: string; membershipTable: string }): ScopeDefinition {
      return { kind: "byWorkspace", ...input };
    },
    byProject(input: { projectIdField: string; membershipTable: string }): ScopeDefinition {
      return { kind: "byProject", ...input };
    },
    fieldLww(): ConflictPolicyName {
      return "fieldLww";
    },
    /** Timestamp-ordered LWW: a scalar field-write carries the op's logical timestamp +
     *  clientId tiebreaker, so a NEWER edit wins regardless of arrival order (the offline-first
     *  fix). Set/counter delta fields stay convergent and are exempt. Requires the bundled
     *  component (or a store implementing get/putFieldClocks). */
    timestampLww(): ConflictPolicyName {
      return "timestampLww";
    },
    table<T extends TableNamesInDataModel<DataModel>>(tableName: T, tableOptions: TableOptions) {
      type Row = DocumentByName<DataModel, T>;
      const idField = tableOptions.idField ?? options.defaults?.idField ?? "localId";
      const conflict = tableOptions.conflict ?? options.defaults?.conflict ?? "fieldLww";
      const metadata = {
        tableName,
        idField,
        conflict,
        scope: tableOptions.scope,
        indexes: tableOptions.indexes ?? {},
        setFields: tableOptions.setFields,
        counterFields: tableOptions.counterFields
      };

      return {
        query<A extends PropertyValidators>(spec: QuerySpec<A, Row>): RegisteredQuery<"public", ObjectType<A>, Row[]> {
          const fn = query({
            args: spec.args as never,
            handler: async () => unsupportedLocalFirstCall("query", tableName)
          });
          // ponytail: the handler throws by design (local-first reads run on the
          // client); the declared return type is what the engine actually
          // delivers, so we assert it here rather than leak `never` to callers.
          return attachMetadata(fn, { kind: "query", ...metadata, spec }) as unknown as RegisteredQuery<
            "public",
            ObjectType<A>,
            Row[]
          >;
        },
        insert<A extends PropertyValidators>(spec: InsertSpec<A, Ctx>): RegisteredMutation<"public", ObjectType<A>, null> {
          const fn = mutation({
            args: spec.args as never,
            handler: async () => unsupportedLocalFirstCall("insert", tableName)
          });
          return attachMetadata(fn, { kind: "insert", ...metadata, spec }) as unknown as RegisteredMutation<
            "public",
            ObjectType<A>,
            null
          >;
        },
        patch<A extends PropertyValidators>(spec: PatchSpec<A, Ctx>): RegisteredMutation<"public", ObjectType<A>, null> {
          const fn = mutation({
            args: spec.args as never,
            handler: async () => unsupportedLocalFirstCall("patch", tableName)
          });
          return attachMetadata(fn, { kind: "patch", ...metadata, spec }) as unknown as RegisteredMutation<
            "public",
            ObjectType<A>,
            null
          >;
        },
        remove<A extends PropertyValidators>(spec: RemoveSpec<A>): RegisteredMutation<"public", ObjectType<A>, null> {
          const fn = mutation({
            args: spec.args as never,
            handler: async () => unsupportedLocalFirstCall("remove", tableName)
          });
          return attachMetadata(fn, { kind: "remove", ...metadata, spec }) as unknown as RegisteredMutation<
            "public",
            ObjectType<A>,
            null
          >;
        }
      };
    }
    // I8 "server-only by default" needs no wrapper: a mutation is local-first
    // ONLY if declared via lf.table(...).insert/patch/remove and present in the
    // manifest. Every other Convex mutation is server-only — it runs through the
    // normal Convex client and never enters the local outbox.
  };
}

/**
 * Local-first table functions are never executed server-side: reads/writes flow
 * through the generated client (optimistic local) and are synchronized via
 * sync.push / sync.pull. The function still exists in the deployment — the client
 * references it by name and codegen introspects its attached metadata — but
 * invoking the handler directly is a bug, so it refuses loudly instead of
 * returning fabricated data (G7: real, or explicitly throw "unsupported").
 */
function unsupportedLocalFirstCall(kind: string, tableName: string): never {
  throw new Error(
    `Local-first ${kind} for "${tableName}" is not directly callable server-side. Call it from the ` +
      `client instead — the React hooks (useMutation/useQuery) or, headless, ` +
      `engine.mutate(api.<module>.<fn>, args) / engine.query(...) — which applies it optimistically and ` +
      `synchronizes via sync.push / sync.pull. (Invoking the server handler directly is always a bug.)`
  );
}

function attachMetadata<T>(value: T, metadata: Record<string, unknown>): T {
  Object.defineProperty(value as object, LF_METADATA_KEY, {
    value: metadata,
    enumerable: false,
    configurable: false
  });
  return value;
}

type AttachedTableMeta = {
  readonly tableName: string;
  readonly idField: string;
  readonly conflict: ConflictPolicyName;
  readonly scope: ScopeDefinition;
};

/**
 * Derive the `createSyncFunctions({ tables })` config from your imported `lf.table`
 * modules, so scope / idField / conflict live in ONE place instead of being restated (and
 * drifting) in `sync.ts`:
 *
 * ```ts
 * import * as issues from "./issues";
 * import * as labels from "./labels";
 * export const { push, pull } = createSyncFunctions({
 *   component: components.convexLocalFirst, mutation, query,
 *   tables: collectTables({ issues, labels }),
 *   isMember
 * });
 * ```
 *
 * Throws if two functions of one table carry conflicting config, or if no local-first
 * tables are found.
 */
export function collectTables(modules: Record<string, unknown>): Record<string, ServerTableConfig> {
  const out: Record<string, ServerTableConfig> = {};
  for (const mod of Object.values(modules)) {
    if (!mod || (typeof mod !== "object" && typeof mod !== "function")) continue;
    for (const exported of Object.values(mod as Record<string, unknown>)) {
      const meta = (exported as Record<string, unknown> | null | undefined)?.[LF_METADATA_KEY] as
        | AttachedTableMeta
        | undefined;
      if (!meta || typeof meta.tableName !== "string") continue;
      const config: ServerTableConfig = { scope: meta.scope, idField: meta.idField, conflict: meta.conflict };
      const existing = out[meta.tableName];
      if (!existing) {
        out[meta.tableName] = config;
      } else if (
        existing.idField !== config.idField ||
        existing.conflict !== config.conflict ||
        JSON.stringify(existing.scope) !== JSON.stringify(config.scope)
      ) {
        // Fail closed: a divergent config for the same table can only come from
        // hand-tampering the metadata — never from a single lf.table definition.
        throw new Error(
          `collectTables: conflicting config for table "${meta.tableName}" — every lf.table function for a table must share one definition.`
        );
      }
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error(
      "collectTables: no local-first tables found in the provided modules. Import the table modules and pass them, e.g. collectTables({ issues, labels })."
    );
  }
  return out;
}
