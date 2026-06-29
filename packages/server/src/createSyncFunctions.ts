import { convexToJson, jsonToConvex, v } from "convex/values";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { handlePull, handlePush } from "./serverSync.js";
import type { ServerOperation, ServerStore, StoredChange, SyncConfig, ValueCodec } from "./serverSync.js";

// Lossless Convex-value <-> JSON-string codec for the component's text columns.
// convexToJson/jsonToConvex preserve bigint/bytes/nested-undefined where JSON.stringify
// would throw or change shape; plain JSON values pass through unchanged (back-compatible
// with rows written before this codec existed). Top-level undefined is not a Convex
// value, so it maps to null (call sites only encode present values anyway).
const valueCodec: ValueCodec = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encode: (value) => JSON.stringify(convexToJson((value === undefined ? null : value) as any)),
  decode: (json) => jsonToConvex(JSON.parse(json))
};

// ponytail: a generic sync engine writes arbitrary local-first tables, which
// defeats Convex's per-table `Id`/ctx typing. The Convex ctx and the mounted
// component's function references are therefore untyped *inside* this adapter;
// scope/owner/membership enforcement still happens in serverSync, never here.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyCtx = any;
type ComponentApi = any;

/** App-supplied membership check (the server decides, never the client — I7). */
export type IsMember = (
  ctx: AnyCtx,
  info: { userId: string; scopeValue: string; membershipTable: string }
) => Promise<boolean>;

export type CreateSyncFunctionsOptions = {
  /** `components.convexLocalFirst` from your app's generated api. */
  readonly component: ComponentApi;
  /** `mutation` / `query` from your app's `_generated/server`. */
  readonly mutation: (definition: { args: any; handler: (ctx: AnyCtx, args: any) => any }) => any;
  readonly query: (definition: { args: any; handler: (ctx: AnyCtx, args: any) => any }) => any;
  /** Which app tables are local-first, and how they are scoped. */
  readonly tables: SyncConfig["tables"];
  readonly schemaVersion?: number;
  readonly now?: () => number;
  /** Required if any table is scoped `byWorkspace` / `byProject`. */
  readonly isMember?: IsMember;
  /**
   * UNSAFE. When Convex auth returns no identity, trust the client-supplied
   * `userId` instead of failing closed. Only for a local demo backend with no
   * auth provider — NEVER in production (any client could read another user's
   * data, violating I7). Defaults to false (fail closed).
   */
  readonly devUnsafeAllowClientUserId?: boolean;
};

/** The two endpoints local-first clients talk to. Opaque to app code — they are
 *  driven by the client transport, not called via `useMutation`/`useQuery`. */
export type SyncFunctions = {
  readonly push: RegisteredMutation<"public", Record<string, unknown>, unknown>;
  readonly pull: RegisteredQuery<"public", Record<string, unknown>, unknown>;
};

function storedFromComponent(r: any): StoredChange {
  return {
    changeId: r.changeId,
    scopeKey: r.scopeKey,
    table: r.table,
    localId: r.localId,
    kind: r.kind,
    data: r.dataJson ? (valueCodec.decode(r.dataJson) as Record<string, unknown>) : undefined,
    patch: r.patchJson ? (valueCodec.decode(r.patchJson) as Record<string, unknown>) : undefined,
    version: r.version,
    serverTime: r.serverTime,
    opId: r.opId
  };
}

/**
 * Compose the `push` mutation + `pull` query that local-first clients sync
 * against. App rows go to `ctx.db`; every sync bookkeeping operation is
 * delegated to the mounted component. This replaces ~150 lines of hand-written
 * `ServerStore` wiring with a single call.
 *
 * ```ts
 * export const { push, pull } = createSyncFunctions({
 *   component: components.convexLocalFirst,
 *   mutation, query,
 *   tables: { todos: { scope: { kind: "byUser", field: "ownerId" }, idField: "localId", conflict: "fieldLww" } }
 * });
 * ```
 */
