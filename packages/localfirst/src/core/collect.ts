import { compareValues } from "./ordering.js";
import type {
  LocalFirstManifest,
  LocalMutationDefinition,
  LocalQueryDefinition,
  LocalTableDefinition,
  ScopeDefinition
} from "./manifest.js";
import type { RowValue } from "./types.js";
import type { DeclaredRelations } from "./relations.js";

/**
 * Non-enumerable key under which every `lf.table(...).query/insert/patch/remove`
 * function carries its declaration (table config + the ORIGINAL spec closures).
 * Written by the server DSL (attachMetadata), read here and by the
 * server's collectTables — the magic string lives in exactly one place.
 */
export const LF_METADATA_KEY = "__convexLocalFirst";

type AnyArgs = Record<string, unknown>;
type Auth = { userId: string | null };

/** The runtime view of the spec closures lf.table attached. Loosely typed on
 *  purpose: precise typing lives in the server DSL; here we only execute. */
type SpecMeta = {
  readonly args?: Record<string, unknown>;
  readonly index?: string;
  readonly key?: (input: { auth: Auth; args: AnyArgs }) => readonly unknown[];
  readonly order?: "asc" | "desc";
  readonly initial?: unknown;
  readonly value?: (input: {
    ctx: unknown;
    auth: Auth;
    args: AnyArgs;
    now: number;
    localId: string;
  }) => Record<string, unknown>;
  readonly id?: (input: { args: AnyArgs }) => string;
  readonly patch?: (input: { ctx: unknown; auth: Auth; args: AnyArgs; now: number }) => Record<string, unknown>;
};

export type LocalFirstFunctionMeta = {
  readonly kind: "table" | "query" | "insert" | "patch" | "remove";
  readonly tableName: string;
  readonly idField: string;
  readonly scope: ScopeDefinition;
  readonly indexes: Record<string, readonly string[]>;
  readonly setFields?: readonly string[];
  readonly counterFields?: readonly string[];
  /** Fields fed to the local full-text search index (client-only). See search.ts. */
  readonly searchFields?: readonly string[];
  readonly relations?: DeclaredRelations;
  /** Auto-timestamp field names (lf.table's `timestamps` option). Stamped by the
   *  mutation plans below: insert sets both, patch sets updatedAt. */
  readonly timestamps?: { readonly createdAt: string; readonly updatedAt: string };
  /** Declared once in createLocalFirst({ schemaVersion }); flows to the client
   *  manifest AND the server sync config so the two can never drift. */
  readonly schemaVersion?: number;
  readonly spec: SpecMeta;
};

export type CollectManifestOptions = {
  /** Bump when a local-first table's shape changes incompatibly; the server
   *  gates sync on it (schemaMismatch). Normally declared ONCE in
   *  createLocalFirst({ schemaVersion }) and derived from the modules — this
   *  option overrides. Defaults to 1. */
  readonly schemaVersion?: number;
};

/**
 * Build the client manifest AT RUNTIME from your imported Convex modules — the
 * codegen-free path. Pass the same `lf.table` modules the server's collectTables
 * consumes; function names become `"<moduleKey>:<exportName>"`, so key the record
 * exactly like the Convex module path (`{ todos }` → `todos:list`, nested modules
 * as `{ "tasks/todos": todos }`).
 *
 * The ORIGINAL spec closures run locally (value/patch/key are executed, never
 * parsed), so anything you can write in the DSL works offline — the one rule is
 * that closures stay pure (auth, args, now, localId; `ctx` throws on access).
 */
