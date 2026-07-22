import { convexToJson, jsonToConvex, v } from "convex/values";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { createDefaultIdFactory } from "../core/internal.js";
import { applyServerWrite, handlePull, handlePush } from "./serverSync.js";
import type {
  ServerOperation,
  ServerStore,
  ServerWriteResult,
  StoredChange,
  SyncConfig,
  ValueCodec,
} from "./serverSync.js";

// Lossless Convex-value <-> JSON-string codec for the component's text columns.
// convexToJson/jsonToConvex preserve bigint/bytes/nested-undefined where JSON.stringify
// would throw or change shape; plain JSON values pass through unchanged (back-compatible
// with rows written before this codec existed). Top-level undefined is not a Convex
// value, so it maps to null (call sites only encode present values anyway).
const valueCodec: ValueCodec = {
  encode: (value) => JSON.stringify(convexToJson((value === undefined ? null : value) as any)),
  decode: (json) => jsonToConvex(JSON.parse(json)),
};

// A generic sync engine writes arbitrary local-first tables, which
// defeats Convex's per-table `Id`/ctx typing. The Convex ctx and the mounted
// component's function references are therefore untyped *inside* this adapter;
// scope/owner/membership enforcement still happens in serverSync, never here.
type AnyCtx = any;
type ComponentApi = any;

export type AccessConfig<
  Role = unknown,
  Row extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly member: (
    ctx: AnyCtx,
    args: { userId: string; scopeValue: string; table: string; membershipTable?: string },
  ) => Role | null | undefined | Promise<Role | null | undefined>;
  readonly read?: (
    ctx: AnyCtx,
    args: { userId: string; role: Role; table: string; row: Row },
  ) => boolean | Promise<boolean>;
  readonly write?: (
    ctx: AnyCtx,
    args: {
      userId: string;
      role: Role;
      table: string;
      action: "insert" | "patch" | "delete";
      before: Row | null;
      patch?: Record<string, unknown>;
      proposed: Row | null;
    },
  ) => boolean | Promise<boolean>;
};

export type ServerStampConfig = {
  /** The complete set of fields this hook may return. These fields are rejected
   *  from every client insert/patch before the hook runs. */
  readonly fields: readonly string[];
  readonly stamp: (
    ctx: AnyCtx,
    input: { userId: string; value: Record<string, unknown> },
  ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
};

export type CreateSyncFunctionsOptions<
  Role = unknown,
  Row extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** `components.convexLocalFirst` from your app's generated api. */
  readonly component: ComponentApi;
  /** `mutation` / `query` from your app's `_generated/server`. */
  readonly mutation: (definition: { args: any; handler: (ctx: AnyCtx, args: any) => any }) => any;
  /** Pass Convex's `internalMutation` to expose `gc` as an internal cron target.
   *  Falls back to `mutation` for adapters/tests that do not distinguish them. */
  readonly internalMutation?: (definition: {
    args: any;
    handler: (ctx: AnyCtx, args: any) => any;
  }) => any;
  readonly query: (definition: { args: any; handler: (ctx: AnyCtx, args: any) => any }) => any;
  /** Which app tables are local-first, and how they are scoped. */
  readonly tables: SyncConfig["tables"];
  /** Normally omitted: `collectTables` carries the version declared in
   *  createLocalFirst({ schemaVersion }) along with the tables config. */
  readonly schemaVersion?: number;
  readonly now?: () => number;
  /** Required if any table is scoped `byWorkspace` / `byProject`. */
  readonly access?: AccessConfig<Role, Row>;
  /** Override the default authenticated id (`identity.tokenIdentifier`). */
  readonly getUserId?: (ctx: AnyCtx) => string | null | Promise<string | null>;
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
   * Per-table server-minted insert fields (push AND `serverWriter`, where userId
   * is "server") — e.g. an atomic per-project sequence number read from ctx.db.
   * Runs inside the push transaction (race-free under Convex OCC). Stamped fields
   * must be part of the table's declared shape to sync back to clients.
   */
  readonly serverStamp?: Record<string, ServerStampConfig>;
  /** Runs transactionally once for each first-accepted client write and each
   *  serverWriter write. Ledger replay never re-fires it. */
  readonly onWrite?: (
    ctx: AnyCtx,
    args: {
      table: string;
      action: "insert" | "patch" | "delete";
      before: Row | null;
      after: Row | null;
      userId: string;
      functionName: string;
    },
  ) => Promise<void>;
};

