import { convexToJson, jsonToConvex, v } from "convex/values";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { createDefaultIdFactory } from "@convex-localfirst/core/internal";
import { applyServerWrite, handlePull, handlePush } from "./serverSync.js";
import type { ServerOperation, ServerStore, ServerWriteResult, StoredChange, SyncConfig, ValueCodec } from "./serverSync.js";

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
  /** Normally omitted: `collectTables` carries the version declared in
   *  createLocalFirst({ schemaVersion }) along with the tables config. */
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
  /**
   * How long delivered changes stay in the log before opportunistic GC may prune
   * them (default 30 days). Clients offline longer than this re-bootstrap from
   * current rows instead of replaying history. Pass Infinity to never GC.
   */
  readonly changeRetentionMs?: number;
  /**
   * Per-table row-level read filter WITHIN an authorized scope (e.g. guests only
   * see issues they created). Runs with your ctx, so it can read roles from
   * ctx.db. Applied to bootstrap rows, incremental changes (a row entering
   * visibility arrives as a full-row upsert; one leaving arrives as a delete),
   * and patch/delete writes (can't see → can't touch).
   */
  readonly visibility?: Record<
    string,
    (ctx: AnyCtx, input: { userId: string; row: Record<string, unknown> }) => boolean | Promise<boolean>
  >;
  /**
   * Per-table server-minted insert fields (push AND `serverWriter`, where userId
   * is "server") — e.g. an atomic per-project sequence number read from ctx.db.
   * Runs inside the push transaction (race-free under Convex OCC). Stamped fields
   * must be part of the table's declared shape to sync back to clients.
   */
  readonly serverStamp?: Record<
    string,
    (
      ctx: AnyCtx,
      input: { userId: string; value: Record<string, unknown> }
    ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
  >;
};

/** Trusted server-side writer for local-first tables — the third writer besides
 *  client push and nothing. Call it from an ordinary Convex mutation (activity
 *  fan-out, importer, cron) with that mutation's ctx: rows land in ctx.db AND the
 *  change log, so every client syncs them like any other change. */
export type ServerWriter = {
  insert(table: string, value: Record<string, unknown>, options?: { localId?: string }): Promise<ServerWriteResult>;
  patch(table: string, localId: string, patch: Record<string, unknown>): Promise<ServerWriteResult>;
  remove(table: string, localId: string): Promise<ServerWriteResult>;
};

/** The endpoints local-first clients talk to. Opaque to app code — they are
 *  driven by the client transport / `usePresence`, not called via
 *  `useMutation`/`useQuery`. `serverWriter(ctx)` is the exception: a helper for
 *  YOUR mutations to write local-first tables server-side (see ServerWriter). */