export function createSyncFunctions(options: CreateSyncFunctionsOptions): SyncFunctions {
  const lf = options.component;
  const config: SyncConfig = {
    schemaVersion: options.schemaVersion ?? 1,
    now: options.now ?? (() => Date.now()),
    tables: options.tables,
    valueCodec
  };

  // I7: the pull side resolves ONE membership table per scope kind (scope keys
  // are per-value, shared across every table of that kind). Mixed membership
  // tables within a kind would let a member of one pull another's rows — forbid
  // that ambiguity at config time rather than fail silently insecure.
  for (const kind of ["byWorkspace", "byProject"] as const) {
    const membershipTables = new Set(
      Object.values(options.tables)
        .filter((t) => t.scope.kind === kind)
        .map((t) => (t.scope as { membershipTable: string }).membershipTable)
    );
    if (membershipTables.size > 1) {
      throw new Error(
        `createSyncFunctions: all ${kind} tables must share one membershipTable (found: ${[...membershipTables].join(", ")}). Scope keys are shared per value, so mixed membership tables would cross-authorize reads.`
      );
    }
  }

  const needsMembership = Object.values(options.tables).some(
    (t) => t.scope.kind === "byWorkspace" || t.scope.kind === "byProject"
  );
  const isMember: IsMember =
    options.isMember ??
    (async () => {
      if (needsMembership) {
        throw new Error(
          "createSyncFunctions: a byWorkspace/byProject table requires an `isMember` callback (the server must decide membership — I7)."
        );
      }
      return true;
    });

  // Push-side store: app rows hit ctx.db; all bookkeeping goes to the component.
  function pushStore(ctx: AnyCtx): ServerStore {
    return {
      async getRow(_table, serverId) {
        return (await ctx.db.get(serverId)) ?? null;
      },
      async insertRow(table, data) {
        return await ctx.db.insert(table, data);
      },
      async patchRow(_table, serverId, patch) {
        await ctx.db.patch(serverId, patch);
      },
      async deleteRow(_table, serverId) {
        await ctx.db.delete(serverId);
      },
      async getLedger(userId, opId) {
        return await ctx.runQuery(lf.ops.getByOpId, { userId, opId });
      },
      async putLedger(userId, clientId, op: ServerOperation, entry) {
        await ctx.runMutation(lf.ops.record, {
          userId,
          clientId,
          opId: op.opId,
          schemaVersion: op.schemaVersion,
          functionName: op.functionName,
          table: op.table,
          localId: op.localId,
          status: entry.status,
          argsJson: valueCodec.encode(op.value ?? op.patch ?? {}),
          operationJson: valueCodec.encode(op),
          resultJson: entry.resultJson,
          changesJson: entry.changesJson,
          error: entry.error,
          committedAt: config.now ? config.now() : Date.now()
        });
      },
      async getServerId(table, localId) {
        return await ctx.runQuery(lf.idMaps.get, { table, localId });
      },
      async putIdMap(userId, table, localId, serverId) {
        await ctx.runMutation(lf.idMaps.put, { userId, table, localId, serverId });
      },
      async appendChange(change) {
        return await ctx.runMutation(lf.changes.append, {
          scopeKey: change.scopeKey,
          table: change.table,
          localId: change.localId,
          kind: change.kind,
          dataJson: change.data ? valueCodec.encode(change.data) : undefined,
          patchJson: change.patch ? valueCodec.encode(change.patch) : undefined,
          version: change.version,
          serverTime: change.serverTime,
          opId: change.opId
        });
      },
      async changesAfter(scopeKey, cursor, limit) {
        const rows = await ctx.runQuery(lf.changes.listAfter, { scopeKey, cursor: cursor ?? undefined, limit });
        return rows.map(storedFromComponent);
      },
      async latestChangeVersion(table, localId) {
        return await ctx.runQuery(lf.changes.latestVersion, { table, localId });
      },
      async scopeForLocalId(table, localId) {
        return await ctx.runQuery(lf.changes.scopeForLocal, { table, localId });
      },
      // Per-field write clocks for `timestampLww` tables. clocks is a plain JSON map
      // (field -> {ts, tiebreaker}: number + string), so JSON.stringify/parse is lossless —
      // no valueCodec needed. Absent these two, serverSync rejects a timestamped timestampLww
      // op (loud) rather than silently degrading to arrival-order.
      async getFieldClocks(table, localId) {
        const json = await ctx.runQuery(lf.fieldClocks.get, { table, localId });
        return json ? JSON.parse(json) : {};
      },
      async putFieldClocks(table, localId, clocks) {
        await ctx.runMutation(lf.fieldClocks.put, { table, localId, clocksJson: JSON.stringify(clocks) });
      },
      async isMember(userId, scopeValue, membershipTable) {
        return await isMember(ctx, { userId, scopeValue, membershipTable });
      }
    };
  }

  // Pull-side store: read-only, so only the change log + membership are wired.
  function pullStore(ctx: AnyCtx): ServerStore {
    const unsupported = () => {
      throw new Error("pull is read-only");
    };
    return {
      getRow: unsupported as never,
      insertRow: unsupported as never,
      patchRow: unsupported as never,
      deleteRow: unsupported as never,
      getLedger: unsupported as never,
      putLedger: unsupported as never,
      getServerId: unsupported as never,
      putIdMap: unsupported as never,
      appendChange: unsupported as never,
      latestChangeVersion: unsupported as never,
      scopeForLocalId: unsupported as never,
      async changesAfter(scopeKey, cursor, limit) {
        const rows = await ctx.runQuery(lf.changes.listAfter, { scopeKey, cursor: cursor ?? undefined, limit });
        return rows.map(storedFromComponent);
      },
      async isMember(userId, scopeValue, membershipTable) {
        return await isMember(ctx, { userId, scopeValue, membershipTable });
      }
    };
  }

  const mutationFields = {
    opId: v.string(),
    clientId: v.string(),
    schemaVersion: v.number(),
    functionName: v.string(),
    table: v.string(),
    kind: v.union(v.literal("insert"), v.literal("patch"), v.literal("delete")),
    localId: v.string(),
    value: v.optional(v.any()),
    patch: v.optional(v.any()),
    // The op's logical timestamp (client monotonic clock). Optional — only `timestampLww`
    // tables read it; older clients that omit it fall back to arrival-order LWW.
    timestamp: v.optional(v.number())
  };

  async function resolveUserId(ctx: AnyCtx, fallback: string) {
    // I7: identity comes from auth, never the client. Fail closed when there is
    // no authenticated identity, unless the app explicitly opts into the unsafe
    // demo fallback (a local backend with no auth provider).
    const identity = await ctx.auth.getUserIdentity();
    if (identity?.subject) {
      return identity.subject;
    }
    if (options.devUnsafeAllowClientUserId) {
      return fallback;
    }
    throw new Error(
      "convex-localfirst: no authenticated identity. Configure Convex auth, or set devUnsafeAllowClientUserId: true for a local demo backend (unsafe)."
    );
  }

  const push = options.mutation({
    args: {
      clientId: v.string(),
      userId: v.string(),
      schemaVersion: v.number(),
      mutations: v.array(v.object(mutationFields))
    },
    handler: async (ctx: AnyCtx, args: any) => {
      const userId = await resolveUserId(ctx, args.userId);
      return await handlePush(pushStore(ctx), config, {
        userId,
        clientId: args.clientId,
        schemaVersion: args.schemaVersion,
        mutations: args.mutations
      });
    }
  });

  const pull = options.query({
    args: {
      clientId: v.string(),
      userId: v.string(),
      schemaVersion: v.number(),
      scopes: v.array(v.object({ kind: v.string(), value: v.optional(v.string()) })),
      cursors: v.any()
    },
    handler: async (ctx: AnyCtx, args: any) => {
      const userId = await resolveUserId(ctx, args.userId);
      return await handlePull(pullStore(ctx), config, {
        userId,
        clientId: args.clientId,
        schemaVersion: args.schemaVersion,
        scopes: args.scopes,
        cursors: args.cursors ?? {}
      });
    }
  });

  return { push, pull } as SyncFunctions;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
