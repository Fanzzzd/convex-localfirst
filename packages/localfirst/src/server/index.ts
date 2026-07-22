import { defineTable, mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import type { RegisteredMutation, RegisteredQuery, TableDefinition } from "convex/server";
import { v } from "convex/values";
import type { ObjectType, PropertyValidators, VFloat64, VString } from "convex/values";
import type { ScopeDefinition } from "../core/index.js";
import { LF_METADATA_KEY } from "../core/internal.js";
import type { ServerTableConfig } from "./serverSync.js";

export * from "./serverSync.js";
export * from "./createSyncFunctions.js";
export * from "./createAttachmentFunctions.js";

// Identity is NOT configured here: this factory only declares local-first tables
// and their spec closures. The server-authoritative user id is resolved at sync
// time by createSyncFunctions (ctx.auth.getUserIdentity, with an opt-in dev
// fallback) — see ./createSyncFunctions.ts.
export type CreateLocalFirstOptions<DefaultIdField extends string> = {
  /** Bump when a local-first table's shape changes incompatibly. Declared HERE
   *  only — it flows to the server sync gate (via collectTables) and to every
   *  client (via the provider's `modules`), where it also namespaces the local
   *  store: bumping it gives each client a clean local DB + a full resync, and
   *  the server rejects ops from clients still on the old version. Default 1. */
  readonly schemaVersion?: number;
  readonly defaults?: {
    readonly idField?: DefaultIdField;
  };
};

/** `true` → auto `createdAt`/`updatedAt`; a tuple names them (e.g. `["created_at",
 *  "updated_at"]`). The fields are added to the table (do not declare them in
 *  `shape`) and stamped automatically on insert (both) and patch (updated). */
export type TimestampsOption = true | readonly [string, string];

type TsFieldNames<Ts> = Ts extends true
  ? "createdAt" | "updatedAt"
  : Ts extends readonly [infer C extends string, infer U extends string]
    ? C | U
    : never;

type PartitionFieldOf<S> = S extends { readonly kind: "byUser"; readonly field: infer F extends string }
  ? F
  : S extends { readonly kind: "byWorkspace"; readonly workspaceIdField: infer F extends string }
    ? F
    : S extends { readonly kind: "byProject"; readonly projectIdField: infer F extends string }
      ? F
      : never;

export type TableOptions<
  Shape extends PropertyValidators,
  IdField extends string,
  Indexes extends Record<string, readonly string[]> = Record<string, readonly string[]>,
  S extends ScopeDefinition = ScopeDefinition,
  Ts extends TimestampsOption | undefined = undefined
> = {
  /** The table's fields (Convex validators) — the ONE place the row shape lives.
   *  `todos.table()` turns it into the Convex table definition (adding the id
   *  field + indexes), and the client runs the same declaration locally. */
  readonly shape: Shape;
  readonly scope: S;
  /** Stable client-generated row id field. Added to the Convex table by `.table()`;
   *  do not declare it in `shape`. Defaults to "localId". */
  readonly idField?: IdField;
  readonly indexes?: Indexes;
  readonly timestamps?: Ts;
  // Array fields merged as SETS (convergent add/remove) instead of whole-array LWW — so
  // concurrent adds to e.g. `label_ids` don't clobber. Opt-in; omit for plain LWW fields.
  readonly setFields?: readonly string[];
  // Numeric fields merged as CONVERGENT COUNTERS (concurrent increments accumulate) instead
  // of whole-number LWW — so concurrent edits to e.g. `vote_count` don't clobber. Opt-in.
  readonly counterFields?: readonly string[];
  // Fields indexed for local full-text search, in priority order (earlier fields rank
  // higher). Client-only: it feeds the incremental inverted index behind `useSearch`. HTML
  // fields (e.g. `description_html`) are tag-stripped before tokenizing. Opt-in; omit for a
  // non-searchable table.
  readonly searchFields?: readonly string[];
};

/** The row type a table's queries return: your shape + the id field + Convex's
 *  system fields. (`_creationTime` is stamped by the server — an optimistic row
 *  carries it only after its first sync.) */
type RowOf<Shape extends PropertyValidators, IdField extends string> = ObjectType<Shape> &
  Record<IdField, string> & { _id: string; _creationTime: number };

// The same lf.table modules are imported by the CLIENT (collectManifest reads the
// attached metadata + closures at runtime — the codegen-free path). In a browser,
// registering real Convex functions is forbidden (convex/server warns and will
// throw), and the client never invokes the export anyway — api.* references are
// proxies. So registration happens only outside the browser (the Convex runtime,
// Node deploys, SSR, tests); in the browser the export is a metadata-only stub.
const IS_BROWSER = typeof window !== "undefined" && typeof document !== "undefined";

function registerFunction<T>(build: () => T): T {
  return IS_BROWSER ? ({} as T) : build();
}

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
// They run on the CLIENT too (optimistically), so they must stay pure — `ctx`
// throws on access outside the server.
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
  // Omit `id` to default the row id to the "id" arg (or one named after the table's
  // idField). Provide it only for a differently-named id arg.
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
  // Omit `id` to default the row id to the "id" arg (see PatchSpec.id).
  readonly id?: (input: { args: ObjectType<A> }) => string;
};

