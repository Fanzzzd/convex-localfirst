import type { LocalQueryPlan } from "./collection.js";
import { attachRelations, relationTables } from "./relations.js";
import { createDefaultIdFactory, createOpId, type IdFactory } from "./id.js";
import type { FunctionNameResolver } from "./functionName.js";
import { defaultFunctionName } from "./functionName.js";
import type { LocalFirstManifest, LocalMutationDefinition, LocalQueryDefinition } from "./manifest.js";
import { createLocalFirstMutationCall, type LocalFirstMutationCall } from "./mutationCall.js";
import {
  computeCounterDelta,
  computeSetDelta,
  isCounterDelta,
  isSetDelta,
  type CounterDelta,
  type SetDelta
} from "./setMerge.js";
import type { LocalStore } from "./storage.js";
import type { SyncTransport } from "./transport.js";
import { createOfflineTransport } from "./transport.js";
import type {
  FunctionName,
  LocalCommit,
  LocalOperation,
  MutationStatus,
  RowValue,
  SyncScope,
  SyncStatus
} from "./types.js";

export type LocalFirstEngineOptions = {
  readonly manifest: LocalFirstManifest;
  readonly store: LocalStore;
  readonly clientId: string;
  readonly userId?: string | null;
  readonly transport?: SyncTransport;
  readonly nameOf?: FunctionNameResolver;
  readonly idFactory?: IdFactory;
  readonly clock?: () => number;
  /** Network retry policy for background sync. */
  readonly retry?: { readonly retries: number; readonly baseDelayMs: number };
  /** Injectable delay (tests pass a no-op to avoid real waits). */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Hard cap (ms) on a single push/pull, so an unreachable server (online but not
   * responding) can't hang sync — or an awaited read — forever. On timeout the call fails
   * fast (ops stay pending). 0 disables. Default 15000. Complements the navigator.onLine
   * guard, which handles a hard OS-offline.
   */
  readonly syncTimeoutMs?: number;
};

// Backstop for the pull drain loop; the real exits are "no hasMore" and "cursor stalled".
// Generous so a large cold start drains in one go.
const MAX_PULL_ROUNDS = 10000;

/** True for the server's idempotent no-op-delete ack ({ noop: true }) — an accepted op
 *  that produced NO canonical change, so it must be dropped from the outbox explicitly. */
function isNoopAck(serverResult: unknown): boolean {
  return typeof serverResult === "object" && serverResult !== null && (serverResult as { noop?: unknown }).noop === true;
}

export class LocalFirstEngine {
  readonly manifest: LocalFirstManifest;
  // Private: raw store reads are UNSCOPED. App code reads through the hooks
  // (useQuery/useLiveQuery), which enforce the scoped fail-closed guard.
  private readonly store: LocalStore;
  readonly clientId: string;
  private readonly userId: string | null;
  private readonly transport: SyncTransport;
  private readonly nameOf: FunctionNameResolver;
  private readonly idFactory: IdFactory;
  private readonly clock: () => number;
  private readonly retry: { readonly retries: number; readonly baseDelayMs: number };
  private readonly syncTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private status: SyncStatus = {
    online: true,
    syncing: false,
    pendingMutations: 0,
    lastPushAt: null,
    lastPullAt: null,
    lastError: null,
    blockedBySchemaMismatch: false,
    partial: false
  };
  private readonly opStatuses = new Map<string, MutationStatus>();
  // Separate from the store's data-change listeners so a status change (online/syncing/
  // pending) wakes only useSyncStatus, not every data query (avoids a re-render storm).
  private readonly statusListeners = new Set<() => void>();
  // Refcounted reactive subscriptions, keyed by scope: many hooks on one scope share ONE
  // watch + drain loop instead of a per-hook herd of redundant pulls.
  private readonly scopeWatchers = new Map<string, { count: number; dispose: () => void }>();
  // Removes the engine-owned browser online/offline listeners (noop outside a browser).
  private disposeConnectivity: () => void = () => {};
  // Multi-tab leadership gate (set by the provider's TabLeadership). A follower suppresses
  // only the BACKGROUND batch push so the shared outbox is pushed by one tab; pull/watch,
  // explicit mutations, and the reconnect flush are never gated. Defaults true (lone tab/
  // SSR/tests sync as normal).
  private syncEnabled = true;
  // High-water mark keeping operation createdAt (the I4 replay key) strictly increasing per
  // engine, so a backward wall-clock step can't reorder two local edits. seeded across
  // reloads from durable ops by seedTimestampHighWater().
  private tsHighWater = 0;