export function collectManifest(
  modules: Record<string, unknown>,
  options?: CollectManifestOptions
): LocalFirstManifest {
  const tables: Record<string, LocalTableDefinition> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queries: Record<string, LocalQueryDefinition<any, any>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mutations: Record<string, LocalMutationDefinition<any, any>> = {};
  const declaredVersions = new Set<number>();

  for (const [moduleKey, mod] of Object.entries(modules)) {
    if (!mod || (typeof mod !== "object" && typeof mod !== "function")) continue;
    for (const [exportName, exported] of Object.entries(mod as Record<string, unknown>)) {
      const meta = metaOf(exported);
      if (!meta) continue;
      const name = `${moduleKey}:${exportName}`;
      if (typeof meta.schemaVersion === "number") declaredVersions.add(meta.schemaVersion);
      registerTable(tables, meta, name);
      if (meta.kind === "table") {
        continue;
      } else if (meta.kind === "query") {
        queries[name] = interpretQuery(name, meta);
      } else {
        mutations[name] = interpretMutation(name, meta);
      }
    }
  }

  if (Object.keys(tables).length === 0) {
    throw new Error(
      "collectManifest: no local-first functions found. Import your lf.table modules and pass them, e.g. collectManifest({ todos, issues })."
    );
  }
  if (declaredVersions.size > 1) {
    // Two lf factories with different versions would silently gate half the app.
    throw new Error(
      `collectManifest: modules declare conflicting schemaVersions (${[...declaredVersions].join(", ")}) — declare it once, in createLocalFirst({ schemaVersion }).`
    );
  }

  const schemaVersion = options?.schemaVersion ?? [...declaredVersions][0] ?? 1;
  return { schemaVersion, tables, queries, mutations };
}

function metaOf(exported: unknown): LocalFirstFunctionMeta | null {
  const meta = (exported as Record<string, unknown> | null | undefined)?.[LF_METADATA_KEY] as
    | LocalFirstFunctionMeta
    | undefined;
  return meta && typeof meta.tableName === "string" ? meta : null;
}

function registerTable(tables: Record<string, LocalTableDefinition>, meta: LocalFirstFunctionMeta, name: string): void {
  const definition: LocalTableDefinition = {
    table: meta.tableName,
    idField: meta.idField,
    scope: meta.scope,
    indexes: meta.indexes,
    ...(meta.setFields?.length ? { setFields: meta.setFields } : {}),
    ...(meta.counterFields?.length ? { counterFields: meta.counterFields } : {}),
    ...(meta.searchFields?.length ? { searchFields: meta.searchFields } : {}),
    ...(meta.relations && Object.keys(meta.relations).length ? { relations: meta.relations } : {})
  };
  const existing = tables[meta.tableName];
  if (!existing) {
    tables[meta.tableName] = definition;
    return;
  }
  if (JSON.stringify(existing) !== JSON.stringify(definition)) {
    // Fail closed: divergent config for one table can only come from hand-tampered
    // metadata — never from a single lf.table definition.
    throw new Error(
      `collectManifest: conflicting table config for "${meta.tableName}" (seen at "${name}") — every lf.table function for a table must share one definition.`
    );
  }
}

function scopeField(scope: ScopeDefinition): string {
  return scope.kind === "byUser"
    ? scope.field
    : scope.kind === "byWorkspace"
      ? scope.workspaceIdField
      : scope.projectIdField;
}

function interpretQuery(name: string, meta: LocalFirstFunctionMeta): LocalQueryDefinition<AnyArgs, RowValue[]> {
  const spec = meta.spec;
  if (!spec.index || typeof spec.key !== "function") {
    throw new Error(`collectManifest: query "${name}" is missing index/key — declare both in todos.query({...}).`);
  }
  const columns = meta.indexes[spec.index];
  if (!columns) {
    throw new Error(
      `collectManifest: query "${name}" reads index "${spec.index}" but lf.table("${meta.tableName}") does not declare it.`
    );
  }
  const key = spec.key;
  const direction = spec.order === "desc" ? -1 : 1;
  const ownerColumn = meta.scope.kind === "byUser" ? meta.scope.field : null;

  const definition: LocalQueryDefinition<AnyArgs, RowValue[]> = {
    kind: "query",
    name,
    table: meta.tableName,
    initial: (spec.initial as RowValue[]) ?? [],
    run(rows, args, context) {
      const userId = context.userId ?? null;
      const keyValues = key({ auth: { userId }, args });
      const matched = rows.filter((row) =>
        keyValues.every((value, i) => {
          const column = columns[i];
          if (column === undefined) return true; // key longer than index: extra parts can't filter
          // Anonymous/local-only mode has no owner to match (mirrors the engine's
          // filterToScope): skip the owner column instead of matching nothing.
          if (column === ownerColumn && userId === null) return true;
          return row[column] === value;
        })
      );
      const sortColumns = columns.slice(keyValues.length);
      if (sortColumns.length === 0) return matched;
      return [...matched].sort((a, b) => {
        for (const column of sortColumns) {
          const cmp = compareValues(a[column], b[column]);
          if (cmp !== 0) return cmp * direction;
        }
        return 0;
      });
    }
  };
  if (meta.scope.kind === "byWorkspace" || meta.scope.kind === "byProject") {
    // The pull scope value comes from the arg named after the scope field — the
    // same convention the engine's fail-closed guard checks (scopedQueryMissingScope).
    const kind = meta.scope.kind;
    const field = scopeField(meta.scope);
    return {
      ...definition,
      scope: (args) => ({ kind, key: `${kind}:${String(args[field])}`, table: meta.tableName })
    };
  }
  return definition;
}

