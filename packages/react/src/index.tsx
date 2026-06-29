import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as ConvexReact from "convex/react";
import { getFunctionName, makeFunctionReference } from "convex/server";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import {
  IndexedDbStore,
  MemoryLocalStore,
  collection,
  createClientId,
  createConvexTransport,
  createLocalFirstEngine,
  many,
  manyToMany,
  one,
  type FunctionNameResolver,
  type LocalFirstManifest,
  type LocalFirstMutationCall,
  type LocalQueryPlan,
  type LocalStore,
  type RelationSpec,
  type RowValue,
  type SyncStatus,
  type SyncTransport
} from "@convex-localfirst/core";
// Engine + low-level helpers are INTERNAL (I13): imported from the internal subpath,
// never re-exported to app authors. See @convex-localfirst/core/internal.
import {
  LocalFirstEngine,
  coordinationName,
  createFallbackMutationCall,
  createMultiTabSync,
  defaultFunctionName
} from "@convex-localfirst/core/internal";

export { collection, many, manyToMany, one };
export type { LocalQueryPlan, RelationSpec };

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
  partial: false
};

export type LocalFirstProviderConfig = {
  readonly manifest: LocalFirstManifest;
  readonly transport?: SyncTransport;
  /** Local store. Defaults to an in-memory store; pass an IndexedDbStore in the browser. */
  readonly store?: LocalStore;
  readonly clientId?: string;
  readonly userId?: string | null;
  readonly nameOf?: FunctionNameResolver;
};

type LocalFirstReactContextValue = {
  readonly engine: LocalFirstEngine;
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
  readonly manifest: LocalFirstManifest;
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
          namespace: options.namespace ?? userId ?? "default"
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
  const engine = createLocalFirstEngine({
    manifest: options.manifest,
    store,
    transport,
    clientId,
    userId,
    nameOf: convexFunctionName
  });
  // Runtime is core's engine; the cast only adds the convex-typed mutate/query overloads
  // (same methods, inferred arg/return types). Sound: the runtime signatures are wider.
  return { engine: engine as unknown as ConvexLocalFirstEngine, client };
}

function raise(message: string): never {
  throw new Error(message);
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
      <LocalFirstProvider {...props.localFirst}>{props.children}</LocalFirstProvider>
    </ConvexReact.ConvexProvider>
  );
}