  constructor(options: LocalFirstEngineOptions) {
    this.manifest = options.manifest;
    this.store = options.store;
    this.clientId = options.clientId;
    this.userId = options.userId ?? null;
    this.transport = options.transport ?? createOfflineTransport();
    this.nameOf = options.nameOf ?? defaultFunctionName;
    this.idFactory = options.idFactory ?? createDefaultIdFactory();
    this.clock = options.clock ?? (() => Date.now());
    this.retry = options.retry ?? { retries: 3, baseDelayMs: 100 };
    this.syncTimeoutMs = options.syncTimeoutMs ?? 15000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // Reflect any operations already durable in the store (e.g. after a reload)
    // so getStatus() is accurate without waiting for the first sync.
    void this.refreshPendingCount();
    void this.seedTimestampHighWater();
    // Offline-first connectivity, owned by the engine so EVERY consumer (headless or
    // React) gets it — not just apps that remember to wire window events themselves.
    this.disposeConnectivity = this.wireConnectivity();
  }

  /** Wall-clock timestamp that never goes backward within this engine, so a backward
   *  clock step cannot reorder two local edits (I4). */
  private monotonicNow(): number {
    const t = Math.max(this.clock(), this.tsHighWater + 1);
    this.tsHighWater = t;
    return t;
  }

  /** Seed the high-water from durable ops so monotonic order holds across reloads.
   *  ponytail: an op created before this async seed resolves could predate it — needs a
   *  backward clock step AND reload AND a same-row edit in that window; acceptable. */
  private async seedTimestampHighWater(): Promise<void> {
    try {
      for (const op of await this.store.getAllOperations()) {
        if (op.createdAt > this.tsHighWater) {
          this.tsHighWater = op.createdAt;
        }
      }
    } catch {
      // In-session monotonicity still holds from 0; only the cross-reload seed is lost.
    }
  }