export type SyncFunctions = {
  readonly push: RegisteredMutation<"public", Record<string, unknown>, unknown>;
  readonly pull: RegisteredQuery<"public", Record<string, unknown>, unknown>;
  readonly presence: RegisteredMutation<"public", Record<string, unknown>, unknown>;
  readonly presenceList: RegisteredQuery<"public", Record<string, unknown>, unknown>;
  readonly serverWriter: (ctx: unknown) => ServerWriter;
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
 *   tables: { todos: { scope: { kind: "byUser", field: "ownerId" }, idField: "localId" } }
 * });
 * ```
 */
export function createSyncFunctions(options: CreateSyncFunctionsOptions): SyncFunctions {
  const lf = options.component;
  const changeRetentionMs = options.changeRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
  // The version rides on collectTables' result (declared once, in createLocalFirst).
  const collectedVersion = (options.tables as Record<PropertyKey, unknown>)[
    Symbol.for("convexLocalFirst.schemaVersion")
  ] as number | undefined;
  const config: SyncConfig = {
    schemaVersion: options.schemaVersion ?? collectedVersion ?? 1,
    now: options.now ?? (() => Date.now()),
    tables: options.tables,
    valueCodec
  };

  // visibility / serverStamp hooks take the request's ctx (to read roles/counters
  // from ctx.db) — bind it per request by cloning the affected table configs.
  for (const [optionName, hooks] of [
    ["visibility", options.visibility],
    ["serverStamp", options.serverStamp]
  ] as const) {
    for (const table of Object.keys(hooks ?? {})) {
      if (!(table in config.tables)) {
        throw new Error(`createSyncFunctions: ${optionName} names unknown local-first table "${table}"`);
      }
    }
  }
  const configFor = (ctx: AnyCtx): SyncConfig => {
    if (!options.visibility && !options.serverStamp) {
      return config;
    }
    const tables = { ...config.tables };
    for (const [table, hook] of Object.entries(options.visibility ?? {})) {
      tables[table] = { ...tables[table]!, visibility: (input) => hook(ctx, input) };
    }
    for (const [table, hook] of Object.entries(options.serverStamp ?? {})) {
      tables[table] = { ...tables[table]!, serverStamp: (input) => hook(ctx, input) };
    }
    return { ...config, tables };
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
      async appendChange(change, serverId) {
        return await ctx.runMutation(lf.changes.append, {
          scopeKey: change.scopeKey,
          table: change.table,
          localId: change.localId,
          kind: change.kind,
          dataJson: change.data ? valueCodec.encode(change.data) : undefined,
          patchJson: change.patch ? valueCodec.encode(change.patch) : undefined,
          version: change.version,
          serverTime: change.serverTime,
          opId: change.opId,
          serverId,
          retentionMs: Number.isFinite(changeRetentionMs) ? changeRetentionMs : undefined
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
      async isMember(userId, scopeValue, membershipTable) {
        return await isMember(ctx, { userId, scopeValue, membershipTable });
      }
    };
  }

  // Pull-side store: read-only — the change log, bootstrap reads (rowVersions +
  // app rows via the id map), and membership.
  function pullStore(ctx: AnyCtx): ServerStore {
    const unsupported = () => {
      throw new Error("pull is read-only");
    };
    return {
      async getRow(_table, serverId) {
        return (await ctx.db.get(serverId)) ?? null;
      },
      insertRow: unsupported as never,
      patchRow: unsupported as never,
      deleteRow: unsupported as never,
      getLedger: unsupported as never,
      putLedger: unsupported as never,
      async getServerId(table, localId) {
        return await ctx.runQuery(lf.idMaps.get, { table, localId });
      },
      putIdMap: unsupported as never,
      appendChange: unsupported as never,
      latestChangeVersion: unsupported as never,
      scopeForLocalId: unsupported as never,
      async changesAfter(scopeKey, cursor, limit) {
        const rows = await ctx.runQuery(lf.changes.listAfter, { scopeKey, cursor: cursor ?? undefined, limit });
        return rows.map(storedFromComponent);
      },
      async firstChangeId(scopeKey) {
        return await ctx.runQuery(lf.changes.firstId, { scopeKey });
      },
      async lastChangeId(scopeKey) {
        return await ctx.runQuery(lf.changes.lastId, { scopeKey });
      },
      async rowVersionsByScope(scopeKey, afterRowKey, limit) {
        return await ctx.runQuery(lf.changes.listVersions, { scopeKey, afterRowKey: afterRowKey ?? undefined, limit });
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
    // Legacy field older client bundles still send (was the timestampLww logical
    // clock). Accepted and ignored so their queued offline ops keep pushing.
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
      return await handlePush(pushStore(ctx), configFor(ctx), {
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
      cursors: v.any(),
      bootstrapCursors: v.optional(v.any()),
      doorbell: v.optional(v.boolean())
    },
    handler: async (ctx: AnyCtx, args: any) => {
      const userId = await resolveUserId(ctx, args.userId);
      return await handlePull(pullStore(ctx), configFor(ctx), {
        userId,
        clientId: args.clientId,
        schemaVersion: args.schemaVersion,
        scopes: args.scopes,
        cursors: args.cursors ?? {},
        bootstrapCursors: args.bootstrapCursors ?? undefined,
        doorbell: args.doorbell ?? undefined
      });
    }
  });

  // ---- Presence (ephemeral, never part of the sync log) ---------------------
  // Authorization mirrors pull's scope rules exactly: your own `u:` scope, or a
  // workspace/project you are a member of (isMember decides — I7). scopeKey uses
  // the same format the sync engine uses, so presence rooms line up with scopes.
  async function hasPresenceAccess(ctx: AnyCtx, userId: string, scopeKey: string): Promise<boolean> {
    const sep = scopeKey.indexOf(":");
    const kind = sep === -1 ? scopeKey : scopeKey.slice(0, sep);
    const value = sep === -1 ? "" : scopeKey.slice(sep + 1);
    if (kind === "u") {
      return value === userId;
    }
    if (kind === "byWorkspace" || kind === "byProject") {
      const table = Object.values(options.tables).find((t) => t.scope.kind === kind);
      const membershipTable = (table?.scope as { membershipTable?: string } | undefined)?.membershipTable;
      // NOTE: reading membership INSIDE the query is what makes presenceList
      // reactive to joining — the subscription re-runs when the membership row
      // lands, so a client that heartbeats-then-joins converges on its own.
      return membershipTable !== undefined && (await isMember(ctx, { userId, scopeValue: value, membershipTable }));
    }
    return false;
  }

  const presence = options.mutation({
    args: {
      scopeKey: v.string(),
      clientId: v.string(),
      userId: v.string(),
      data: v.any(),
      leaving: v.optional(v.boolean())
    },
    handler: async (ctx: AnyCtx, args: any) => {
      const userId = await resolveUserId(ctx, args.userId);
      if (!(await hasPresenceAccess(ctx, userId, args.scopeKey))) {
        // Fail SOFT (like the read side): a beat racing ahead of a just-joined
        // membership row is a legitimate startup order, not a bug — dropping it
        // means "invisible until authorized", and the loop retries anyway.
        return null;
      }
      await ctx.runMutation(lf.presence.heartbeat, {
        scopeKey: args.scopeKey,
        clientId: args.clientId,
        userId,
        dataJson: JSON.stringify(args.data ?? {}),
        leaving: args.leaving
      });
      return null;
    }
  });

  const presenceList = options.query({
    args: { scopeKey: v.string(), userId: v.string() },
    handler: async (ctx: AnyCtx, args: any) => {
      const userId = await resolveUserId(ctx, args.userId);
      // Read side fails SOFT: a non-member sees an empty room (not an exception
      // that kills the subscription). The moment membership lands, the reactive
      // read above re-runs and the room fills in.
      if (!(await hasPresenceAccess(ctx, userId, args.scopeKey))) {
        return [];
      }
      const rows = await ctx.runQuery(lf.presence.list, { scopeKey: args.scopeKey });
      return rows.map((row: any) => ({
        clientId: row.clientId,
        userId: row.userId,
        data: JSON.parse(row.dataJson),
        updatedAt: row.updatedAt
      }));
    }
  });

  const newLocalId = createDefaultIdFactory("sv");
  const serverWriter = (ctx: AnyCtx): ServerWriter => {
    const store = pushStore(ctx);
    const cfg = configFor(ctx); // serverStamp applies to server-authored inserts too
    return {
      insert: (table, value, opts) =>
        applyServerWrite(store, cfg, { kind: "insert", table, value, localId: opts?.localId }, () => newLocalId(table)),
      patch: (table, localId, patch) => applyServerWrite(store, cfg, { kind: "patch", table, localId, patch }, () => newLocalId(table)),
      remove: (table, localId) => applyServerWrite(store, cfg, { kind: "delete", table, localId }, () => newLocalId(table))
    };
  };

  return { push, pull, presence, presenceList, serverWriter } as SyncFunctions;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