export function createLocalFirst<Ctx = unknown, DefaultIdField extends string = "localId">(
  options: CreateLocalFirstOptions<DefaultIdField> = {}
) {
  return {
    byUser<F extends string>(field: F) {
      return { kind: "byUser", field } as const;
    },
    byWorkspace<F extends string>(input: { workspaceIdField: F; membershipTable: string }) {
      return { kind: "byWorkspace", ...input } as const;
    },
    byProject<F extends string>(input: { projectIdField: F; membershipTable: string }) {
      return { kind: "byProject", ...input } as const;
    },
    table<
      Shape extends PropertyValidators,
      S extends ScopeDefinition,
      IdField extends string = DefaultIdField,
      const Indexes extends Record<string, readonly string[]> = Record<string, readonly string[]>,
      const Ts extends TimestampsOption | undefined = undefined
    >(tableName: string, tableOptions: TableOptions<Shape, IdField, Indexes, S, Ts>) {
      type Row = RowOf<Shape, IdField> & Record<TsFieldNames<Ts>, number>;
      // Derived-args types: what a bare insert()/patch()/remove() accepts. The scope's
      // partition field and the timestamp fields are stamped by the engine, never typed in.
      type DerivedInsertArgs = Omit<
        ObjectType<Shape>,
        (S extends { kind: "byUser" } ? PartitionFieldOf<S> : never) | TsFieldNames<Ts>
      >;
      type DerivedPatchArgs = { id: string } & Partial<Omit<ObjectType<Shape>, PartitionFieldOf<S> | TsFieldNames<Ts>>>;
      const idField = tableOptions.idField ?? options.defaults?.idField ?? "localId";
      const indexes = tableOptions.indexes ?? {};
      const scope: ScopeDefinition = tableOptions.scope;
      const ts = tableOptions.timestamps;
      const tsFields =
        ts === true
          ? { createdAt: "createdAt", updatedAt: "updatedAt" }
          : ts
            ? { createdAt: ts[0], updatedAt: ts[1] }
            : undefined;
      const partitionField =
        scope.kind === "byUser" ? scope.field : scope.kind === "byWorkspace" ? scope.workspaceIdField : scope.projectIdField;
      const metadata = {
        tableName,
        idField,
        scope: tableOptions.scope,
        indexes,
        setFields: tableOptions.setFields,
        counterFields: tableOptions.counterFields,
        searchFields: tableOptions.searchFields,
        timestamps: tsFields,
        // The complete synced surface — what bootstrap may ship (never `extra` columns).
        syncedFields: [
          ...Object.keys(tableOptions.shape),
          ...(tsFields ? [tsFields.createdAt, tsFields.updatedAt] : []),
          idField
        ],
        schemaVersion: options.schemaVersion
      };

      /** Shape minus the given fields, as arg validators. */
      const shapeWithout = (excluded: readonly string[]): PropertyValidators =>
        Object.fromEntries(Object.entries(tableOptions.shape).filter(([field]) => !excluded.includes(field)));
      /** Same, but every validator optional-wrapped (for derived patch args). */
      const optionalized = (fields: PropertyValidators): PropertyValidators =>
        Object.fromEntries(
          Object.entries(fields).map(([field, validator]) => [
            field,
            (validator as { isOptional?: string }).isOptional === "optional" ? validator : v.optional(validator as never)
          ])
        );
      const tsNames = tsFields ? [tsFields.createdAt, tsFields.updatedAt] : [];

      /** The spec a bare insert() means: args = shape minus stamped fields; a byUser owner
       *  comes from auth, timestamps from the engine (collect.ts stamps them). */
      const derivedInsertSpec = (): InsertSpec<PropertyValidators, Ctx> => ({
        args: shapeWithout(scope.kind === "byUser" ? [partitionField, ...tsNames] : tsNames),
        value: ({ auth, args }) =>
          scope.kind === "byUser" ? { ...args, [partitionField]: auth.userId } : { ...args }
      });
      /** The spec a bare patch() means: `id` + every non-partition field, optional. The
       *  default plan forwards present args 1:1 (absent args never clobber). */
      const derivedPatchSpec = (): PatchSpec<PropertyValidators, Ctx> => ({
        args: { id: v.string(), ...optionalized(shapeWithout([partitionField, ...tsNames])) }
      });

      return {
        /**
         * The Convex table definition for `defineSchema` — the schema is DERIVED from
         * this declaration, never restated:
         *
         * ```ts
         * // convex/schema.ts
         * import { todos } from "./todos";
         * export default defineSchema({ todos: todos.table() });
         * ```
         *
         * Adds the id field (`localId: v.string()`) and every declared index. Pass
         * `extra` for server-only fields that exist in Convex but not in the
         * local-first shape (they are never written by the sync engine).
         */
        table(withExtra?: { readonly extra?: PropertyValidators }): TableDefinition<
          // Sound: the runtime object IS shape + the id field + timestamps (+ extra,
          // which stays outside the local-first type surface on purpose).
          ReturnType<typeof v.object<Shape & Record<IdField, VString> & Record<TsFieldNames<Ts>, VFloat64>>>,
          { [K in keyof Indexes]: string[] }
        > {
          const fields = {
            ...tableOptions.shape,
            ...(withExtra?.extra ?? {}),
            ...(tsFields ? { [tsFields.createdAt]: v.number(), [tsFields.updatedAt]: v.number() } : {}),
            [idField]: v.string()
          } as Shape & Record<IdField, VString>;
          let definition = defineTable(fields);
          for (const [name, columns] of Object.entries(indexes)) {
            definition = definition.index(name, columns as never) as typeof definition;
          }
          return definition as never;
        },
        query<A extends PropertyValidators>(spec: QuerySpec<A, Row>): RegisteredQuery<"public", ObjectType<A>, Row[]> {
          const fn = registerFunction(() =>
            query({
              args: spec.args as never,
              handler: async (ctx: unknown, args: ObjectType<A>) =>
                runServerQuery(ctx, tableName, tableOptions.scope, indexes, spec as unknown as QuerySpec<PropertyValidators, unknown>, args)
            })
          );
          // In the browser the export is a metadata stub; on the server, byUser
          // queries EXECUTE (see runServerQuery) and other scopes refuse (G7).
          return attachMetadata(fn, { kind: "query", ...metadata, spec }) as unknown as RegisteredQuery<
            "public",
            ObjectType<A>,
            Row[]
          >;
        },
        /** Omit `spec` to derive it from the shape: args = every field except the
         *  stamped ones (a byUser owner comes from auth; timestamps auto). */
        insert<A extends PropertyValidators = never>(
          spec?: InsertSpec<A, Ctx>
        ): RegisteredMutation<"public", [A] extends [never] ? DerivedInsertArgs : ObjectType<A>, null> {
          const resolved = (spec as InsertSpec<PropertyValidators, Ctx> | undefined) ?? derivedInsertSpec();
          const fn = registerFunction(() =>
            mutation({
              args: resolved.args as never,
              handler: async () => unsupportedLocalFirstCall("insert", tableName)
            })
          );
          return attachMetadata(fn, { kind: "insert", ...metadata, spec: resolved }) as never;
        },
        /** Omit `spec` to derive it: `id` + every non-partition field as an optional
         *  arg, forwarded 1:1 when present (updatedAt stamps automatically). */
        patch<A extends PropertyValidators = never>(
          spec?: PatchSpec<A, Ctx>
        ): RegisteredMutation<"public", [A] extends [never] ? DerivedPatchArgs : ObjectType<A>, null> {
          const resolved = (spec as PatchSpec<PropertyValidators, Ctx> | undefined) ?? derivedPatchSpec();
          const fn = registerFunction(() =>
            mutation({
              args: resolved.args as never,
              handler: async () => unsupportedLocalFirstCall("patch", tableName)
            })
          );
          return attachMetadata(fn, { kind: "patch", ...metadata, spec: resolved }) as never;
        },
        /** Omit `spec` for the default `{ id }` arg. */
        remove<A extends PropertyValidators = never>(
          spec?: RemoveSpec<A>
        ): RegisteredMutation<"public", [A] extends [never] ? { id: string } : ObjectType<A>, null> {
          const resolved = (spec as RemoveSpec<PropertyValidators> | undefined) ?? { args: { id: v.string() } };
          const fn = registerFunction(() =>
            mutation({
              args: resolved.args as never,
              handler: async () => unsupportedLocalFirstCall("remove", tableName)
            })
          );
          return attachMetadata(fn, { kind: "remove", ...metadata, spec: resolved }) as never;
        }
      };
    }
    // I8 "server-only by default" needs no wrapper: a mutation is local-first
    // ONLY if declared via lf.table(...).insert/patch/remove and known to the
    // client manifest. Every other Convex mutation is server-only — it runs
    // through the normal Convex client and never enters the local outbox.
  };
}

