import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as ConvexReact from "convex/react";
import { getFunctionName, makeFunctionReference } from "convex/server";
import type { FunctionArgs, FunctionReference, FunctionReturnType, OptionalRestArgs } from "convex/server";
import {
  IndexedDbStore,
  MemoryLocalStore,
  collectManifest,
  collection,
  createLocalDb,
  createClientId,
  createConvexTransport,
  createLocalFirstEngine,
  many,
  manyToMany,
  one,
  rankBetween,
  rankCompare,
  isValidRank,
  matchesFilter,
  parseFilter,
  rebalance,
  serializeFilter,
  viaIds,
  type AttachmentBackend,
  type AttachmentUploadState,
  type CanChecker,
  type FunctionNameResolver,
  type LocalFirstManifest,
  type LocalDb,
  type FilterParseError,
  type FilterParseResult,
  type FilterSpec,
  type LocalFirstBatchCall,
  type LocalFirstMutationCall,
  type LocalQueryCountResult,
  type LocalQueryPlan,
  type LocalQueryResult,
  type TypedTableQuery,
  type BackrefRelationDescriptor,
  type DeclaredRelationDescriptor,
  type DeclaredRelations,
  type ManyRelationDescriptor,
  type OneRelationDescriptor,
  type LocalStore,
  type RelationSpec,
  type RecoveryOperation,
  type RecoveryStatus,
  type RowValue,
  type SyncStatus,
  type SyncTransport
} from "../core/index.js";
// Engine + low-level helpers are INTERNAL (I13): imported from the internal subpath,
// never re-exported to app authors. See convex-localfirst/core/internal.
import {
  LocalFirstEngine,
  coordinationName,
  createFallbackMutationCall,
  createMultiTabSync,
  defaultFunctionName
} from "../core/internal.js";

export {
  collection,
  createLocalDb,
  many,
  manyToMany,
  one,
  viaIds,
  rankBetween,
  rankCompare,
  isValidRank,
  rebalance,
  matchesFilter,
  parseFilter,
  serializeFilter
};
export type {
  BackrefRelationDescriptor,
  CanChecker,
  DeclaredRelationDescriptor,
  DeclaredRelations,
  FilterParseError,
  FilterParseResult,
  FilterSpec,
  LocalDb,
  LocalFirstBatchCall,
  LocalQueryPlan,
  ManyRelationDescriptor,
  OneRelationDescriptor,
  RelationSpec,
  TypedTableQuery
};
export type { TableNamesOf, TableRowOf } from "../core/index.js";

export const ConvexReactClient = ConvexReact.ConvexReactClient;
export const Authenticated = ConvexReact.Authenticated;
export const Unauthenticated = ConvexReact.Unauthenticated;
export const AuthLoading = ConvexReact.AuthLoading;
export const useConvex = ConvexReact.useConvex;
export const useConvexAuth = ConvexReact.useConvexAuth;

const EMPTY_STATUS: SyncStatus = {
  online: true,
  syncing: false,
  pendingMutations: 0,
  lastPushAt: null,
  lastPullAt: null,
  lastError: null,
  blockedBySchemaMismatch: false,
  partial: false,
  recovery: { rejectedOperations: [], olderSchemaOperations: [], failedAttachments: [], failedGroups: [] }
};

export type LocalFirstProviderConfig = {
  /**
   * Your imported `lf.table` modules — the client manifest is built from them at
   * runtime, running the SAME declarations the server deploys (no codegen step):
   *
   * ```tsx
   * import * as todos from "../convex/todos";
   * <ConvexProvider client={convex} localFirst={{ modules: { todos }, userId }}>
   * ```
   *
   * Keys mirror the Convex module path (`{ todos }` → `api.todos.*`; a nested
   * module as `{ "tasks/todos": todos }`).
   */
  readonly modules?: Record<string, unknown>;
  /** Bump when a local-first table's shape changes incompatibly (gates sync). Default 1. */
  readonly schemaVersion?: number;
  /** Escape hatch / tests: a prebuilt manifest instead of `modules`. */
  readonly manifest?: LocalFirstManifest;
  readonly userId?: string | null;
  readonly clientId?: string;
  /** Local store. Defaults to IndexedDB in the browser (namespaced by `namespace`
   *  ?? `userId`), in-memory elsewhere (SSR, tests). */
  readonly store?: LocalStore;
  /** Database name for the default IndexedDB store. Default "convex-localfirst". */
  readonly databaseName?: string;
  /** Store namespace — isolates one user's local data from another's on a shared
   *  device. Defaults to `userId`; switch it on logout. */
  readonly namespace?: string;
  /** Sync function refs. Default to the conventional `api.sync.push` / `api.sync.pull`
   *  (and `api.sync.presence` / `api.sync.presenceList` for `usePresence`). */
  readonly sync?: {
    readonly push?: FunctionReference<"mutation">;
    readonly pull?: FunctionReference<"query">;
    readonly presence?: FunctionReference<"mutation">;
    readonly presenceList?: FunctionReference<"query">;
  };
  /** Escape hatch: bring your own transport (replaces the default Convex wiring). */
  readonly transport?: SyncTransport;
  readonly nameOf?: FunctionNameResolver;
  /** Offline-capable attachments (P5). Point at your `createAttachmentFunctions`
   *  mutations; default to the conventional `attachments:getUploadUrl` /
   *  `attachments:finalize`. Without them, useCreateAttachment throws a config error. */
  readonly attachments?: {
    readonly getUploadUrl?: FunctionReference<"mutation">;
    readonly finalize?: FunctionReference<"mutation">;
    /** Metadata-row field the server stamps with the storage id. Default "storageId". */
    readonly storageIdField?: string;
    /** Escape hatch: bring your own upload backend (replaces the default Convex wiring). */
    readonly backend?: AttachmentBackend;
  };
};

type LocalFirstReactContextValue = {
  readonly engine: LocalFirstEngine;
  /** What usePresence needs; presence rides plain Convex reactivity, not the engine. */
  readonly presence: {
    readonly client: InstanceType<typeof ConvexReact.ConvexReactClient>;
    readonly clientId: string;
    readonly userId: string | null;
    readonly beatName: string;
    readonly listName: string;
  };
};

