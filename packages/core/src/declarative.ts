import { compareValues } from "./ordering.js";
import type { LocalMutationDefinition, LocalQueryDefinition } from "./manifest.js";
import type { JsonValue, RowValue } from "./types.js";

/**
 * Declarative descriptors emitted by codegen. They make the client manifest pure
 * data + generic interpreters (below), so no per-function code is generated and
 * the manifest is browser-safe (no Convex server imports).
 */
export type FieldSource =
  | { readonly from: "arg"; readonly arg: string }
  | { readonly from: "auth" }
  | { readonly from: "now" }
  | { readonly from: "const"; readonly value: JsonValue };

/**
 * How a query derives its pull scope. byUser is omitted (the engine derives it
 * from the authed user); workspace/project scopes name the query arg that holds
 * the scope value (e.g. the workspaceId arg).
 */
export type DeclarativeScope = { readonly kind: "byWorkspace" | "byProject"; readonly valueArg: string };

export type DeclarativeQuery = {
  readonly name: string;
  readonly table: string;
  readonly filters: readonly string[]; // arg field names matched for equality
  readonly orderBy?: string;
  readonly order?: "asc" | "desc";
  readonly initial?: unknown;
  readonly scope?: DeclarativeScope;
};

export type DeclarativeInsert = {
  readonly name: string;
  readonly table: string;
  readonly fields: Record<string, FieldSource>;
};

export type DeclarativePatch = {
  readonly name: string;
  readonly table: string;
  readonly idArg: string;
  readonly fields: Record<string, FieldSource>;
};

export type DeclarativeRemove = {
  readonly name: string;
  readonly table: string;
  readonly idArg: string;
};

function resolveField(
  source: FieldSource,
  args: Record<string, unknown>,
  ctx: { now: number; userId: string | null }
): unknown {
  switch (source.from) {
    case "arg":
      return args[source.arg];
    case "auth":
      return ctx.userId;
    case "now":
      return ctx.now;
    case "const":
      return source.value;
  }
}

export function declarativeQuery(descriptor: DeclarativeQuery): LocalQueryDefinition<Record<string, unknown>, RowValue[]> {
  const definition: LocalQueryDefinition<Record<string, unknown>, RowValue[]> = {
    kind: "query",
    name: descriptor.name,
    table: descriptor.table,
    initial: (descriptor.initial as RowValue[]) ?? [],
    run(rows, args) {
      let out = rows.filter((row) => descriptor.filters.every((field) => row[field] === args[field]));
      if (descriptor.orderBy) {
        const key = descriptor.orderBy;
        const direction = descriptor.order === "desc" ? -1 : 1;
        out = [...out].sort((a, b) => compareValues(a[key], b[key]) * direction);
      }
      return out;
    }
  };
  // Workspace/project queries carry their pull scope so the engine pulls (and the
  // server enforces membership on) the right scope. byUser is derived by the engine.
  if (descriptor.scope) {
    const sc = descriptor.scope;
    return {
      ...definition,
      scope: (args) => ({ kind: sc.kind, key: `${sc.kind}:${String(args[sc.valueArg])}`, table: descriptor.table })
    };
  }
  return definition;
}

export function declarativeInsert(descriptor: DeclarativeInsert): LocalMutationDefinition<Record<string, unknown>> {
  return {
    kind: "mutation",
    name: descriptor.name,
    table: descriptor.table,
    plan(args, ctx) {
      const value: Record<string, unknown> = {};
      for (const [field, source] of Object.entries(descriptor.fields)) {
        value[field] = resolveField(source, args, ctx);
      }
      return { kind: "insert", table: descriptor.table, id: ctx.localId(descriptor.table), value };
    }
  };
}

export function declarativePatch(descriptor: DeclarativePatch): LocalMutationDefinition<Record<string, unknown>> {
  return {
    kind: "mutation",
    name: descriptor.name,
    table: descriptor.table,
    plan(args, ctx) {
      const patch: Record<string, unknown> = {};
      for (const [field, source] of Object.entries(descriptor.fields)) {
        const resolved = resolveField(source, args, ctx);
        // A partial patch must not clobber fields the caller didn't set: skip an arg
        // that resolved to `undefined` (an absent optional arg). This is what lets ONE
        // `update` mutation with all-optional fields act as a generic partial patch
        // (the seam Plane's `patchIssue(Partial<TIssue>)` needs). `null` is a real
        // value (Plane uses it for "cleared") and still passes through.
        if (resolved !== undefined) {
          patch[field] = resolved;
        }
      }
      return { kind: "patch", table: descriptor.table, id: String(args[descriptor.idArg]), patch };
    }
  };
}

export function declarativeRemove(descriptor: DeclarativeRemove): LocalMutationDefinition<Record<string, unknown>> {
  return {
    kind: "mutation",
    name: descriptor.name,
    table: descriptor.table,
    plan(args) {
      return { kind: "delete", table: descriptor.table, id: String(args[descriptor.idArg]) };
    }
  };
}