/**
 * byUser queries run FOR REAL when invoked server-side (SSR loaders, scripts,
 * `npx convex run`, plain Convex clients): identity comes from ctx.auth and the
 * declared index is walked with the key closure — the same declaration the local
 * engine interprets in the browser. Fail-closed guards keep it exactly as safe
 * as the sync path: the index must lead with the owner field and the key must
 * pin it to the authenticated user, otherwise we refuse rather than leak.
 *
 * byWorkspace/byProject queries still refuse: membership (`access.member`) lives in
 * the sync config, which this standalone handler cannot consult — executing them
 * here would hand rows to any caller who guesses a workspace id.
 */
async function runServerQuery(
  ctx: unknown,
  tableName: string,
  scope: ScopeDefinition,
  indexes: Record<string, readonly string[]>,
  spec: QuerySpec<PropertyValidators, unknown>,
  args: Record<string, unknown>
): Promise<unknown[]> {
  if (scope.kind !== "byUser") {
    unsupportedLocalFirstCall("query", tableName);
  }
  const c = ctx as {
    auth: { getUserIdentity(): Promise<{ tokenIdentifier?: string } | null> };
    db: {
      query(table: string): {
        withIndex(index: string, range: (q: never) => unknown): { order(o: "asc" | "desc"): { collect(): Promise<unknown[]> } };
      };
    };
  };
  const identity = await c.auth.getUserIdentity();
  const userId = identity?.tokenIdentifier;
  if (!userId) {
    throw new Error(
      `convex-localfirst: server-side "${tableName}" query requires an authenticated caller (ctx.auth). ` +
        `In the browser this query is served by the local engine instead.`
    );
  }
  const columns = indexes[spec.index];
  const key = spec.key({ auth: { userId }, args });
  // Fail closed (I7): only run when the walk is provably confined to the caller —
  // the index leads with the owner field and the key pins it to the identity.
  if (!columns || columns[0] !== scope.field || key.length === 0 || key[0] !== userId || key.length > columns.length) {
    unsupportedLocalFirstCall("query", tableName);
  }
  return c.db
    .query(tableName)
    .withIndex(spec.index, (q) =>
      key.reduce<unknown>((acc, value, i) => (acc as { eq(f: string, v: unknown): unknown }).eq(columns[i], value), q)
    )
    .order(spec.order ?? "asc")
    .collect();
}