const LocalFirstReactContext = createContext<LocalFirstReactContextValue | null>(null);

/**
 * Default name resolver: use Convex's getFunctionName for real function
 * references (api.todos.list -> "todos:list"); fall back to the core resolver
 * for plain strings/objects (used in tests).
 */
function reactDefaultFunctionName(reference: unknown): string {
  try {
    return getFunctionName(reference as never);
  } catch {
    return defaultFunctionName(reference);
  }
}

/**
 * The convex-aware name resolver (`api.todos.list` → `"todos:list"`) the provider and the
 * headless factory wire by default. Exported so an imperative consumer building its own
 * engine doesn't have to inject one.
 */
export const convexFunctionName: FunctionNameResolver = reactDefaultFunctionName;

/**
 * The engine from createConvexLocalFirst, with convex-typed `mutate`/`query`: args and
 * result infer from the function reference, like the hooks — so headless consumers get the
 * same inference instead of core's backend-agnostic `reference: unknown`. Core stays
 * convex-free; the typing lives here in the adapter.
 */
export type ConvexLocalFirstEngine = Omit<LocalFirstEngine, "mutate" | "query"> & {
  mutate<Mutation extends FunctionReference<"mutation">>(
    reference: Mutation,
    args: FunctionArgs<Mutation>
  ): LocalFirstMutationCall<FunctionReturnType<Mutation>>;
  query<Query extends FunctionReference<"query">>(
    reference: Query,
    args: FunctionArgs<Query>
  ): Promise<FunctionReturnType<Query> | undefined>;
};

export type CreateConvexLocalFirstOptions = {
  /** Your imported lf.table modules (see LocalFirstProviderConfig.modules) — or a
   *  prebuilt `manifest`. */
  readonly modules?: Record<string, unknown>;
  readonly schemaVersion?: number;
  readonly manifest?: LocalFirstManifest;
  /** Pass a Convex client, or a `url` to construct a (reactive) ConvexReactClient. */
  readonly client?: InstanceType<typeof ConvexReact.ConvexReactClient>;
  readonly url?: string;
  readonly userId?: string | null;
  readonly clientId?: string;
  /** Local store. Defaults to IndexedDb in the browser, in-memory elsewhere. */
  readonly store?: LocalStore;
  /** Names for the default browser IndexedDb store. */
  readonly databaseName?: string;
  readonly namespace?: string;
  /** Sync function refs. Default to the conventional `sync:push` / `sync:pull`. */
  readonly sync?: {
    readonly push?: FunctionReference<"mutation">;
    readonly pull?: FunctionReference<"query">;
  };
  /** Attachment mutation refs (default `attachments:getUploadUrl` / `attachments:finalize`). */
  readonly attachments?: {
    readonly getUploadUrl?: FunctionReference<"mutation">;
    readonly finalize?: FunctionReference<"mutation">;
    readonly storageIdField?: string;
  };
};

/**
 * One-call headless setup for an imperative (non-hook) consumer — a service layer, store,
 * or Node script. Wires the Convex transport, name resolver, a browser/Node store default,
 * and a client id (the provider's plumbing minus the React lifecycle). Returns the engine
 * plus the Convex client (for server-only, non-local-first functions).
 */
export function createConvexLocalFirst(options: CreateConvexLocalFirstOptions): {
  readonly engine: ConvexLocalFirstEngine;
  readonly client: InstanceType<typeof ConvexReact.ConvexReactClient>;
} {
  const manifest =
    options.manifest ??
    (options.modules
      ? collectManifest(options.modules, { schemaVersion: options.schemaVersion })
      : raise("createConvexLocalFirst: pass `modules` (your imported lf.table modules) or a prebuilt `manifest`."));
  const client =
    options.client ??
    new ConvexReact.ConvexReactClient(
      options.url ?? raise("createConvexLocalFirst: pass either `client` or `url`.")
    );
  const clientId = options.clientId ?? createClientId();
  const userId = options.userId ?? null;
  const store =
    options.store ??
    (typeof indexedDB !== "undefined"
      ? new IndexedDbStore({
          databaseName: options.databaseName ?? "convex-localfirst",
          namespace: options.namespace ?? defaultNamespace(userId, manifest.schemaVersion)
        })
      : new MemoryLocalStore());
  const transport = createConvexTransport({
    client,
    push: options.sync?.push ?? makeFunctionReference<"mutation">("sync:push"),
    pull: options.sync?.pull ?? makeFunctionReference<"query">("sync:pull"),
    clientId,
    // The transport envelope wants a string; an anonymous (null-userId) engine sends
    // "" — the server resolves the real identity from auth and ignores this anyway.
    userId: userId ?? ""
  });
  const attachmentBackend = createConvexAttachmentBackend(
    client,
    options.attachments?.getUploadUrl ? convexFunctionName(options.attachments.getUploadUrl) : "attachments:getUploadUrl",
    options.attachments?.finalize ? convexFunctionName(options.attachments.finalize) : "attachments:finalize",
    userId
  );
  const engine = createLocalFirstEngine({
    manifest,
    store,
    transport,
    clientId,
    userId,
    nameOf: convexFunctionName,
    attachments: { backend: attachmentBackend, storageIdField: options.attachments?.storageIdField }
  });
  // Runtime is core's engine; the cast only adds the convex-typed mutate/query overloads
  // (same methods, inferred arg/return types). Sound: the runtime signatures are wider.
  return { engine: engine as unknown as ConvexLocalFirstEngine, client };
}

function raise(message: string): never {
  throw new Error(message);
}

/** Default IndexedDB namespace: per user, and per schemaVersion past v1 — bumping the
 *  version yields a fresh local store (clean reset + full resync) instead of a
 *  mismatch-blocked dead end. v1 stays unsuffixed so existing stores keep working. */
function defaultNamespace(userId: string | null, schemaVersion: number): string {
  const base = userId ?? "default";
  return schemaVersion > 1 ? `${base}::v${schemaVersion}` : base;
}

/** The attachment backend the provider/headless factory wires by default: the
 *  conventional getUploadUrl/finalize mutations over the shared Convex client. The
 *  default XHR upload lives in core (AttachmentManager). */