// Internal: the explicit-config provider. Users mount the local-first layer via
// the public `ConvexProvider` (drop-in name) + its `localFirst` prop.
function LocalFirstProvider(props: LocalFirstProviderConfig & { readonly children: React.ReactNode }) {
  // Resolve the store ONCE per provider instance, with the SAME deps as the engine, so
  // (a) an app that inlines a fresh store object each render doesn't thrash the engine,
  // and (b) the multi-tab coordination key below is derived from the EXACT store the
  // engine holds — never an old-engine-under-a-new-store-namespace mismatch.
  const store = useMemo(
    () => props.store ?? new MemoryLocalStore(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.manifest, props.userId, props.transport, props.nameOf]
  );
  const engine = useMemo(() => {
    return new LocalFirstEngine({
      manifest: props.manifest,
      store,
      clientId: props.clientId ?? createClientId(),
      userId: props.userId ?? null,
      transport: props.transport,
      nameOf: props.nameOf ?? reactDefaultFunctionName
    });
    // clientId is intentionally captured once; store moves in lockstep (same deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.manifest, props.userId, props.transport, props.nameOf, store]);

  // The engine self-wires browser connectivity in its constructor — reflecting
  // navigator.onLine into the sync status and flushing the offline outbox on reconnect
  // (see LocalFirstEngine.wireConnectivity). The provider used to duplicate that here;
  // it doesn't anymore. We only need to dispose the engine-owned listeners when the engine
  // is replaced (manifest/user/transport/store change) or the provider unmounts, so they
  // don't leak across recreations.
  useEffect(() => () => engine.dispose(), [engine]);

  // Multi-tab coordination: elect one leader (only it runs the background batch push)
  // and poke other tabs to re-read the shared IndexedDB after a pull. Engaged only with
  // the crash-safe Web Locks primitive present (every modern browser); without it — SSR,
  // jsdom tests, old browsers — every tab syncs independently exactly as before.
  const userId = props.userId ?? null;
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

  const value = useMemo(() => ({ engine }), [engine]);
  return <LocalFirstReactContext.Provider value={value}>{props.children}</LocalFirstReactContext.Provider>;
}

// Internal: the engine never appears in the public type surface (GOAL §6/I13).
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

/**
 * Convex-compatible useQuery. Args and result type are inferred from the Convex
 * function reference (drop-in, no explicit generics — exactly like `convex/react`).
 * Local-first functions read from the engine and subscribe to local changes;
 * everything else falls through to Convex.
 *
 * All hooks below run unconditionally on every render (no rules-of-hooks
 * violation): the Convex hook is fed "skip" for local-first functions, and the
 * local subscription is inert when there is no engine/local definition.
 */
export function useQuery<Query extends FunctionReference<"query">>(
  reference: Query,
  args?: FunctionArgs<Query> | "skip",
  options?: UseLocalFirstQueryOptions<FunctionReturnType<Query>>
): FunctionReturnType<Query> | undefined {
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
    const unsubscribe = engine.subscribe(run);
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

export function useLiveQuery<Row extends Record<string, unknown> = RowValue, Rel = unknown>(
  query: LocalQueryPlan<Row, Rel> | "skip",
  options?: UseLiveQueryOptions
): Array<Row & Rel> | undefined {
  const engine = useLocalFirstEngine();
  const [rowsByTable, setRowsByTable] = useState<Record<string, readonly RowValue[]> | undefined>(undefined);
  const lastResult = useRef<Array<Row & Rel> | undefined>(undefined);

  // The tables this query reads: its base table + any relation targets/join
  // tables. A stable sorted key so an inline-rebuilt query object (or added
  // relations) re-subscribes only when the table SET actually changes.
  const tables = query === "skip" || !engine ? [] : engine.tablesForPlan(query);
  const tablesKey = tables.length ? [...tables].sort().join(",") : null;

  // Subscribe to every read table's live rows; re-pull all on any local change.
  useEffect(() => {
    if (!engine || query === "skip") {
      setRowsByTable(undefined);
      return;
    }
    const wanted = engine.tablesForPlan(query);
    let alive = true;
    const pull = () => {
      void Promise.all(wanted.map((t) => engine.tableRows(t).then((rows) => [t, rows] as const))).then((entries) => {
        if (alive) {
          setRowsByTable(Object.fromEntries(entries));
        }
      });
    };
    pull();
    const unsubscribe = engine.subscribe(pull);
    return () => {
      alive = false;
      unsubscribe();
    };
    // query is read at effect time; tablesKey is the stable identity of its read set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, tablesKey]);

  // Background sync for this query's scope (push pending + pull). Keyed on the
  // scope values + read set, not the per-render query object.
  const scopeKey = query === "skip" ? null : JSON.stringify(query.scopeValues ?? null);
  const pollMs = options?.pollMs;
  useEffect(() => {
    if (!engine || query === "skip") {
      return;
    }
    void engine.refreshPlan(query);
    // Prefer true server-push: a reactive transport drains this scope the instant
    // the server has a change — no idle polling, instant cross-client updates.
    const unwatch = engine.watchPlan(query);
    if (unwatch) {
      return unwatch;
    }
    // Fallback for a non-reactive transport (e.g. the HTTP client, or tests): poll
    // the scope when the caller opted in. refreshPlan never throws and pulls only
    // changes after the cursor, so an idle poll is cheap.
    if (!pollMs) {
      return;
    }
    const timer = setInterval(() => {
      void engine.refreshPlan(query);
    }, pollMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, tablesKey, scopeKey, pollMs]);

  if (query === "skip" || rowsByTable === undefined || !engine) {
    lastResult.current = undefined;
    return undefined;
  }
  // Route through the engine (not query.run directly) so the scoped fail-closed
  // guard + relation attach are enforced. Return a stable array reference when the
  // result is unchanged (no-relation case), so it's safe in downstream deps.
  const next = engine.applyLocalQuery(query, rowsByTable);
  const prev = lastResult.current;
  if (prev && prev.length === next.length && prev.every((row, i) => row === next[i])) {
    return prev;
  }
  lastResult.current = next;
  return next;
}

/** Mutators always return the hybrid call shape (await it like Convex, or use .local/.server). */
export type LocalFirstMutator<TArgs, TResult> = (args: TArgs) => LocalFirstMutationCall<TResult>;

/**
 * Convex-compatible useMutation. Args and result type are inferred from the
 * function reference (no explicit generics). The returned mutator yields the
 * hybrid call: `await it` resolves to the server result (Convex-identical), and
 * `.local` / `.server` are separately awaitable.
 */
export function useMutation<Mutation extends FunctionReference<"mutation">>(
  reference: Mutation
): LocalFirstMutator<FunctionArgs<Mutation>, FunctionReturnType<Mutation>> {
  type TArgs = FunctionArgs<Mutation>;
  type TResult = FunctionReturnType<Mutation>;
  const engine = useLocalFirstEngine();
  const convexMutation = ConvexReact.useMutation(reference as never) as (args: TArgs) => Promise<TResult>;
  const isLocal = engine !== null && engine.hasLocalMutation(reference);
  // Stable function NAME, not the per-access `api` proxy object — otherwise the
  // returned mutator changes every render and re-runs any effect that depends on it.
  const refKey = useMemo(() => (engine ? engine.functionName(reference) : null), [engine, reference]);

  return useMemo<LocalFirstMutator<TArgs, TResult>>(() => {
    if (isLocal && engine) {
      return (args: TArgs) => engine.mutate<TArgs, TResult>(reference, args);
    }
    // Fallback to Convex, but keep the uniform return type so .local/.server work.
    return (args: TArgs) => createFallbackMutationCall<TResult>(convexMutation(args));
    // reference is read at call time; refKey is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, convexMutation, isLocal, refKey]);
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

