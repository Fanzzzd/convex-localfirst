import type { JsonValue } from "@convex-localfirst/core";
// Declarative descriptor types are internal (manifest interpreters, I13 / GOAL §6).
import type {
  DeclarativeInsert,
  DeclarativePatch,
  DeclarativeQuery,
  DeclarativeRemove,
  FieldSource
} from "@convex-localfirst/core/internal";

type Scope =
  | { kind: "byUser"; field: string }
  | { kind: "byWorkspace"; workspaceIdField: string; membershipTable: string }
  | { kind: "byProject"; projectIdField: string; membershipTable: string };

type DslMeta = {
  kind: "query" | "insert" | "patch" | "remove";
  tableName: string;
  idField: string;
  conflict: string;
  scope: Scope;
  indexes: Record<string, readonly string[]>;
  setFields?: readonly string[];
  counterFields?: readonly string[];
  spec: Record<string, unknown>;
};

export type TableMeta = {
  table: string;
  idField: string;
  conflict: string;
  scope: Scope;
  indexes: Record<string, readonly string[]>;
  setFields?: readonly string[];
  counterFields?: readonly string[];
};

export type ManifestEntry =
  | { type: "query"; tableMeta: TableMeta; descriptor: DeclarativeQuery }
  | { type: "insert"; tableMeta: TableMeta; descriptor: DeclarativeInsert }
  | { type: "patch"; tableMeta: TableMeta; descriptor: DeclarativePatch }
  | { type: "remove"; tableMeta: TableMeta; descriptor: DeclarativeRemove };

// --- Source-based introspection (parses the closure with fn.toString) ---------
// We read how each output field is built rather than executing the closure, so
// wrappers like String()/Boolean()/Number() are handled and nothing is guessed.