  /** Merge a status patch and notify subscribers so useSyncStatus re-renders. */
  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of Array.from(this.statusListeners)) {
      listener();
    }
  }

  /**
   * Resolve a function reference to its stable name. The React adapter keys effects on
   * this string, not the reference object, because Convex's `api` proxy returns a fresh
   * object per access — keying on identity would re-run the effect every render (a sync loop).
   */
  functionName(reference: unknown): string | null {
    return this.safeName(reference);
  }

  /**
   * Run a transport call and reflect connectivity in status.online (threw → offline,
   * returned → online). ponytail: heuristic — a server-side error also reads as offline;
   * the navigator online/offline events give finer detection.
   */
  private async tracked<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.setStatus({ online: true });
      return result;
    } catch (error) {
      this.setStatus({ online: false });
      throw error;
    }
  }

  hasLocalQuery(reference: unknown): boolean {
    return this.getQueryDefinition(reference) !== null;
  }

  hasLocalMutation(reference: unknown): boolean {
    return this.getMutationDefinition(reference) !== null;
  }

  async query<TArgs, TResult>(reference: unknown, args: TArgs): Promise<TResult | undefined> {
    const definition = this.getQueryDefinition<TArgs, TResult>(reference);
    if (!definition) {
      return undefined;
    }
    if (this.scopedQueryMissingScope(definition.table, args)) {
      // Fail closed: a workspace/project query whose args lack the scope value
      // must not return the whole cached table (which can span scopes). Same
      // invariant runLocalQuery enforces for the collection() builder.
      return definition.initial;
    }
    const rows = await this.store.getRows(definition.table);
    const scoped = this.filterToScope(definition.table, rows, args);
    const visibleRows = scoped.filter((row) => !row._deleted);
    return definition.run(visibleRows, args, { now: this.clock() });
  }

  /**
   * Keep only rows in the active scope (owner==userId for byUser, field==value for
   * byWorkspace/byProject). The client caches every scope the user can see, so a query
   * with an incomplete filter could otherwise observe another scope's rows; enforcing it
   * here mirrors the server's I7. `custom` scopes have no client-known field → server-only.
   */
  private filterToScope(table: string, rows: readonly RowValue[], scopeArgs: unknown): readonly RowValue[] {
    const scope = this.manifest.tables[table]?.scope;
    if (!scope) {
      return rows;
    }
    if (scope.kind === "byUser") {
      // Anonymous/local-only mode (no userId) has no owner to match; leave as-is.
      return this.userId == null ? rows : rows.filter((row) => row[scope.field] === this.userId);
    }
    if (scope.kind === "byWorkspace" || scope.kind === "byProject") {
      const field = scope.kind === "byWorkspace" ? scope.workspaceIdField : scope.projectIdField;
      const value = (scopeArgs as Record<string, unknown> | null | undefined)?.[field];
      // Missing value is already failed-closed by scopedQueryMissingScope; if it ever
      // reaches here without one, do not silently widen to all scopes — return none.
      return value == null ? [] : rows.filter((row) => row[field] === value);
    }
    return rows;
  }

  /** True when `table` is workspace/project-scoped but `args` carry no scope value. */
  private scopedQueryMissingScope(table: string, args: unknown): boolean {
    const definition = this.manifest.tables[table];
    if (!definition || (definition.scope.kind !== "byWorkspace" && definition.scope.kind !== "byProject")) {
      return false;
    }
    const field =
      definition.scope.kind === "byWorkspace" ? definition.scope.workspaceIdField : definition.scope.projectIdField;
    return (args as Record<string, unknown> | null)?.[field] == null;
  }

  /**
   * @internal All visible (non-deleted) rows for a table, from the derived view
   * (I1). UNSCOPED plumbing for useLiveQuery's subscription — the hook only ever
   * returns these through `applyLocalQuery` (the scoped guard). Not an app API.
   */
  async tableRows(table: string): Promise<readonly RowValue[]> {
    const rows = await this.store.getRows(table);
    return rows.filter((row) => !row._deleted);
  }

  /** Every table a plan reads: its base table plus any relation targets/join tables. */
  tablesForPlan(plan: LocalQueryPlan): string[] {
    return [plan.table, ...relationTables(plan.relations)];
  }

  /**
   * Apply a query plan to already-fetched rows (keyed by table), enforcing the
   * scoped fail-closed guard and attaching relations in memory. Synchronous so the
   * React hook (useLiveQuery) can call it at render and cannot bypass the guard by
   * running plan.run directly.
   */
  applyLocalQuery<Row extends Record<string, unknown>, Rel>(
    plan: LocalQueryPlan<Row, Rel>,
    rowsByTable: Record<string, readonly RowValue[]>
  ): Array<Row & Rel> {
    if (this.scopedQueryMissingScope(plan.table, plan.scopeValues)) {
      // Fail closed: a workspace/project query with no scope value must not return
      // the whole local cache (which can span scopes). Empty .scope({}) lands here.
      return [];
    }
    const scoped = this.filterToScope(plan.table, rowsByTable[plan.table] ?? [], plan.scopeValues);
    const base = plan.run(scoped);
    return attachRelations(base, plan.relations, rowsByTable) as Array<Row & Rel>;
  }

  async runLocalQuery<Row extends Record<string, unknown>, Rel>(
    plan: LocalQueryPlan<Row, Rel>
  ): Promise<Array<Row & Rel>> {
    const rowsByTable: Record<string, readonly RowValue[]> = {};
    for (const table of this.tablesForPlan(plan)) {
      rowsByTable[table] = await this.tableRows(table);
    }
    return this.applyLocalQuery(plan, rowsByTable);
  }

  /**
   * One-call imperative read for the service-layer path: background-refresh the plan's
   * scope (offline-safe, never throws), then return the merged local rows (canonical +
   * pending). Prefer over hand-orchestrating refreshPlan + runLocalQuery. For reactive UI
   * use useLiveQuery instead.
   */
  async read<Row extends Record<string, unknown>, Rel>(
    plan: LocalQueryPlan<Row, Rel>
  ): Promise<Array<Row & Rel>> {
    await this.refreshPlan(plan);
    return this.runLocalQuery(plan);
  }

  /**
   * Read a single live row by id (== row[idField] == _id), or undefined. Local-only, no
   * server pull — for the "I just wrote id X, read it back" case (the write already flushes
   * via its own .server push). Includes pending optimistic state. For a possibly-cold row
   * (e.g. a deep link), use a scoped query so refreshPlan can pull it first.
   */
  async getRow<Row extends Record<string, unknown>>(table: string, id: string): Promise<Row | undefined> {
    const rows = await this.tableRows(table);
    return rows.find((row) => row._id === id) as Row | undefined;
  }

  /**
   * Pull scope for a query plan: the explicit workspace/project value when the
   * table is scoped that way, else the authed user. Key format mirrors the
   * declarative path so pull cursors and server membership checks line up.
   */
  scopeForPlan(plan: LocalQueryPlan): SyncScope | null {
    const definition = this.manifest.tables[plan.table];
    if (!definition) {
      return null;
    }
    const scope = definition.scope;
    if (scope.kind === "byUser") {
      return this.userId ? { kind: "byUser", key: `u:${this.userId}`, table: plan.table } : null;
    }
    if (scope.kind === "byWorkspace") {
      const value = plan.scopeValues?.[scope.workspaceIdField];
      return value == null ? null : { kind: "byWorkspace", key: `byWorkspace:${String(value)}`, table: plan.table };
    }
    if (scope.kind === "byProject") {
      const value = plan.scopeValues?.[scope.projectIdField];
      return value == null ? null : { kind: "byProject", key: `byProject:${String(value)}`, table: plan.table };
    }
    return null;
  }

  /** Background sync for a mounted plan (push pending + pull its scope). Never throws. */
  async refreshPlan(plan: LocalQueryPlan): Promise<void> {
    const scope = this.scopeForPlan(plan);
    if (!scope) {
      // A workspace/project table with no .scope({...}) can neither filter nor
      // pull — it would silently show stale/empty data. Surface the misconfig
      // (this is a developer error, not a runtime condition, so always warn).
      const kind = this.manifest.tables[plan.table]?.scope.kind;
      if ((kind === "byWorkspace" || kind === "byProject") && !plan.scopeValues) {
        console.warn(
          `[convex-localfirst] useLiveQuery on "${plan.table}" is missing .scope({...}); it will not sync from the server.`
        );
      }
    }
    try {
      await this.syncOnce(scope ? [scope] : []);
    } catch {
      // Swallowed: status.lastError already captures it; background sync must not throw to React.
    }
  }

  /** True when the transport offers a reactive change feed (server push). When
   *  false, callers fall back to polling for real-time. */
  get reactive(): boolean {
    return typeof this.transport.subscribe === "function";
  }

  /**
   * Reactive sync for a mounted plan: subscribe to the transport's change feed for
   * this plan's scope and drain (pull) on every server-side change — true server
   * push, no polling. Returns an unsubscribe, or `null` when the transport is not
   * reactive (the caller should fall back to polling) or the plan has no scope.
   */
  watchPlan(plan: LocalQueryPlan): (() => void) | null {
    const subscribe = this.transport.subscribe;
    if (!subscribe) {
      return null;
    }
    const scope = this.scopeForPlan(plan);
    if (!scope) {
      return null;
    }
    return this.watchScope(scope, subscribe.bind(this.transport));
  }

  /**
   * Reactive sync for a declarative (server-defined) query — the `useQuery` path. Like
   * `watchPlan` but resolves the scope from the query DEFINITION. Returns an unsubscribe,
   * or `null` when not reactive / no scope. This is what makes our `useQuery` reactive
   * like `convex/react`'s.
   */
  watchQuery<TArgs>(reference: unknown, args: TArgs): (() => void) | null {
    const subscribe = this.transport.subscribe;
    if (!subscribe) {
      return null;
    }
    const definition = this.getQueryDefinition<TArgs, unknown>(reference);
    if (!definition || this.scopedQueryMissingScope(definition.table, args)) {
      return null;
    }
    const scope = definition.scope?.(args) ?? this.scopeForTable(definition.table);
    if (!scope) {
      return null;
    }
    return this.watchScope(scope, subscribe.bind(this.transport));
  }

  /**
   * Refcounted entry point: many hooks watching the SAME scope share ONE watch + drain
   * loop (started on the first watcher, torn down on the last). Returns an idempotent unwatch.
   */
  private watchScope(scope: SyncScope, subscribe: NonNullable<SyncTransport["subscribe"]>): () => void {
    const key = scope.key;
    let entry = this.scopeWatchers.get(key);
    if (!entry) {
      entry = { count: 0, dispose: this.startScopeWatch(scope, subscribe) };
      this.scopeWatchers.set(key, entry);
    }
    entry.count++;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      entry.count--;
      if (entry.count === 0) {
        entry.dispose();
        this.scopeWatchers.delete(key);
      }
    };
  }

  /**
   * Drive one scope's subscription. The doorbell carries no data, so each fire triggers a
   * real `pullScopes` drain, then re-subscribes at the advanced cursor: a fixed-cursor
   * watch grows until it saturates the page limit and goes deaf, so re-pinning keeps the
   * window small. Only resubscribing when the cursor moved avoids an empty-fire loop.
   */
  private startScopeWatch(scope: SyncScope, subscribe: NonNullable<SyncTransport["subscribe"]>): () => void {
    let disposed = false;
    let unsubscribe: () => void = () => {};
    let draining = false;
    let refireQueued = false;
    let cursor: string | null = null;

    const subscribeAt = (at: string | null): void => {
      if (disposed) {
        return;
      }
      unsubscribe = subscribe(
        {
          clientId: this.clientId,
          userId: this.userId,
          schemaVersion: this.manifest.schemaVersion,
          scopes: [scope],
          cursors: { [scope.key]: at }
        },
        onDoorbell
      );
    };

    const onDoorbell = (): void => {
      if (disposed) {
        return;
      }
      if (draining) {
        // A change arrived mid-drain; coalesce into ONE re-drain after this pass so
        // a burst can't stampede overlapping pulls.
        refireQueued = true;
        return;
      }
      draining = true;
      void this.pullScopes([scope])
        .catch((error) => {
          // A reactive drain must never throw into the subscription. pullScopes does
          // NOT set lastError on its own (only syncOnce does), so surface it here so a
          // failing server-push (auth/query/transport error) is visible to the UI.
          this.setStatus({ lastError: error instanceof Error ? error.message : String(error) });
        })
        .then(async () => {
          draining = false;
          if (disposed) {
            return;
          }
          const next = await this.store.getCursor(scope.key);
          if (next !== cursor) {
            // The log advanced — repin the watch to the new tail (bounds payload).
            cursor = next;
            unsubscribe();
            subscribeAt(cursor);
          } else if (refireQueued) {
            refireQueued = false;
            onDoorbell();
          }
        });
    };

    void this.store.getCursor(scope.key).then((c) => {
      if (disposed) {
        return;
      }
      cursor = c;
      subscribeAt(cursor);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }

  /** Subscribe to local DATA changes (rows). Used by useQuery. */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  /** Subscribe to SYNC STATUS changes (online/syncing/pending). Used by useSyncStatus. */
  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  mutate<TArgs, TResult = unknown>(reference: unknown, args: TArgs): LocalFirstMutationCall<TResult> {
    const definition = this.getMutationDefinition<TArgs, TResult>(reference);
    if (!definition) {
      throw new Error("Cannot run local-first mutation because the function is not in the manifest");
    }

    const opId = createOpId(this.clientId);
    const planned = definition.plan(args, {
      now: this.clock(),
      clientId: this.clientId,
      userId: this.userId,
      localId: (table) => this.idFactory(table)
    });
    const id = planned.kind === "insert" ? planned.id ?? this.idFactory(planned.table) : planned.id;
    // Stamp the table's idField onto the inserted value so an OPTIMISTIC row carries
    // its id field exactly like a server-synced one (createSyncFunctions sets
    // value[idField] = localId on the server). Without this, row[idField] is undefined
    // until the first sync round-trip while row._id is set — a real optimistic-vs-synced
    // inconsistency that forces every reader to special-case `_id`. id wins (it IS the
    // assigned local id), matching the server's re-stamp, so the two never diverge.
    const idField = this.manifest.tables[planned.table]?.idField;
    const insertValue =
      planned.kind === "insert"
        ? idField
          ? { ...planned.value, [idField]: id }
          : planned.value
        : undefined;
    const operation: LocalOperation = {
      opId,
      clientId: this.clientId,
      userId: this.userId,
      schemaVersion: this.manifest.schemaVersion,
      functionName: definition.name,
      table: planned.table,
      kind: planned.kind,
      id,
      args: args as never,
      value: insertValue,
      patch: planned.kind === "patch" ? planned.patch : undefined,
      createdAt: this.monotonicNow(),
      status: "pending"
    };

    const local = this.commitLocal(operation);
    const server = local.then(() => this.pushSingleOperation<TResult>(operation));
    // The optimistic caller usually awaits only `.local`, so without this nothing handles a
    // failed background push and it becomes an unhandled rejection. The failure is already in
    // status.lastError and the op stays pending for retry. .catch marks it handled without
    // altering `server`, so a caller who awaits `.server`/the call still observes the rejection.
    server.catch(() => {});

    return createLocalFirstMutationCall<TResult>({
      opId,
      local,
      server,
      status: () => this.operationStatus(operation.opId)
    });
  }

  async syncOnce(scopes: readonly SyncScope[] = []): Promise<void> {
    if (this.status.blockedBySchemaMismatch) {
      // A schema mismatch is not retryable by syncing; the client must upgrade.
      return;
    }
    this.setStatus({ syncing: true, lastError: null });
    try {
      await this.pushPendingOperations();
      await this.pullScopes(scopes);
      this.setStatus({ syncing: false });
    } catch (error) {
      this.setStatus({ syncing: false, lastError: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      await this.refreshPendingCount();
    }
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  /** Reflect externally-known connectivity (e.g. the browser's online/offline events). */
  setOnline(online: boolean): void {
    this.setStatus({ online });
  }

  /**
   * Self-wire browser connectivity so offline-first works with zero consumer setup: going
   * offline makes sync a no-op (so reads/writes don't hang on a buffering socket), and
   * reconnect flushes the outbox. Returns a remover; a noop outside a browser. Safe to
   * double-wire with the React provider (setOnline is idempotent; flushPending dedupes).
   */
  private wireConnectivity(): () => void {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return () => {};
    }
    const onOnline = () => {
      this.setOnline(true);
      this.flushPending();
    };
    const onOffline = () => this.setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.setStatus({ online: false }); // seed current state; no flush on init
    }
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }

  /** Remove engine-owned browser listeners. Optional: a singleton engine that lives
   *  for the page lifetime need not call this; provided for tests / teardown. */
  dispose(): void {
    this.disposeConnectivity();
    this.disposeConnectivity = () => {};
  }

  /**
   * A HARD offline signal only (navigator.onLine === false), where a push/pull would just
   * hang on a buffering client. Deliberately NOT gated on the softer status.online, which a
   * transient server error can flip false — that would wedge sync off while genuinely online.
   */
  private isLikelyOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  /**
   * Multi-tab leadership gate (wired by the React provider). Only the leader runs the
   * background batch push; a follower keeps pulling but doesn't re-push the shared outbox.
   * On regaining leadership we flush immediately so an inherited backlog isn't stranded.
   */
  setSyncEnabled(enabled: boolean): void {
    if (this.syncEnabled === enabled) {
      return;
    }
    this.syncEnabled = enabled;
    if (enabled) {
      this.flushPending();
    }
  }

  /**
   * Explicit, UN-gated push of the outbox (reconnect flush, leadership handoff, or a
   * cross-tab wake). Distinct from the background push so an offline-created op in a
   * follower tab is not stranded waiting for the leader's next trigger. Never throws.
   */
  flushPending(): void {
    void this.pushPendingOperations({ force: true }).catch(() => {
      // status.lastError already records it; an explicit flush must not throw to callers.
    });
  }

  /**
   * Cross-tab "db changed" poke: IndexedDB has no cross-tab change event, so when the
   * leader pulls into the shared DB, follower tabs are told to re-derive. Safe to over-call
   * (applyServerChanges is version-folded, so a re-read only surfaces equal-or-newer rows).
   */
  pokeLocalChange(): void {
    this.store.notify();
  }

  /**
   * Background sync triggered by a mounted query: push pending ops and pull this
   * query's scope (if the definition declares one). Never throws — failures are
   * recorded in status.lastError for the UI.
   */
  async refreshQuery<TArgs>(reference: unknown, args: TArgs): Promise<void> {
    const definition = this.getQueryDefinition<TArgs, unknown>(reference);
    if (!definition) {
      return;
    }
    if (this.scopedQueryMissingScope(definition.table, args)) {
      // Fail closed: don't pull a scoped table with no scope value (it would build
      // a "byWorkspace:undefined" key). Matches the read-side guard in query().
      return;
    }
    // Prefer an explicit per-query scope; otherwise derive it from the table's
    // scope definition + the authed user so the pull cursor key matches the
    // server's scopeKey (e.g. "u:<userId>").
    const scope = definition.scope?.(args) ?? this.scopeForTable(definition.table);
    try {
      await this.syncOnce(scope ? [scope] : []);
    } catch {
      // Swallowed: status.lastError already captures it; background sync must not throw to React.
    }
  }

  private scopeForTable(table: string): SyncScope | null {
    const definition = this.manifest.tables[table];
    if (!definition) {
      return null;
    }
    if (definition.scope.kind === "byUser" && this.userId) {
      return { kind: "byUser", key: `u:${this.userId}`, table };
    }
    // byWorkspace/byProject scopes need a workspace value supplied per query.
    return null;
  }

  private getQueryDefinition<TArgs, TResult>(reference: unknown): LocalQueryDefinition<TArgs, TResult> | null {
    const name = this.safeName(reference);
    if (!name) {
      return null;
    }
    return (this.manifest.queries[name] as LocalQueryDefinition<TArgs, TResult> | undefined) ?? null;
  }

  private getMutationDefinition<TArgs, TResult>(reference: unknown): LocalMutationDefinition<TArgs, TResult> | null {
    const name = this.safeName(reference);
    if (!name) {
      return null;
    }
    return (this.manifest.mutations[name] as LocalMutationDefinition<TArgs, TResult> | undefined) ?? null;
  }

  private safeName(reference: unknown): FunctionName | null {
    try {
      return this.nameOf(reference);
    } catch {
      return null;
    }
  }

  /**
   * For a patch on a table with declared `setFields`/`counterFields`, rewrite each touched
   * field into a DELTA vs the row's current value, so concurrent edits merge (see setMerge.ts)
   * instead of clobbering: arrays → set deltas, numbers → counter deltas. Runs before the op
   * is persisted/pushed. No-op for non-patches, undeclared fields, or wrong-typed/already-delta values.
   */
  private async applyFieldDeltas(operation: LocalOperation): Promise<void> {
    if (operation.kind !== "patch" || !operation.patch) {
      return;
    }
    const definition = this.manifest.tables[operation.table];
    const setFields = definition?.setFields ?? [];
    const counterFields = definition?.counterFields ?? [];
    if (setFields.length === 0 && counterFields.length === 0) {
      return;
    }
    const patch = operation.patch; // the Record is mutable (only the property binding is readonly)
    const touchedSets = setFields.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
    const touchedCounters = counterFields.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
    if (touchedSets.length === 0 && touchedCounters.length === 0) {
      return;
    }
    const current = await this.getRow<Record<string, unknown>>(operation.table, operation.id);
    for (const field of touchedSets) {
      const value = patch[field];
      if (isSetDelta(value) || !Array.isArray(value)) {
        continue; // already a delta, or a non-array on a set field → leave as plain LWW
      }
      patch[field] = { __lfSet: computeSetDelta(current?.[field], value) } satisfies SetDelta;
    }
    for (const field of touchedCounters) {
      const value = patch[field];
      if (isCounterDelta(value) || typeof value !== "number") {
        continue; // already a delta, or a non-number on a counter field → leave as plain LWW
      }
      patch[field] = { __lfCounter: computeCounterDelta(current?.[field], value) } satisfies CounterDelta;
    }
  }

  private async commitLocal(operation: LocalOperation): Promise<LocalCommit> {
    await this.applyFieldDeltas(operation);
    // I1/I3: enqueuing the op IS the entire local write — the live view is derived from
    // canonical + replayed pending ops. Persist durably FIRST so a failed enqueue (e.g.
    // QuotaExceeded) rejects the caller with nothing half-applied (no phantom "pending").
    await this.store.enqueueOperation(operation);
    this.opStatuses.set(operation.opId, { opId: operation.opId, status: "pending" });
    await this.refreshPendingCount();
    return {
      opId: operation.opId,
      table: operation.table,
      id: operation.id,
      committedAt: this.clock(),
      // Return the resulting row so the caller needs no readback: insert → the optimistic
      // row, patch → the merge after this patch (undefined if not local yet), remove → undefined.
      row:
        operation.kind === "insert"
          ? operation.value
          : operation.kind === "patch"
            ? await this.getRow(operation.table, operation.id)
            : undefined
    };
  }

  private async markStatus(opId: string, status: MutationStatus["status"], error?: string): Promise<void> {
    this.opStatuses.set(opId, { opId, status, error });
    await this.store.updateOperationStatus(opId, status, error);
  }

  private async pushSingleOperation<TResult>(operation: LocalOperation): Promise<TResult> {
    await this.markStatus(operation.opId, "pushing");
    // Retry transient failures: the server dedupes by (userId, opId) and re-delivers the
    // confirming change (R9), so a retry after a lost ACK resolves correctly rather than
    // spuriously rejecting call.server. Sustained offline still rejects (op syncs later).
    let response: Awaited<ReturnType<SyncTransport["push"]>>;
    try {
      response = await this.tracked(() =>
        this.withRetry(() =>
          this.transport.push({
            clientId: this.clientId,
            userId: this.userId,
            schemaVersion: this.manifest.schemaVersion,
            mutations: [operation]
          })
        )
      );
    } catch (error) {
      // Our push failed, but under multi-tab the leader may have already pushed this op from
      // the shared outbox and acked it — the write DID succeed. Resolve call.server from that
      // durable outcome instead of rejecting a committed write; reject only if still owed.
      // ponytail: best-effort result — the exact serverResult lives in the tab that got the ack.
      const durable = await this.store.getOperation(operation.opId);
      if (!durable || durable.status === "acked") {
        await this.refreshPendingCount();
        return { ok: true, localId: operation.id } as TResult;
      }
      throw error;
    }

    if (response.schemaMismatch) {
      // A schema mismatch is not an ack: leave the op pending (do NOT mark acked,
      // or it would drop out of sync and replay forever as local-only state) and
      // block sync until the client upgrades. Mirrors pushPendingOperations.
      this.blockForSchemaMismatch();
      await this.refreshPendingCount();
      throw new Error("Local-first schema version is behind the server; reload to upgrade.");
    }

    await this.store.applyServerChanges(response.changes);

    const rejection = response.rejected.find((item) => item.opId === operation.opId);
    if (rejection) {
      await this.markStatus(operation.opId, "rejected", rejection.message);
      await this.refreshPendingCount();
      throw new Error(rejection.message);
    }

    const accepted = response.accepted.find((item) => item.opId === operation.opId);
    if (!accepted) {
      // Protocol invariant: a non-mismatch response must account for every pushed op (R9).
      // If ours is in neither list the server is buggy; leave it owed (not acked, which would
      // strand it) so the batch path re-pushes it, and surface the error to call.server.
      await this.markStatus(operation.opId, "pending");
      await this.refreshPendingCount();
      throw new Error(
        `Local-first push: server response did not cover operation ${operation.opId} (neither accepted nor rejected).`
      );
    }
    await this.markStatus(operation.opId, "acked");
    // A no-op delete is accepted with no confirming change: drop it explicitly so it
    // doesn't linger and replay (a normal op is pruned by its applied/redelivered change).
    if (isNoopAck(accepted.serverResult)) {
      await this.store.dropOperation(operation.opId);
    }
    this.setStatus({ lastPushAt: response.serverTime });
    await this.refreshPendingCount();
    return accepted.serverResult as TResult;
  }

  private async pushPendingOperations(options?: { readonly force?: boolean }): Promise<void> {
    // A follower tab suppresses the background batch push so the leader owns the shared
    // outbox; `force` (reconnect flush / leadership handoff / wake) bypasses the gate.
    if (!this.syncEnabled && !options?.force) {
      return;
    }
    const pending = await this.store.getPendingOperations();
    if (pending.length === 0) {
      return;
    }
    if (this.isLikelyOffline()) {
      // Known offline: leave the ops pending (they flush on the next reconnect) rather
      // than awaiting a push that would hang on the buffering client.
      this.setStatus({ online: false });
      return;
    }
    const response = await this.tracked(() =>
      this.withTimeout(
        () =>
          this.withRetry(() =>
            this.transport.push({
              clientId: this.clientId,
              userId: this.userId,
              schemaVersion: this.manifest.schemaVersion,
              mutations: pending
            })
          ),
        "push"
      )
    );
    if (response.schemaMismatch) {
      this.blockForSchemaMismatch();
      return;
    }
    // Apply confirming changes BEFORE acking: applyServerChanges is what prunes a
    // confirmed op from the outbox. If it threw AFTER we'd marked ops acked, those ops
    // would be neither owed (so never re-pushed) nor canonical — stuck _pending forever.
    await this.store.applyServerChanges(response.changes);
    for (const accepted of response.accepted) {
      await this.markStatus(accepted.opId, "acked");
      // A no-op delete acks with no confirming change, so nothing would ever prune it — drop
      // it explicitly. A normal op is pruned by its change (above/redelivered), so leave it
      // here: dropping before its change arrived would lose the row.
      if (isNoopAck(accepted.serverResult)) {
        await this.store.dropOperation(accepted.opId);
      }
    }
    for (const rejected of response.rejected) {
      await this.markStatus(rejected.opId, "rejected", rejected.message);
    }
    this.setStatus({ lastPushAt: response.serverTime });
  }

  private async pullScopes(scopes: readonly SyncScope[]): Promise<void> {
    if (scopes.length === 0) {
      return;
    }
    if (this.isLikelyOffline()) {
      // Known offline: serve the local cache (the caller reads it next) instead of
      // awaiting a pull that would hang. Reads are never blocked by connectivity.
      this.setStatus({ online: false });
      return;
    }
    const cursors: Record<string, string | null> = {};
    for (const scope of scopes) {
      cursors[scope.key] = await this.store.getCursor(scope.key);
    }
    // Drain: the server caps each scope per pull, so keep pulling with the advanced cursors
    // until every scope reports no hasMore (a cold client may be many pages behind). Exits
    // early — marking the cache partial — if a round advances no cursor or hits the backstop.
    let partial = false;
    for (let round = 0; round < MAX_PULL_ROUNDS; round++) {
      const response = await this.tracked(() =>
        this.withTimeout(
          () =>
            this.withRetry(() =>
              this.transport.pull({
                clientId: this.clientId,
                userId: this.userId,
                schemaVersion: this.manifest.schemaVersion,
                scopes,
                cursors
              })
            ),
          "pull"
        )
      );
      if (response.schemaMismatch) {
        // Do not apply changes or advance cursors on a schema mismatch.
        this.blockForSchemaMismatch();
        return;
      }
      await this.store.applyServerChanges(response.changes);
      let advanced = false;
      for (const [scopeKey, cursor] of Object.entries(response.cursors)) {
        if (cursors[scopeKey] !== cursor) {
          advanced = true;
        }
        await this.store.setCursor(scopeKey, cursor);
        cursors[scopeKey] = cursor;
      }
      this.setStatus({ lastPullAt: response.serverTime });
      // Prefer the server's explicit per-scope hasMore; fall back to "this round
      // brought changes" for an older server/transport without it.
      const more = response.hasMore
        ? Object.values(response.hasMore).some(Boolean)
        : response.changes.length > 0;
      if (!more) {
        break;
      }
      if (!advanced || round === MAX_PULL_ROUNDS - 1) {
        // More remains but the cursor didn't move (or we hit the backstop): stop and
        // surface that the cache is not fully caught up rather than spin.
        partial = true;
        break;
      }
    }
    this.setStatus({ partial });
  }

  private blockForSchemaMismatch(): void {
    this.setStatus({
      blockedBySchemaMismatch: true,
      lastError: "Schema version mismatch; client must upgrade before syncing"
    });
  }

  /**
   * Bound a transport call so an unreachable server can't hang sync forever. Races fn()
   * against a timer (cleared on settle, unref'd so it can't keep a process alive).
   * syncTimeoutMs <= 0 disables.
   */
  private withTimeout<T>(fn: () => Promise<T>, label: string): Promise<T> {
    if (!(this.syncTimeoutMs > 0)) {
      return fn();
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`local-first sync ${label} timed out after ${this.syncTimeoutMs}ms (server unreachable)`));
      }, this.syncTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      fn().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /** Retry a network call with exponential backoff. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retry.retries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === this.retry.retries) {
          break;
        }
        await this.sleep(this.retry.baseDelayMs * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private operationStatus(opId: string): MutationStatus {
    return this.opStatuses.get(opId) ?? { opId, status: "pending" };
  }

  private async refreshPendingCount(): Promise<void> {
    const pending = await this.store.getPendingOperations();
    this.setStatus({ pendingMutations: pending.length });
  }
}

/**
 * Headless engine factory — build an engine outside React for imperative consumers (a
 * service layer, a MobX/Zustand store, a worker). The same instance can be passed to the
 * React `ConvexProvider` (its `localFirst.engine` option) to share one engine/outbox/cache.
 * Reads: `query`/`runLocalQuery` (scope-enforced); writes: `mutate`; `subscribe` fires on
 * every local data change.
 */
export function createLocalFirstEngine(options: LocalFirstEngineOptions): LocalFirstEngine {
  return new LocalFirstEngine(options);
}