/**
 * Local-first writes are never executed server-side: they flow through the
 * client (optimistic local) and are synchronized via sync.push / sync.pull. The
 * function still exists in the deployment — the client references it by name and
 * reads its attached metadata — but invoking the handler directly is a bug, so
 * it refuses loudly instead of returning fabricated data (G7: real, or
 * explicitly throw "unsupported").
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
  readonly kind: "query" | "insert" | "patch" | "remove";
  readonly tableName: string;
  readonly idField: string;
  readonly scope: ScopeDefinition;
  readonly timestamps?: { readonly createdAt: string; readonly updatedAt: string };
  readonly syncedFields?: readonly string[];
  readonly searchFields?: readonly string[];
  readonly schemaVersion?: number;
  readonly spec: { readonly args?: Record<string, unknown> };
};

/** Non-enumerable marker on collectTables' result carrying the modules' declared
 *  schemaVersion, so createSyncFunctions picks it up without a second declaration.
 *  Non-enumerable: iterating the tables config must see table names only. */
export const COLLECTED_SCHEMA_VERSION = Symbol.for("convexLocalFirst.schemaVersion");

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
 *   access
 * });
 * ```
 *
 * (The client-side twin is core's `collectManifest` — same modules, same idea.)
 * Throws if two functions of one table carry conflicting config, or if no local-first
 * tables are found.
 */
export function collectTables(modules: Record<string, unknown>): Record<string, ServerTableConfig> {
  const out: Record<string, ServerTableConfig> = {};
  const declaredVersions = new Set<number>();
  for (const [moduleKey, mod] of Object.entries(modules)) {
    if (!mod || (typeof mod !== "object" && typeof mod !== "function")) continue;
    for (const [exportName, exported] of Object.entries(mod as Record<string, unknown>)) {
      const meta = (exported as Record<string, unknown> | null | undefined)?.[LF_METADATA_KEY] as
        | AttachedTableMeta
        | undefined;
      if (!meta || typeof meta.tableName !== "string") continue;
      if (typeof meta.schemaVersion === "number") declaredVersions.add(meta.schemaVersion);
      const base: ServerTableConfig = {
        scope: meta.scope,
        idField: meta.idField,
        ...(meta.timestamps ? { timestamps: meta.timestamps } : {}),
        ...(meta.syncedFields ? { syncedFields: meta.syncedFields } : {})
      };
      const existing = out[meta.tableName];
      if (!existing) {
        out[meta.tableName] = base;
      } else {
        const { mutations: _mutations, ...existingBase } = existing;
        if (JSON.stringify(existingBase) !== JSON.stringify(base)) {
        // Fail closed: a divergent config for the same table can only come from
        // hand-tampering the metadata — never from a single lf.table definition.
          throw new Error(
            `collectTables: conflicting config for table "${meta.tableName}" — every lf.table function for a table must share one definition.`
          );
        }
      }
      if (meta.kind !== "query") {
        const table = out[meta.tableName]!;
        const fields =
          meta.kind === "insert"
            ? [...(meta.syncedFields ?? Object.keys(meta.spec.args ?? {}))]
            : meta.kind === "patch"
              ? [
                  ...Object.keys(meta.spec.args ?? {}).filter((field) => field !== "id" && field !== meta.idField),
                  ...(meta.timestamps ? [meta.timestamps.updatedAt] : [])
                ]
              : [];
        out[meta.tableName] = {
          ...table,
          mutations: {
            ...table.mutations,
            [`${moduleKey}:${exportName}`]: {
              kind: meta.kind === "remove" ? "delete" : meta.kind,
              fields: [...new Set(fields)]
            }
          }
        };
      }
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error(
      "collectTables: no local-first tables found in the provided modules. Import the table modules and pass them, e.g. collectTables({ issues, labels })."
    );
  }
  if (declaredVersions.size > 1) {
    throw new Error(
      `collectTables: modules declare conflicting schemaVersions (${[...declaredVersions].join(", ")}) — declare it once, in createLocalFirst({ schemaVersion }).`
    );
  }
  if (declaredVersions.size === 1) {
    Object.defineProperty(out, COLLECTED_SCHEMA_VERSION, { value: [...declaredVersions][0], enumerable: false });
  }
  return out;
}