/** Trusted server-side writer for local-first tables — the third writer besides
 *  client push and nothing. Call it from an ordinary Convex mutation (activity
 *  fan-out, importer, cron) with that mutation's ctx: rows land in ctx.db AND the
 *  change log, so every client syncs them like any other change. */
export type ServerWriter = {
  insert(
    table: string,
    value: Record<string, unknown>,
    options?: { localId?: string },
  ): Promise<ServerWriteResult>;
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
  readonly gc:
    | RegisteredMutation<"internal", Record<string, unknown>, unknown>
    | RegisteredMutation<"public", Record<string, unknown>, unknown>;
  readonly serverWriter: (ctx: unknown, userId?: string) => ServerWriter;
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
    opId: r.opId,
  };
}

/**
 * The shared server-sync primitives — config, request-bound config, the writable
 * push-side store, identity resolution, and the trusted serverWriter — built once
 * from the sync options. Both `createSyncFunctions` and `createAttachmentFunctions`
 * consume this, so attachments reuse the SAME authz + serverWriter plumbing instead
 * of duplicating scope/membership checks.
 */
export type SyncCore<
  _Role = unknown,
  _Row extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly config: SyncConfig;
  readonly configFor: (ctx: AnyCtx) => SyncConfig;
  readonly pushStore: (ctx: AnyCtx) => ServerStore;
  readonly resolveUserId: (ctx: AnyCtx, fallback: string) => Promise<string>;
  readonly serverWriter: (ctx: AnyCtx, actingUserId?: string) => ServerWriter;
  readonly newLocalId: (table: string) => string;
  readonly changeRetentionMs: number;
};

export function buildSyncCore<
  Role = unknown,
  Row extends Record<string, unknown> = Record<string, unknown>,