function createConvexAttachmentBackend(
  client: InstanceType<typeof ConvexReact.ConvexReactClient>,
  getUploadUrlName: string,
  finalizeName: string,
  userId: string | null
): AttachmentBackend {
  const getUploadUrlRef = makeFunctionReference<"mutation">(getUploadUrlName);
  const finalizeRef = makeFunctionReference<"mutation">(finalizeName);
  return {
    getUploadUrl: ({ table, localId }) =>
      client.mutation(getUploadUrlRef as never, { table, localId, userId: userId ?? "" } as never) as Promise<string>,
    finalize: ({ table, localId, storageId }) =>
      (client.mutation(finalizeRef as never, { table, localId, storageId, userId: userId ?? "" } as never) as Promise<unknown>).then(
        () => undefined
      )
  };
}

export function ConvexProvider(props: {
  readonly client: InstanceType<typeof ConvexReact.ConvexReactClient>;
  readonly children: React.ReactNode;
  readonly localFirst?: LocalFirstProviderConfig;
}) {
  if (!props.localFirst) {
    return <ConvexReact.ConvexProvider client={props.client}>{props.children}</ConvexReact.ConvexProvider>;
  }
  return (
    <ConvexReact.ConvexProvider client={props.client}>
      <LocalFirstProvider {...props.localFirst} client={props.client}>
        {props.children}
      </LocalFirstProvider>
    </ConvexReact.ConvexProvider>
  );
}