/** Split top-level segments of `body` on `delim`, respecting (), {}, [] and quotes. */
function splitTopLevel(body: string, delim: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === quote && body[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (depth === 0 && ch === delim) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** Extract the returned object-literal body (the text between the outer braces). */
function returnedObjectBody(fnSource: string, fnName: string): string {
  const arrow = fnSource.indexOf("=>");
  let body = arrow >= 0 ? fnSource.slice(arrow + 2).trim() : fnSource;
  if (body.startsWith("(")) body = body.slice(1, body.lastIndexOf(")")).trim();
  if (body.startsWith("{") && !body.includes("return")) {
    return body.slice(1, body.lastIndexOf("}"));
  }
  // Block body: take the expression after `return`.
  const ret = body.indexOf("return");
  if (ret >= 0) {
    let expr = body.slice(ret + 6).trim();
    if (expr.endsWith(";")) expr = expr.slice(0, -1).trim();
    if (expr.startsWith("(")) expr = expr.slice(1, expr.lastIndexOf(")")).trim();
    if (expr.startsWith("{")) return expr.slice(1, expr.lastIndexOf("}"));
  }
  throw new Error(`codegen: cannot parse the object returned by "${fnName}".`);
}

/** Classify a single value expression into a FieldSource. */
function classifyExpr(raw: string, fnName: string, field: string): FieldSource {
  let expr = raw.trim();
  const wrap = /^(?:String|Number|Boolean)\((.*)\)$/.exec(expr);
  if (wrap) expr = wrap[1].trim();

  const argDot = /^args\.([A-Za-z_$][\w$]*)$/.exec(expr);
  if (argDot) return { from: "arg", arg: argDot[1] };
  const argIdx = /^args\[\s*['"]([^'"]+)['"]\s*\]$/.exec(expr);
  if (argIdx) return { from: "arg", arg: argIdx[1] };
  if (/^auth\.userId$/.test(expr)) return { from: "auth" };
  if (/^now$/.test(expr)) return { from: "now" };

  if (expr === "true") return { from: "const", value: true };
  if (expr === "false") return { from: "const", value: false };
  if (expr === "null") return { from: "const", value: null };
  if (/^-?\d+(\.\d+)?$/.test(expr)) return { from: "const", value: Number(expr) };
  const str = /^['"](.*)['"]$/.exec(expr);
  if (str) return { from: "const", value: str[1] as JsonValue };

  throw new Error(
    `codegen: field "${field}" in "${fnName}" uses an unsupported expression \`${raw.trim()}\` — use a literal, args.x, auth.userId, or now.`
  );
}

function parseFields(fnSource: string, fnName: string): Record<string, FieldSource> {
  const body = returnedObjectBody(fnSource, fnName);
  const fields: Record<string, FieldSource> = {};
  for (const pair of splitTopLevel(body, ",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue; // trailing comma / empty segment
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      // Shorthand ({ x }), spread ({ ...args }), or a method can't be statically
      // mapped to a FieldSource. FAIL CLOSED — silently skipping would emit a manifest
      // missing fields, which then pushes wrong/empty values to the server.
      throw new Error(
        `codegen: field segment \`${trimmed}\` in "${fnName}" is not a "key: expr" pair. ` +
          `Shorthand, spread (...), and methods are unsupported — write explicit "field: args.x" entries.`
      );
    }
    const rawKey = trimmed.slice(0, colon).trim();
    if (rawKey.startsWith("[") || rawKey.includes("(")) {
      throw new Error(`codegen: computed/method key \`${rawKey}\` in "${fnName}" is unsupported — use a static field name.`);
    }
    const key = rawKey.replace(/^['"]|['"]$/g, "");
    fields[key] = classifyExpr(trimmed.slice(colon + 1), fnName, key);
  }
  return fields;
}

function idArgOf(idFn: unknown, fnName: string): string {
  const source = String(idFn);
  const arrow = source.indexOf("=>");
  let expr = arrow >= 0 ? source.slice(arrow + 2).trim() : source;
  if (expr.endsWith(";")) expr = expr.slice(0, -1).trim();
  const wrap = /^(?:String|Number)\((.*)\)$/.exec(expr);
  if (wrap) expr = wrap[1].trim();
  const m = /^args\.([A-Za-z_$][\w$]*)$/.exec(expr) ?? /^args\[\s*['"]([^'"]+)['"]\s*\]$/.exec(expr);
  if (m) return m[1];
  throw new Error(`codegen: cannot determine the id arg for "${fnName}" (id() must return args.<field>).`);
}

/** The id arg from an explicit `id()` closure, or — when omitted — by convention: the arg
 *  named "id" (the dominant REST-y convention; note the id ARG and the row idField are
 *  different axes), else the arg named after the table's idField. FAILS CLOSED if neither
 *  exists: defaulting to a non-existent arg would emit a descriptor whose patch/remove has
 *  no id at runtime, so demand an explicit id(). */
function idArgOrDefault(spec: Record<string, unknown>, idField: string, fnName: string): string {
  if (spec.id) return idArgOf(spec.id, fnName);
  const argKeys = Object.keys((spec.args as Record<string, unknown>) ?? {});
  if (argKeys.includes("id")) return "id";
  if (argKeys.includes(idField)) return idField;
  throw new Error(
    `codegen: "${fnName}" omits id() but has neither an "id" arg nor one named "${idField}" (the table's idField). ` +
      `Add id: ({ args }) => args.<field>.`
  );
}

/** Default patch when `patch()` is omitted: forward every declared arg 1:1 (field === arg
 *  name) EXCEPT the id arg (you never patch the id). This is the common "update these
 *  fields" case; a table that also sets computed fields (e.g. updated_at: now) writes an
 *  explicit patch() instead. */
function defaultPatchFields(spec: Record<string, unknown>, idArg: string): Record<string, FieldSource> {
  const fields: Record<string, FieldSource> = {};
  for (const key of Object.keys((spec.args as Record<string, unknown>) ?? {})) {
    if (key === idArg) continue;
    fields[key] = { from: "arg", arg: key };
  }
  return fields;
}

function scopeField(scope: Scope): string | undefined {
  if (scope.kind === "byUser") return scope.field;
  if (scope.kind === "byWorkspace") return scope.workspaceIdField;
  if (scope.kind === "byProject") return scope.projectIdField;
  return undefined;
}

function tableMetaOf(meta: DslMeta): TableMeta {
  return {
    table: meta.tableName,
    idField: meta.idField,
    conflict: meta.conflict,
    scope: meta.scope,
    indexes: meta.indexes,
    setFields: meta.setFields,
    counterFields: meta.counterFields
  };
}

/** Introspect one module's exports into manifest entries. Names become "moduleName:exportName". */
export function introspectExports(moduleName: string, exports: Record<string, unknown>): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const [exportName, value] of Object.entries(exports)) {
    const meta = (value as { __convexLocalFirst?: DslMeta } | null)?.__convexLocalFirst;
    if (!meta) continue;
    const name = `${moduleName}:${exportName}`;
    const tableMeta = tableMetaOf(meta);
    const spec = meta.spec;

    if (meta.kind === "query") {
      const argKeys = Object.keys((spec.args as Record<string, unknown>) ?? {});
      const indexCols = (meta.indexes[String(spec.index)] ?? []) as readonly string[];
      const sortField = indexCols.find((c) => c !== scopeField(meta.scope) && !argKeys.includes(c));
      entries.push({
        type: "query",
        tableMeta,
        descriptor: {
          name,
          table: meta.tableName,
          filters: argKeys,
          orderBy: sortField,
          order: (spec.order as "asc" | "desc") ?? "asc",
          initial: spec.initial,
          // Workspace/project queries carry their pull scope (value comes from the
          // arg named after the scope field). byUser is derived by the engine.
          scope:
            meta.scope.kind === "byWorkspace"
              ? { kind: "byWorkspace", valueArg: meta.scope.workspaceIdField }
              : meta.scope.kind === "byProject"
                ? { kind: "byProject", valueArg: meta.scope.projectIdField }
                : undefined
        }
      });
    } else if (meta.kind === "insert") {
      entries.push({
        type: "insert",
        tableMeta,
        descriptor: { name, table: meta.tableName, fields: parseFields(String(spec.value), name) }
      });
    } else if (meta.kind === "patch") {
      const idArg = idArgOrDefault(spec, meta.idField, name);
      entries.push({
        type: "patch",
        tableMeta,
        descriptor: {
          name,
          table: meta.tableName,
          idArg,
          fields: spec.patch ? parseFields(String(spec.patch), name) : defaultPatchFields(spec, idArg)
        }
      });
    } else if (meta.kind === "remove") {
      entries.push({
        type: "remove",
        tableMeta,
        descriptor: { name, table: meta.tableName, idArg: idArgOrDefault(spec, meta.idField, name) }
      });
    }
  }
  return entries;
}

const BUILDER = {
  query: "declarativeQuery",
  insert: "declarativeInsert",
  patch: "declarativePatch",
  remove: "declarativeRemove"
} as const;

/** Emit a browser-safe manifest module (pure data + generic interpreters). */
export function emitManifestSource(schemaVersion: number, entries: readonly ManifestEntry[]): string {
  const tables = new Map<string, TableMeta>();
  for (const entry of entries) tables.set(entry.tableMeta.table, entry.tableMeta);

  const tableLines = [...tables.values()].map(
    (t) =>
      `    ${JSON.stringify(t.table)}: localTable(${JSON.stringify({
        table: t.table,
        idField: t.idField,
        scope: t.scope,
        conflict: t.conflict,
        indexes: t.indexes,
        // Only emitted when declared, so tables without set/counter fields stay byte-identical.
        ...(t.setFields && t.setFields.length ? { setFields: t.setFields } : {}),
        ...(t.counterFields && t.counterFields.length ? { counterFields: t.counterFields } : {})
      })})`
  );

  const queryLines = entries
    .filter((e) => e.type === "query")
    .map((e) => `    ${JSON.stringify(e.descriptor.name)}: declarativeQuery(${JSON.stringify(e.descriptor)})`);

  const mutationLines = entries
    .filter((e) => e.type !== "query")
    .map((e) => `    ${JSON.stringify(e.descriptor.name)}: ${BUILDER[e.type]}(${JSON.stringify(e.descriptor)})`);

  return `// GENERATED by convex-localfirst codegen. Do not edit by hand.
import { defineLocalFirstManifest, localTable } from "@convex-localfirst/core";
// Manifest interpreters are internal (I13 / GOAL §6 "no manifest interpreters" in the
// public surface); generated code is a legitimate internal consumer of them.
import {
  declarativeInsert,
  declarativePatch,
  declarativeQuery,
  declarativeRemove
} from "@convex-localfirst/core/internal";

export const localFirstManifest = defineLocalFirstManifest({
  schemaVersion: ${schemaVersion},
  tables: {
${tableLines.join(",\n")}
  },
  queries: {
${queryLines.join(",\n")}
  },
  mutations: {
${mutationLines.join(",\n")}
  }
});
`;
}