>(options: CreateSyncFunctionsOptions<Role, Row>): SyncCore<Role, Row> {
  const lf = options.component;
  const changeRetentionMs = options.changeRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
  const collectedVersion = (options.tables as Record<PropertyKey, unknown>)[
    Symbol.for("convexLocalFirst.schemaVersion")
  ] as number | undefined;
  const tables = { ...options.tables };
  const config: SyncConfig = {
    schemaVersion: options.schemaVersion ?? collectedVersion ?? 1,
    now: options.now ?? (() => Date.now()),
    tables,
    valueCodec,
  };

  for (const [table, stamp] of Object.entries(options.serverStamp ?? {})) {
    const tableConfig = tables[table];
    if (!tableConfig) {
      throw new Error(
        `createSyncFunctions: serverStamp names unknown local-first table "${table}"`,
      );
    }
    const partition =
      tableConfig.scope.kind === "byUser"
        ? tableConfig.scope.field
        : tableConfig.scope.kind === "byWorkspace"
          ? tableConfig.scope.workspaceIdField
          : tableConfig.scope.projectIdField;
    for (const field of stamp.fields) {
      if (field === tableConfig.idField || field === partition) {
        throw new Error(
          `createSyncFunctions: serverStamp field "${field}" cannot be an id/scope field`,
        );
      }
      if (tableConfig.syncedFields && !tableConfig.syncedFields.includes(field)) {
        throw new Error(
          `createSyncFunctions: serverStamp field "${field}" is not a synced field of "${table}"`,
        );
      }
    }
    tables[table] = { ...tableConfig, serverOnlyFields: [...new Set(stamp.fields)] };
  }

  const configFor = (ctx: AnyCtx): SyncConfig => {
    if (!options.access && !options.serverStamp && !options.onWrite) {
      return config;
    }
    const boundTables = { ...config.tables };
    for (const [table, hook] of Object.entries(options.serverStamp ?? {})) {
      boundTables[table] = {
        ...boundTables[table]!,
        serverStamp: (input) => hook.stamp(ctx, input),
      };
    }
    return {
      ...config,
      tables: boundTables,
      access: options.access
        ? {
            member: (input) => options.access!.member(ctx, input),
            read: options.access.read
              ? (input) => options.access!.read!(ctx, input as never)
              : undefined,
            write: options.access.write
              ? (input) => options.access!.write!(ctx, input as never)
              : undefined,
          }
        : undefined,
      onWrite: options.onWrite ? (input) => options.onWrite!(ctx, input as never) : undefined,
    };
  };

  // I7: one membership table per scope kind (scope keys are shared per value).
  for (const kind of ["byWorkspace", "byProject"] as const) {
    const membershipTables = new Set(
      Object.values(options.tables)
        .filter((t) => t.scope.kind === kind)
        .map((t) => (t.scope as { membershipTable: string }).membershipTable),
    );
    if (membershipTables.size > 1) {
      throw new Error(
        `createSyncFunctions: all ${kind} tables must share one membershipTable (found: ${[...membershipTables].join(", ")}). Scope keys are shared per value, so mixed membership tables would cross-authorize reads.`,
      );
    }
  }

  const needsMembership = Object.values(options.tables).some(
    (t) => t.scope.kind === "byWorkspace" || t.scope.kind === "byProject",
  );
  if (needsMembership && !options.access) {
    throw new Error(
      "createSyncFunctions: access.member is required when any table uses a byWorkspace/byProject membership scope.",
    );
  }

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
        const row = await ctx.runQuery(lf.ops.getByOpId, { userId, opId });
        return row
          ? {
              schemaVersion: row.schemaVersion,
              status: row.status,
              error: row.error,
              changes: row.changesJson
                ? (valueCodec.decode(row.changesJson) as StoredChange[])
                : undefined,
            }
          : null;
      },
      async commitOp(userId, op: ServerOperation, entry, change, serverId) {
        const committed = await ctx.runMutation(lf.changes.commitOp, {
          userId,
          opId: op.opId,
          schemaVersion: op.schemaVersion,
          status: entry.status,
          error: entry.error,
          committedAt: config.now ? config.now() : Date.now(),
          change: change
            ? {
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
              }
            : undefined,
          retentionMs: Number.isFinite(changeRetentionMs) ? changeRetentionMs : undefined,
        });
        return committed.change ? storedFromComponent(committed.change) : null;
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
          retentionMs: Number.isFinite(changeRetentionMs) ? changeRetentionMs : undefined,
        });
      },
      async changesAfter(scopeKey, cursor, limit) {
        const rows = await ctx.runQuery(lf.changes.listAfter, {
          scopeKey,
          cursor: cursor ?? undefined,
          limit,
        });
        return rows.map(storedFromComponent);
      },
      async latestChangeVersion(table, localId) {
        return await ctx.runQuery(lf.changes.latestVersion, { table, localId });
      },
      async scopeForLocalId(table, localId) {
        return await ctx.runQuery(lf.changes.scopeForLocal, { table, localId });
      },
    };
  }

  async function resolveUserId(ctx: AnyCtx, fallback: string) {
    const resolved = options.getUserId
      ? await options.getUserId(ctx)
      : (await ctx.auth.getUserIdentity())?.tokenIdentifier;
    if (resolved) {
      return resolved;
    }
    if (options.devUnsafeAllowClientUserId) {
      return fallback;
    }
    throw new Error(
      "convex-localfirst: no authenticated identity. Configure Convex auth, or set devUnsafeAllowClientUserId: true for a local demo backend (unsafe).",
    );
  }

  const newLocalId = createDefaultIdFactory("sv");
  const serverWriter = (ctx: AnyCtx, actingUserId = "server"): ServerWriter => {
    const store = pushStore(ctx);
    const cfg = configFor(ctx);
    return {
      insert: (table, value, opts) =>
        applyServerWrite(
          store,
          cfg,
          { kind: "insert", table, value, localId: opts?.localId },
          () => newLocalId(table),
          actingUserId,
        ),
      patch: (table, localId, patch) =>
        applyServerWrite(
          store,
          cfg,
          { kind: "patch", table, localId, patch },
          () => newLocalId(table),
          actingUserId,
        ),
      remove: (table, localId) =>
        applyServerWrite(
          store,
          cfg,
          { kind: "delete", table, localId },
          () => newLocalId(table),
          actingUserId,
        ),
    };
  };

  return {
    config,
    configFor,
    pushStore,
    resolveUserId,
    serverWriter,
    newLocalId,
    changeRetentionMs,
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
export function createSyncFunctions<
  Role = unknown,
  Row extends Record<string, unknown> = Record<string, unknown>,
>(options: CreateSyncFunctionsOptions<Role, Row>): SyncFunctions {
  const lf = options.component;
  // Shared plumbing (config, request-bound config, push store, identity, serverWriter).
  const core = buildSyncCore(options);
  const { config, configFor, pushStore, resolveUserId, serverWriter, changeRetentionMs } = core;

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
      commitOp: unsupported as never,
      async getServerId(table, localId) {
        return await ctx.runQuery(lf.idMaps.get, { table, localId });
      },
      putIdMap: unsupported as never,
      appendChange: unsupported as never,
      latestChangeVersion: unsupported as never,
      scopeForLocalId: unsupported as never,
      async changesAfter(scopeKey, cursor, limit) {
        const rows = await ctx.runQuery(lf.changes.listAfter, {
          scopeKey,
          cursor: cursor ?? undefined,
          limit,
        });
        return rows.map(storedFromComponent);
      },
      async firstChangeId(scopeKey) {
        return await ctx.runQuery(lf.changes.firstId, { scopeKey });
      },
      async lastChangeId(scopeKey) {
        return await ctx.runQuery(lf.changes.lastId, { scopeKey });
      },
      async rowVersionsByScope(scopeKey, afterRowKey, limit) {
        return await ctx.runQuery(lf.changes.listVersions, {
          scopeKey,
          afterRowKey: afterRowKey ?? undefined,
          limit,
        });
      },
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
    // Atomic write group (DX v4 §5). OPTIONAL: absent means ungrouped — an older client
    // bundle sends none and its ops process one at a time, exactly as before. When
    // present, handlePush applies the whole group transactionally.
    groupId: v.optional(v.string()),
    groupSize: v.optional(v.number()),
    groupIndex: v.optional(v.number()),
    // Legacy field older client bundles still send (was the timestampLww logical
    // clock). Accepted and ignored so their queued offline ops keep pushing.
    timestamp: v.optional(v.number()),
  };

  const push = options.mutation({
    args: {
      clientId: v.string(),
      userId: v.string(),
      schemaVersion: v.number(),
      mutations: v.array(v.object(mutationFields)),
    },
    handler: async (ctx: AnyCtx, args: any) => {
      const userId = await resolveUserId(ctx, args.userId);
      return await handlePush(pushStore(ctx), configFor(ctx), {
        userId,
        clientId: args.clientId,
        schemaVersion: args.schemaVersion,
        mutations: args.mutations,
      });
    },
  });

  const pull = options.query({
    args: {
      clientId: v.string(),
      userId: v.string(),
      schemaVersion: v.number(),
      scopes: v.array(v.object({ kind: v.string(), value: v.optional(v.string()) })),
      cursors: v.any(),
      bootstrapCursors: v.optional(v.any()),
      doorbell: v.optional(v.boolean()),
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
        doorbell: args.doorbell ?? undefined,
      });
    },
  });

  // ---- Presence (ephemeral, never part of the sync log) ---------------------
  // Authorization mirrors pull's scope rules exactly: your own `u:` scope, or a
  // workspace/project you are a member of (access.member decides — I7). scopeKey uses
  // the same format the sync engine uses, so presence rooms line up with scopes.
  async function hasPresenceAccess(
    ctx: AnyCtx,
    userId: string,
    scopeKey: string,
  ): Promise<boolean> {
    const sep = scopeKey.indexOf(":");
    const kind = sep === -1 ? scopeKey : scopeKey.slice(0, sep);
    const value = sep === -1 ? "" : scopeKey.slice(sep + 1);
    if (kind === "u") {
      return value === userId;
    }
    if (kind === "byWorkspace" || kind === "byProject") {
      const found = Object.entries(options.tables).find(([, table]) => table.scope.kind === kind);
      const membershipTable = (found?.[1].scope as { membershipTable?: string } | undefined)
        ?.membershipTable;
      // NOTE: reading membership INSIDE the query is what makes presenceList
      // reactive to joining — the subscription re-runs when the membership row
      // lands, so a client that heartbeats-then-joins converges on its own.
      if (!found || !membershipTable || !options.access) return false;
      return (
        ((await options.access.member(ctx, {
          userId,
          scopeValue: value,
          table: found[0],
          membershipTable,
        })) ?? null) !== null
      );
    }
    return false;
  }

  const presence = options.mutation({
    args: {
      scopeKey: v.string(),
      clientId: v.string(),
      userId: v.string(),
      data: v.any(),
      leaving: v.optional(v.boolean()),
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
        leaving: args.leaving,
      });
      return null;
    },
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
        updatedAt: row.updatedAt,
      }));
    },
  });

  const gc = (options.internalMutation ?? options.mutation)({
    args: {},
    handler: async (ctx: AnyCtx) =>
      await ctx.runMutation(lf.changes.gc, {
        now: config.now ? config.now() : Date.now(),
        retentionMs: Number.isFinite(changeRetentionMs) ? changeRetentionMs : undefined,
      }),
  });

  return { push, pull, presence, presenceList, gc, serverWriter } as SyncFunctions;
}