function interpretMutation(name: string, meta: LocalFirstFunctionMeta): LocalMutationDefinition<AnyArgs> {
  const spec = meta.spec;
  const table = meta.tableName;
  const ts = meta.timestamps;
  if (meta.kind === "insert") {
    const value = spec.value;
    if (typeof value !== "function") {
      throw new Error(`collectManifest: insert "${name}" is missing its value() closure.`);
    }
    return {
      kind: "mutation",
      name,
      table,
      plan(args, ctx) {
        const id = ctx.localId(table);
        const row = value({ ctx: forbiddenCtx(name), auth: { userId: ctx.userId }, args, now: ctx.now, localId: id });
        if (ts) {
          row[ts.createdAt] ??= ctx.now;
          row[ts.updatedAt] ??= ctx.now;
        }
        return { kind: "insert", table, id, value: row };
      }
    };
  }

  const idArg = defaultIdArg(spec, meta.idField, name);
  const resolveId = (args: AnyArgs): string => {
    if (spec.id) return String(spec.id({ args }));
    return String(args[idArg as string]);
  };

  if (meta.kind === "remove") {
    return {
      kind: "mutation",
      name,
      table,
      plan: (args) => ({ kind: "delete", table, id: resolveId(args) })
    };
  }

  const patchClosure = spec.patch;
  return {
    kind: "mutation",
    name,
    table,
    plan(args, ctx) {
      const id = resolveId(args);
      const patch: Record<string, unknown> = {};
      if (patchClosure) {
        const result = patchClosure({ ctx: forbiddenCtx(name), auth: { userId: ctx.userId }, args, now: ctx.now });
        for (const [field, value] of Object.entries(result)) {
          // A partial patch must not clobber fields the caller didn't set: an arg that
          // resolved to `undefined` (absent optional) is skipped. `null` is a real value
          // ("cleared") and still passes through.
          if (value !== undefined) patch[field] = value;
        }
      } else {
        // Default patch: forward every arg 1:1 except the id — the common
        // "update these fields" case. With a custom id() the id arg's NAME is
        // unknowable, so any arg holding the id value is excluded instead.
        for (const [field, value] of Object.entries(args)) {
          if (field === idArg || value === undefined) continue;
          if (idArg === null && value === id) continue;
          patch[field] = value;
        }
      }
      // Auto-timestamp: a patch that changes anything refreshes updatedAt (an
      // explicit value in the patch wins; an empty patch stays a no-op).
      if (ts && Object.keys(patch).length > 0) {
        patch[ts.updatedAt] ??= ctx.now;
      }
      return { kind: "patch", table, id, patch };
    }
  };
}

/** The arg that carries the row id when `id()` is omitted: the arg named "id",
 *  else the one named after the table's idField. FAILS CLOSED when neither exists
 *  and there is no id() — a patch/remove with no id would be meaningless. */
function defaultIdArg(spec: SpecMeta, idField: string, name: string): string | null {
  const argKeys = Object.keys(spec.args ?? {});
  if (argKeys.includes("id")) return "id";
  if (argKeys.includes(idField)) return idField;
  if (spec.id) return null; // explicit id() closure; no default arg needed
  throw new Error(
    `collectManifest: "${name}" omits id() but has neither an "id" arg nor one named "${idField}" (the table's idField). Add id: ({ args }) => args.<field>.`
  );
}

/** Local-first closures run on the client too — there is no server ctx. Touching
 *  it is a bug that would only surface server-side, so it throws loudly here. */
function forbiddenCtx(name: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `${name}: ctx.${String(prop)} is not available — local-first closures run optimistically on the client. Keep value()/patch() pure (auth, args, now, localId).`
        );
      }
    }
  );
}