// Internal: the explicit-config provider. Users mount the local-first layer via
// the public `ConvexProvider` (drop-in name) + its `localFirst` prop.
function LocalFirstProvider(
  props: LocalFirstProviderConfig & {
    readonly client: InstanceType<typeof ConvexReact.ConvexReactClient>;
    readonly children: React.ReactNode;
  }
) {
  // Resolved ONCE per provider instance: the manifest is pure data derived from the
  // imported modules (stable), and rebuilding it on an inline `modules={{ todos }}`
  // object would thrash the engine every render.
  const [manifest] = useState<LocalFirstManifest>(() => {
    if (props.manifest) return props.manifest;
    if (props.modules) return collectManifest(props.modules, { schemaVersion: props.schemaVersion });
    throw new Error(
      "ConvexProvider localFirst: pass `modules` (your imported lf.table modules) or a prebuilt `manifest`."
    );
  });
  const [clientId] = useState(() => props.clientId ?? createClientId());
  const userId = props.userId ?? null;

  // Default transport: the conventional sync endpoints over the SAME Convex client the
  // provider already holds. Deps use the resolved function NAMES — `api.sync.push` is a
  // fresh proxy object per access, so depending on the reference would thrash.
  const pushName = props.sync?.push ? reactDefaultFunctionName(props.sync.push) : "sync:push";
  const pullName = props.sync?.pull ? reactDefaultFunctionName(props.sync.pull) : "sync:pull";
  const transport = useMemo(
    () =>
      props.transport ??
      createConvexTransport({
        client: props.client,
        push: makeFunctionReference<"mutation">(pushName),
        pull: makeFunctionReference<"query">(pullName),
        clientId,
        // The transport envelope wants a string; an anonymous (null-userId) engine sends
        // "" — the server resolves the real identity from auth and ignores this anyway.
        userId: userId ?? ""
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.transport, props.client, pushName, pullName, clientId, userId]
  );

  // Resolve the store with the SAME deps as the engine, so (a) an app that inlines a
  // fresh store object each render doesn't thrash the engine, and (b) the multi-tab
  // coordination key below is derived from the EXACT store the engine holds — never an
  // old-engine-under-a-new-store-namespace mismatch. Browser default is durable
  // IndexedDB, namespaced per user (switch user → separate local data, I9) and per
  // schemaVersion past v1 — so bumping the version in createLocalFirst gives every
  // client a clean local store + full resync (the schema-migration escape hatch),
  // instead of a mismatch-blocked dead end.
  const store = useMemo(
    () =>
      props.store ??
      (typeof indexedDB !== "undefined"
        ? new IndexedDbStore({
            databaseName: props.databaseName ?? "convex-localfirst",
            namespace: props.namespace ?? defaultNamespace(userId, manifest.schemaVersion)
          })
        : new MemoryLocalStore()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manifest, userId, transport, props.nameOf]
  );
  // Attachment upload backend (P5): the conventional endpoints over the SAME Convex
  // client. Deps use resolved NAMES (the `api.*` proxy is a fresh object per access).
  const getUploadUrlName = props.attachments?.getUploadUrl
    ? reactDefaultFunctionName(props.attachments.getUploadUrl)
    : "attachments:getUploadUrl";
  const finalizeName = props.attachments?.finalize
    ? reactDefaultFunctionName(props.attachments.finalize)
    : "attachments:finalize";
  const storageIdField = props.attachments?.storageIdField;
  const injectedBackend = props.attachments?.backend;
  const attachmentBackend = useMemo(
    () => injectedBackend ?? createConvexAttachmentBackend(props.client, getUploadUrlName, finalizeName, userId),
    [injectedBackend, props.client, getUploadUrlName, finalizeName, userId]
  );
  const engine = useMemo(() => {
    return new LocalFirstEngine({
      manifest,
      store,
      clientId,
      userId,
      transport,
      nameOf: props.nameOf ?? reactDefaultFunctionName,
      attachments: { backend: attachmentBackend, storageIdField }
    });
    // clientId is intentionally captured once; store moves in lockstep (same deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, userId, transport, props.nameOf, store, attachmentBackend, storageIdField]);

  // The engine self-wires browser connectivity in its constructor — reflecting
  // navigator.onLine into the sync status and flushing the offline outbox on reconnect
  // (see LocalFirstEngine.wireConnectivity). Dispose those listeners when the engine is
  // replaced or the provider unmounts. resume() on setup is what makes this StrictMode-
  // safe: React's dev mount→cleanup→mount cycle reuses the memoized engine after its
  // cleanup disposed it, which would otherwise leave it deaf to online/offline events.
  useEffect(() => {
    engine.resume();
    return () => engine.dispose();
  }, [engine]);

  // A schema bump uses a fresh default namespace. Surface (never auto-apply) pending
  // operations left in older namespaces so the app can export/migrate/discard them via
  // useSyncRecovery instead of silently orphaning offline work.
  useEffect(() => {
    if (
      props.store ||
      props.namespace ||
      !(store instanceof IndexedDbStore) ||
      manifest.schemaVersion <= 1 ||
      typeof indexedDB === "undefined"
    ) {
      engine.setOlderSchemaOperations([]);
      return;
    }
    let alive = true;
    const databaseName = props.databaseName ?? "convex-localfirst";
    const reads = Array.from({ length: manifest.schemaVersion - 1 }, (_, index) => index + 1).map(async (version) => {
      const namespace = defaultNamespace(userId, version);
      const legacy = new IndexedDbStore({ databaseName, namespace });
      try {
        return (await legacy.getPendingOperations()).map(
          ({ opId, table, id, kind, schemaVersion, createdAt, error }) =>
            ({ opId, table, id, kind, schemaVersion, createdAt, error, namespace }) satisfies RecoveryOperation
        );
      } finally {
        (await legacy._database()).close();
      }
    });
    void Promise.all(reads)
      .then((operations) => {
        if (alive) engine.setOlderSchemaOperations(operations.flat());
      })
      .catch((error) => {
        if (alive) {
          console.warn("[convex-localfirst] could not inspect older schema namespaces for pending operations", error);
        }
      });
    return () => {
      alive = false;
    };
  }, [engine, manifest.schemaVersion, props.databaseName, props.namespace, props.store, store, userId]);

  // Multi-tab coordination: elect one leader (only it runs the background batch push)
  // and poke other tabs to re-read the shared IndexedDB after a pull. Engaged only with
  // the crash-safe Web Locks primitive present (every modern browser); without it — SSR,
  // jsdom tests, old browsers — every tab syncs independently exactly as before.
  useEffect(() => {
    if (typeof window === "undefined" || !("locks" in navigator)) {
      return;
    }
    // Coordinate on the SHARED-data boundary (the store the engine actually holds), not
    // just the user — see coordinationName. engine + store move in lockstep, so this can
    // never key an engine under another store's namespace.
    const dispose = createMultiTabSync(engine, { name: coordinationName(store, userId), id: engine.clientId });
    return dispose;
  }, [engine, userId, store]);

  const beatName = props.sync?.presence ? reactDefaultFunctionName(props.sync.presence) : "sync:presence";
  const listName = props.sync?.presenceList ? reactDefaultFunctionName(props.sync.presenceList) : "sync:presenceList";
  const value = useMemo(
    () => ({ engine, presence: { client: props.client, clientId, userId, beatName, listName } }),
    [engine, props.client, clientId, userId, beatName, listName]
  );
  return <LocalFirstReactContext.Provider value={value}>{props.children}</LocalFirstReactContext.Provider>;
}

// Internal: the engine never appears in the public type surface (I13).
function useLocalFirstEngine(): LocalFirstEngine | null {
  return useContext(LocalFirstReactContext)?.engine ?? null;
}

export type UseLocalFirstQueryOptions<TResult> = {
  readonly initial?: TResult;
  /** `"auto"` (default): pull from the server on mount + subscribe to live changes.
   *  `"off"`: read local data only, never sync this query. (No silent middle ground —
   *  a "manual" mode with no trigger API would just behave as "auto", so it isn't offered.) */
  readonly sync?: "auto" | "off";
};

// Convex's own "empty args object" marker (see convex/server's EmptyObject): a
// mutation/query declared with `args: {}` has `_args` of exactly `Record<string, never>`.
// Re-declared locally because convex/server doesn't re-export it.
type EmptyObject = Record<string, never>;

/**
 * Rest-args tuple mirroring convex/react's `OptionalRestArgsOrSkip`, but carrying our
 * extra `options` object: a query with required args REQUIRES the args parameter (omitting
 * it is a compile error), while an empty-args query lets you omit it. `"skip"` is always
 * allowed in place of the args (Convex-identical).
 */
export type QueryArgsAndOptions<Query extends FunctionReference<"query">, Options> =
  Query["_args"] extends EmptyObject
    ? [args?: EmptyObject | "skip", options?: Options]
    : [args: Query["_args"] | "skip", options?: Options];

/**
 * Convex-compatible useQuery. Args and result type are inferred from the Convex
 * function reference (drop-in, no explicit generics — exactly like `convex/react`).
 * Queries with required args require the args parameter; empty-args queries allow
 * omitting it. Local-first functions read from the engine and subscribe to local
 * changes; everything else falls through to Convex.
 *
 * All hooks below run unconditionally on every render (no rules-of-hooks
 * violation): the Convex hook is fed "skip" for local-first functions, and the
 * local subscription is inert when there is no engine/local definition.
 */
export function useQuery<Query extends FunctionReference<"query">>(
  reference: Query,
  ...argsAndOptions: QueryArgsAndOptions<Query, UseLocalFirstQueryOptions<FunctionReturnType<Query>>>
): FunctionReturnType<Query> | undefined {
  const [args, options] = argsAndOptions as [
    FunctionArgs<Query> | "skip" | undefined,
    UseLocalFirstQueryOptions<FunctionReturnType<Query>>?
  ];
  const engine = useLocalFirstEngine();
  const isLocal = engine !== null && engine.hasLocalQuery(reference);
  const resolvedArgs = (args ?? {}) as FunctionArgs<Query> | "skip";

  const convexResult = ConvexReact.useQuery(
    reference as never,
    (isLocal ? "skip" : resolvedArgs) as never
  ) as FunctionReturnType<Query> | undefined;

  const localResult = useLocalQuery<FunctionArgs<Query>, FunctionReturnType<Query>>(
    isLocal ? engine : null,
    reference,
    resolvedArgs,
    options
  );

  return isLocal ? localResult : convexResult;
}

function useLocalQuery<TArgs, TResult>(
  engine: LocalFirstEngine | null,
  reference: unknown,
  args: TArgs | "skip",
  options?: UseLocalFirstQueryOptions<TResult>
): TResult | undefined {
  const [value, setValue] = useState<TResult | undefined>(options?.initial);
  const argsKey = useMemo(() => JSON.stringify(args), [args]);
  // Key the effect on the resolved function NAME, not the reference object:
  // Convex's `api` proxy returns a fresh object per access, so using the object
  // identity would re-run this effect every render (an infinite sync loop).
  const refKey = useMemo(() => (engine ? engine.functionName(reference) : null), [engine, reference]);

  useEffect(() => {
    if (!engine || args === "skip") {
      // "skip" must read as no data (Convex returns undefined), not the last
      // value from before the query was skipped.
      setValue(options?.initial);
      return;
    }
    let alive = true;
    const run = () => {
      void engine.query<TArgs, TResult>(reference, args as TArgs).then((result) => {
        if (alive) {
          setValue((result as TResult) ?? options?.initial);
        }
      });
    };
    run();
    // Only re-run when THIS query's table changes (P3 incremental view), not on every
    // unrelated store change. Falls back to the global data bus for a non-local ref.
    const table = engine.queryTable(reference);
    const unsubscribe = table ? engine.subscribeTableChange(table, run) : engine.subscribe(run);
    let unwatch: (() => void) | null = null;
    if (options?.sync !== "off") {
      void engine.refreshQuery(reference, args as TArgs);
      // Reactive like convex/react: a reactive transport pushes server changes, which
      // drain into the store and fire `run` via the local subscription above. Falls
      // back to mount + local-change pulls when the transport isn't reactive.
      unwatch = engine.watchQuery(reference, args as TArgs);
    }
    return () => {
      alive = false;
      unsubscribe();
      unwatch?.();
    };
    // refKey/argsKey are the stable identity of (function, args); reference and
    // options are read at effect time. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, refKey, argsKey]);

  // "skip" must read as no data SYNCHRONOUSLY (Convex returns undefined): the
  // effect's clear runs after render, so returning `value` here would surface the
  // previous result for one render.
  if (args === "skip") {
    return options?.initial;
  }
  return value;
}

/**
 * Reactive local-first query for the chainable `collection(...)` builder. Re-renders on
 * local data change and refines the derived view with where/order/limit on the client.
 * The query is rebuilt inline each render, so effects key on the stable (table, scope)
 * identity, never the per-render object — keeping dynamic predicates live without resubscribing.
 */
export type UseLiveQueryOptions = {
  /**
   * Real-time FALLBACK for non-reactive transports only. A reactive transport (the default
   * ConvexReactClient) pushes changes and ignores this; an HTTP client re-pulls the scope
   * every N ms while mounted. Leave unset for normal data.
   */
  readonly pollMs?: number;
};

function liveStructuralKey<Row extends Record<string, unknown>, Rel, Group extends string>(
  engine: LocalFirstEngine,
  query: LocalQueryPlan<Row, Rel, Group>
): string {
  return JSON.stringify({
    t: [...engine.tablesForPlan(query)].sort(),
    s: query.scopeValues ?? null,
    f: query.filters ?? [],
    o: query.orderSpec ?? (typeof query.orderBy === "function" ? null : (query.orderBy ?? null)),
    l: query.rowLimit ?? null,
    p: query.predicateCount ?? 0,
    g: query.groupField ?? null
  });
}

export function useLiveQuery<Row extends Record<string, unknown>, Rel, Group extends string>(
  query: (LocalQueryPlan<Row, Rel, Group> & ([Group] extends [never] ? never : { readonly __group: Group })) | "skip",
  options?: UseLiveQueryOptions
): ReadonlyMap<string | null, Array<Row & Rel>> | undefined;
export function useLiveQuery<Row extends Record<string, unknown> = RowValue, Rel = unknown>(
  query: LocalQueryPlan<Row, Rel, never> | "skip",
  options?: UseLiveQueryOptions
): Array<Row & Rel> | undefined;
export function useLiveQuery<
  Row extends Record<string, unknown> = RowValue,
  Rel = unknown,
  Group extends string = never
>(
  query: LocalQueryPlan<Row, Rel, Group> | "skip",
  options?: UseLiveQueryOptions
): Array<Row & Rel> | ReadonlyMap<string | null, Array<Row & Rel>> | undefined {
  const engine = useLocalFirstEngine();
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);
  const subRef = useRef<{
    current(): LocalQueryResult<Row, Rel, Group> | undefined;
    dispose(): void;
  } | null>(null);

  // Structural signature of the query's SHAPE (read set, scope, order, limit, predicate
  // count). The incremental view is re-subscribed only when this changes; ordinary data
  // changes are handled by the view's O(log n) delta splicing, never by re-scanning. An
  // inline-rebuilt query object with the same shape keeps the same view (stable identity).
  const structuralKey =
    query === "skip" || !engine
      ? null
      : liveStructuralKey(engine, query);

  useEffect(() => {
    if (!engine || query === "skip") {
      subRef.current = null;
      return;
    }
    // Register the plan with the incremental query engine (P3): the result is maintained
    // by row deltas, and `rerender` fires only when the visible result actually changes.
    const sub = engine.subscribeLiveQuery(query, rerender);
    subRef.current = sub;
    // Background sync for this query's scope (push pending + pull), and prefer true
    // server-push when the transport is reactive.
    void engine.refreshPlan(query);
    const unwatch = engine.watchPlan(query);
    const pollMs = options?.pollMs;
    const timer = !unwatch && pollMs ? setInterval(() => void engine.refreshPlan(query), pollMs) : null;
    return () => {
      sub.dispose();
      subRef.current = null;
      unwatch?.();
      if (timer) clearInterval(timer);
    };
    // query is read at effect time; structuralKey is the stable identity of its shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, structuralKey]);

  if (query === "skip" || !engine) return undefined;
  // The view returns a stable array reference while unchanged, so downstream deps hold.
  return subRef.current?.current();
}

/** Live aggregate counts over the same scope/filter plan as `useLiveQuery`.
 * Ordering and row limits do not affect counts. Grouped plans return a record;
 * ungrouped plans return one number. */
export function useLiveCounts<Row extends Record<string, unknown>, Rel, Group extends string>(
  query: (LocalQueryPlan<Row, Rel, Group> & ([Group] extends [never] ? never : { readonly __group: Group })) | "skip",
  options?: UseLiveQueryOptions
): Record<string, number> | undefined;
export function useLiveCounts<Row extends Record<string, unknown> = RowValue, Rel = unknown>(
  query: LocalQueryPlan<Row, Rel, never> | "skip",
  options?: UseLiveQueryOptions
): number | undefined;
export function useLiveCounts<
  Row extends Record<string, unknown> = RowValue,
  Rel = unknown,
  Group extends string = never
>(
  query: LocalQueryPlan<Row, Rel, Group> | "skip",
  options?: UseLiveQueryOptions
): number | Record<string, number> | undefined {
  const engine = useLocalFirstEngine();
  const [, setTick] = useState(0);
  const rerender = () => setTick((tick) => tick + 1);
  const subRef = useRef<{
    current(): LocalQueryCountResult<Group> | undefined;
    dispose(): void;
  } | null>(null);
  const structuralKey = query === "skip" || !engine ? null : liveStructuralKey(engine, query);

  useEffect(() => {
    if (!engine || query === "skip") {
      subRef.current = null;
      return;
    }
    const sub = engine.subscribeLiveCounts(query, rerender);
    subRef.current = sub;
    void engine.refreshPlan(query);
    const unwatch = engine.watchPlan(query);
    const pollMs = options?.pollMs;
    const timer = !unwatch && pollMs ? setInterval(() => void engine.refreshPlan(query), pollMs) : null;
    return () => {
      sub.dispose();
      subRef.current = null;
      unwatch?.();
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, structuralKey]);

  if (query === "skip" || !engine) return undefined;
  return subRef.current?.current();
}

export type UseSearchOptions = {
  /** Restrict results to rows matching these field equalities (e.g. `{ workspaceId }`).
   *  Applied before ranking, so `total` reflects the scoped match count. */
  readonly scope?: Record<string, unknown>;
  /** Cap the returned `results` (ranked). `total` is always the full match count. */
  readonly limit?: number;
};

export type UseSearchResult<Row extends Record<string, unknown> = RowValue> = {
  /** The ranked matching rows (capped by `limit`). Stable array identity while unchanged. */
  readonly results: Row[];
  /** Total matches before `limit` (post-scope) — for a "showing N of M" affordance. */
  readonly total: number;
};

const EMPTY_SEARCH: UseSearchResult = { results: [], total: 0 };

/**
 * Local full-text search over a table's declared `searchFields` (P4). Search-as-you-type:
 * pass the raw input `query` on every keystroke — the lookup is a memory-resident index
 * probe (no debounce needed), the final token prefix-matches, and results update
 * incrementally as local data changes (a delta touching the table refreshes only the live
 * searches on it). An empty/whitespace query returns empty results at zero cost (no
 * subscription). The result array keeps a stable reference while unchanged.
 *
 * ```tsx
 * const { results, total } = useSearch("issues", query, { scope: { workspaceId }, limit: 20 });
 * ```
 */
export function useSearch<Row extends Record<string, unknown> = RowValue>(
  table: string,
  query: string,
  options?: UseSearchOptions
): UseSearchResult<Row> {
  const engine = useLocalFirstEngine();
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);
  const subRef = useRef<{ current(): UseSearchResult<Row>; dispose(): void } | null>(null);

  const trimmed = query.trim();
  const scope = options?.scope;
  const limit = options?.limit;
  // Stable identity of the search's shape. A changed table/query/scope/limit re-subscribes;
  // ordinary data changes are handled by the view's incremental refresh, never a resubscribe.
  // Empty query → no key → no subscription (zero cost).
  const structuralKey =
    !engine || trimmed === ""
      ? null
      : JSON.stringify({ t: table, q: query, s: scope ?? null, l: limit ?? null });

  useEffect(() => {
    if (!engine || trimmed === "") {
      subRef.current = null;
      return;
    }
    const sub = engine.subscribeSearch(table, query, { scope, limit }, rerender) as {
      current(): UseSearchResult<Row>;
      dispose(): void;
    };
    subRef.current = sub;
    return () => {
      sub.dispose();
      subRef.current = null;
    };
    // query/scope/limit are read at effect time; structuralKey is their stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, structuralKey]);

  if (!engine || trimmed === "") return EMPTY_SEARCH as UseSearchResult<Row>;
  // The view returns a stable result reference while unchanged, so downstream deps hold.
  return subRef.current?.current() ?? (EMPTY_SEARCH as UseSearchResult<Row>);
}

/**
 * Mutators always return the hybrid call shape (await it like Convex, or use .local/.server).
 * The call arity mirrors convex/react's `OptionalRestArgs`: a mutation with required args
 * requires them, an empty-args mutation can be called with `()`.
 */
export type LocalFirstMutator<Mutation extends FunctionReference<"mutation">> = (
  ...args: OptionalRestArgs<Mutation>
) => LocalFirstMutationCall<FunctionReturnType<Mutation>>;

/**
 * Convex-compatible useMutation. Args and result type are inferred from the
 * function reference (no explicit generics). Mutations with required args require
 * them; empty-args mutations can be called with `()`. The returned mutator yields the
 * hybrid call: `await it` resolves to the server result (Convex-identical), and
 * `.local` / `.server` are separately awaitable.
 */
export function useMutation<Mutation extends FunctionReference<"mutation">>(
  reference: Mutation
): LocalFirstMutator<Mutation> {
  type TArgs = FunctionArgs<Mutation>;
  type TResult = FunctionReturnType<Mutation>;
  const engine = useLocalFirstEngine();
  const convexMutation = ConvexReact.useMutation(reference as never) as (args: TArgs) => Promise<TResult>;
  const isLocal = engine !== null && engine.hasLocalMutation(reference);
  // Stable function NAME, not the per-access `api` proxy object — otherwise the
  // returned mutator changes every render and re-runs any effect that depends on it.
  const refKey = useMemo(() => (engine ? engine.functionName(reference) : null), [engine, reference]);

  return useMemo<LocalFirstMutator<Mutation>>(() => {
    // Empty-args mutations may be called with (); default the omitted args to {}.
    if (isLocal && engine) {
      return ((...args: OptionalRestArgs<Mutation>) =>
        engine.mutate<TArgs, TResult>(reference, (args[0] ?? {}) as TArgs)) as LocalFirstMutator<Mutation>;
    }
    // Fallback to Convex, but keep the uniform return type so .local/.server work.
    return ((...args: OptionalRestArgs<Mutation>) =>
      createFallbackMutationCall<TResult>(convexMutation((args[0] ?? {}) as TArgs))) as LocalFirstMutator<Mutation>;
    // reference is read at call time; refKey is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, convexMutation, isLocal, refKey]);
}

/**
 * Run several local-first mutations as ONE atomic write group (DX v4 §5): they apply
 * optimistically in order, push together in a single request, and the server commits or
 * rejects them as a unit (a rejected group reverts every op and surfaces once in
 * `useSyncRecovery().failedGroups`). The returned function takes a callback that issues
 * the mutations — sync or async, but it must NOT await a batched call's `.server` inside
 * the callback (the group hasn't been dispatched yet). Read a fresh insert's id
 * synchronously from the call's `.id` for insert-then-patch-same-row.
 *
 * ```tsx
 * const batch = useBatch();
 * const create = useMutation(api.issues.create);
 * const comment = useMutation(api.comments.create);
 * await batch(() => {
 *   const { id } = create({ ... });
 *   comment({ issue_id: id, ... });
 * }).local;
 * ```
 */
export function useBatch(): <T = unknown>(fn: () => void | Promise<void>) => LocalFirstBatchCall<T> {
  const engine = useLocalFirstEngine();
  return useCallback(
    <T = unknown>(fn: () => void | Promise<void>): LocalFirstBatchCall<T> => {
      if (!engine) {
        throw new Error("useBatch: no local-first engine (mount inside ConvexProvider with localFirst).");
      }
      return engine.batch<T>(fn);
    },
    [engine]
  );
}

export function useSyncStatus(): SyncStatus {
  const engine = useLocalFirstEngine();
  const [status, setStatus] = useState<SyncStatus>(() => engine?.getStatus() ?? EMPTY_STATUS);

  useEffect(() => {
    if (!engine) {
      return;
    }
    setStatus(engine.getStatus());
    return engine.subscribeStatus(() => setStatus(engine.getStatus()));
  }, [engine]);

  return status;
}

/** Durable writes requiring recovery. Rejected writes remain here across reloads;
 * olderSchemaOperations are read-only records from prior default namespaces for an
 * app-provided export/migration/discard flow. */
export function useSyncRecovery(): RecoveryStatus {
  return useSyncStatus().recovery;
}

/**
 * The caller's synced role in a membership scope (DX v4 §6). Pass the scope-value object
 * (e.g. `{ workspace_id }`); returns the role, `null` (denied / no access), or `undefined`
 * (not yet synced — the first pull hasn't landed, or the server is a 0.3.x build that omits
 * roles). Type the role via the generic: `useRole<Role>({ workspace_id })`. Reactive — it
 * re-renders when a pull updates the role or a logout clears it.
 *
 * ```tsx
 * const role = useRole<number>({ workspace_id });
 * if (role === undefined) return <Spinner />;   // still syncing
 * if (role === null) return <NoAccess />;        // denied
 * ```
 */
export function useRole<Role = unknown>(
  scope: Record<string, unknown> | null | undefined
): Role | null | undefined {
  const engine = useLocalFirstEngine();
  const scopeKey = useMemo(() => JSON.stringify(scope ?? null), [scope]);
  const [role, setRole] = useState<Role | null | undefined>(() =>
    engine ? (engine.getRole(scope) as Role | null | undefined) : undefined
  );
  useEffect(() => {
    if (!engine) {
      setRole(undefined);
      return;
    }
    const read = () => setRole(engine.getRole(scope) as Role | null | undefined);
    read();
    // Actively pull the scope so the role is fetched even without a mounted query on it.
    void engine.syncRoleScope(scope);
    return engine.subscribeRoles(read);
    // scope is read at effect time; scopeKey is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, scopeKey]);
  return role;
}

/**
 * The client-side write mirror (DX v4 §6): `{ insert, patch, remove }`, each returning
 * whether the CURRENT user (with their synced role) may perform the write per the table's
 * `clientCan.write`. Returns `true` when no mirror is declared, or the role isn't synced yet
 * — ADVISORY only, the server stays authoritative. Pass your modules type to `useCan<typeof
 * modules>()` for typed table names + row shapes.
 *
 * ```tsx
 * const can = useCan();
 * <Button disabled={!can.patch("issues", issue, { name })} />
 * ```
 */
export function useCan<Modules extends Record<string, unknown> = never>(): CanChecker<Modules> {
  const engine = useLocalFirstEngine();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!engine) return;
    return engine.subscribeRoles(() => setTick((t) => t + 1));
  }, [engine]);
  return useMemo(
    () =>
      ({
        insert: (table: string, proposed: Record<string, unknown>) =>
          engine ? engine.can(table, "insert", { proposed }) : true,
        patch: (table: string, row: Record<string, unknown>, patch?: Record<string, unknown>) =>
          engine ? engine.can(table, "patch", { before: row, patch, proposed: { ...row, ...(patch ?? {}) } }) : true,
        remove: (table: string, row: Record<string, unknown>) =>
          engine ? engine.can(table, "delete", { before: row, proposed: null }) : true
      }) as CanChecker<Modules>,
    // tick refreshes the checker identity when roles change, so consumers re-evaluate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, tick]
  );
}

/**
 * Undo/redo (DX v4 §7). Pass a scope-value object to scope the stacks to that
 * workspace/project (`useUndo({ workspace_id })`); omit it to operate across every scope
 * (most-recent action first). `undo`/`redo` emit ordinary local-first mutations — they
 * sync like any op; a batch group undoes as one unit.
 *
 * ```tsx
 * const { undo, redo, canUndo, canRedo } = useUndo({ workspace_id });
 * <button disabled={!canUndo} onClick={() => void undo()}>Undo</button>
 * ```
 */
export function useUndo(scope?: Record<string, unknown> | null): {
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
} {
  const engine = useLocalFirstEngine();
  const [tick, setTick] = useState(0);
  const scopeKey = useMemo(() => JSON.stringify(scope ?? null), [scope]);
  useEffect(() => {
    if (!engine) return;
    return engine.subscribeUndo(() => setTick((t) => t + 1));
  }, [engine]);
  return useMemo(
    () => ({
      undo: () => (engine ? engine.undo(scope) : Promise.resolve()),
      redo: () => (engine ? engine.redo(scope) : Promise.resolve()),
      canUndo: engine ? engine.canUndo(scope) : false,
      canRedo: engine ? engine.canRedo(scope) : false
    }),
    // scope is read at call time; scopeKey + tick are the stable identity + change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, scopeKey, tick]
  );
}

export type CreateAttachmentInput = {
  /** Metadata for the row — the args of your attachment table's `insert` mutation
   *  (workspace/issue ids, name, size, mimeType, …). `storageId` is server-controlled. */
  readonly metadata: Record<string, unknown>;
  /** The file/blob to upload. Persisted durably first, so creating offline succeeds. */
  readonly blob: Blob;
};

/**
 * Create attachments against a local-first table (P5). Pass the table's INSERT
 * mutation reference (e.g. `api.attachments.create`). The returned trigger inserts the
 * metadata row optimistically AND persists the blob durably — succeeding fully offline
 * — then the leader tab uploads in the background. Resolves the metadata row's
 * `localId` (pass it to `useAttachmentUpload` to watch progress).
 *
 * ```tsx
 * const create = useCreateAttachment(api.attachments.create);
 * const { localId } = await create({ metadata: { issue_id, name, size, mime_type }, blob });
 * ```
 */
export function useCreateAttachment(
  insert: FunctionReference<"mutation">
): (input: CreateAttachmentInput) => Promise<{ localId: string }> {
  const engine = useLocalFirstEngine();
  const refKey = useMemo(() => (engine ? engine.functionName(insert) : null), [engine, insert]);
  return useCallback(
    (input: CreateAttachmentInput) => {
      if (!engine) {
        return Promise.reject(new Error("useCreateAttachment: no local-first engine (mount inside ConvexProvider with localFirst)."));
      }
      return engine.createAttachment({ insert, metadata: input.metadata, blob: input.blob });
    },
    // insert is read at call time; refKey is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, refKey]
  );
}

const DEFAULT_ATTACHMENT_STATE: AttachmentUploadState = { state: "queued", progress: null };

/**
 * Live upload state for one attachment, by the metadata-row `localId` returned from
 * `useCreateAttachment`. `state` is `queued | uploading | done | failed`; `progress`
 * is a 0..1 fraction while uploading (from XHR upload events), null otherwise. A
 * failed upload also surfaces through `useSyncRecovery().failedAttachments`.
 */
export function useAttachmentUpload(localId: string | null | undefined): AttachmentUploadState {
  const engine = useLocalFirstEngine();
  const [state, setState] = useState<AttachmentUploadState>(
    () => (engine && localId ? engine.getAttachmentState(localId) : null) ?? DEFAULT_ATTACHMENT_STATE
  );
  useEffect(() => {
    if (!engine || !localId) {
      setState(DEFAULT_ATTACHMENT_STATE);
      return;
    }
    setState(engine.getAttachmentState(localId) ?? DEFAULT_ATTACHMENT_STATE);
    return engine.subscribeAttachment(localId, () =>
      setState(engine.getAttachmentState(localId) ?? DEFAULT_ATTACHMENT_STATE)
    );
  }, [engine, localId]);
  return state;
}

export type PresencePeer = {
  readonly clientId: string;
  readonly userId: string;
  readonly data: Record<string, unknown>;
  readonly updatedAt: number;
};

const EMPTY_PEERS: PresencePeer[] = [];

/**
 * Who is here right now — live avatars, "N online", typing indicators. Ephemeral
 * by design: presence rides plain Convex reactivity (heartbeats into the mounted
 * component, TTL-expired reads), never the sync log, and nothing persists locally.
 *
 * ```tsx
 * const { others } = usePresence({ workspace: workspaceId }, { name: "Ada", color: "#7c5cff" });
 * ```
 *
 * The scope is a sync scope, so the server enforces the same access rules as
 * pull: your own user scope (the default), or a workspace/project you are a
 * member of. `data` is broadcast to peers on each heartbeat.
 */
export function usePresence(
  scope?: { readonly workspace?: string; readonly project?: string },
  data?: Record<string, unknown>,
  options?: { readonly heartbeatMs?: number }
): { readonly peers: PresencePeer[]; readonly others: PresencePeer[] } {
  const presence = useContext(LocalFirstReactContext)?.presence ?? null;
  const heartbeatMs = options?.heartbeatMs ?? 10_000;
  const scopeKey = scope?.workspace
    ? `byWorkspace:${scope.workspace}`
    : scope?.project
      ? `byProject:${scope.project}`
      : `u:${presence?.userId ?? ""}`;

  // Live peers via plain Convex useQuery — every heartbeat is a table write, so
  // subscribers re-render at heartbeat granularity without polling.
  const listRef = makeFunctionReference<"query">(presence?.listName ?? "sync:presenceList");
  const peers =
    (ConvexReact.useQuery(
      listRef as never,
      (presence ? { scopeKey, userId: presence.userId ?? "" } : "skip") as never
    ) as PresencePeer[] | undefined) ?? EMPTY_PEERS;

  // The heartbeat loop reads `data` through a ref so a changing object doesn't
  // restart it. ponytail: a data change is broadcast on the NEXT beat (≤ heartbeatMs);
  // lower heartbeatMs if you push fast-changing data like cursors.
  const dataRef = useRef<Record<string, unknown>>(data ?? {});
  dataRef.current = data ?? {};
  useEffect(() => {
    if (!presence) {
      return;
    }
    const beatRef = makeFunctionReference<"mutation">(presence.beatName);
    const send = (leaving?: boolean) =>
      void presence.client
        .mutation(
          beatRef as never,
          {
            scopeKey,
            clientId: presence.clientId,
            userId: presence.userId ?? "",
            data: dataRef.current,
            leaving
          } as never
        )
        .catch(() => {
          // Presence is best-effort: an offline or rejected beat simply means we
          // appear absent until the next successful one.
        });
    send();
    const timer = setInterval(() => send(), heartbeatMs);
    const onUnload = () => send(true);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", onUnload);
      send(true);
    };
  }, [presence, scopeKey, heartbeatMs]);

  return useMemo(
    () => ({ peers, others: presence ? peers.filter((p) => p.clientId !== presence.clientId) : peers }),
    [peers, presence]
  );
}
