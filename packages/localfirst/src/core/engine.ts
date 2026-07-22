import { LocalCache, type QueryDebugInfo, type QueryExplain } from "./cache.js";
import { AttachmentManager, type AttachmentBackend, type XhrLike } from "./attachments.js";
import { SearchManager, type SearchOptions, type SearchResult } from "./search.js";
import type {
  LocalQueryCountResult,
  LocalQueryGroupKey,
  LocalQueryPlan,
  LocalQueryResult
} from "./collection.js";
import { attachRelations, relationTables } from "./relations.js";
import { createDefaultIdFactory, createOpId, type IdFactory } from "./id.js";
import type { FunctionNameResolver } from "./functionName.js";
import { defaultFunctionName } from "./functionName.js";
import type { LocalFirstManifest, LocalMutationDefinition, LocalQueryDefinition } from "./manifest.js";
import {
  createLocalFirstBatchCall,
  createLocalFirstMutationCall,
  type LocalFirstBatchCall,
  type LocalFirstMutationCall
} from "./mutationCall.js";
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
  AttachmentRecovery,
  AttachmentUploadState,
  FunctionName,
  LocalCommit,
  LocalId,
  LocalOperation,
  MutationStatus,
  OperationKind,
  RecoveryGroup,
  RecoveryOperation,
  RecoveryStatus,
  RoleValue,
  RowDelta,
  RowValue,
  ScopeKey,
  SyncScope,
  SyncStatus
} from "./types.js";
import type { ClientCanWriteInput } from "./manifest.js";

type AnyLocalQueryPlan = LocalQueryPlan<Record<string, unknown>, unknown, string>;

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
  /**
   * Soft cap on how many operations one push request carries (default Infinity — the
   * whole outbox goes in one request, exactly as before). Atomic write groups are NEVER
   * split across requests: if adding a group would exceed the cap, the current request is
   * flushed first and the group starts the next one (a single group larger than the cap
   * still ships whole). Mostly a knob for tests and very large backlogs.
   */
  readonly maxPushBatch?: number;
  /** Offline-capable attachment pipeline (P5). Absent → createAttachment throws a
   *  configuration error; everything else works unchanged. */
  readonly attachments?: {
    readonly backend?: AttachmentBackend;
    /** Metadata-row field the server stamps with the storage id. Default "storageId". */
    readonly storageIdField?: string;
    /** XHR factory for the default uploader (tests inject a fake). */
    readonly createXhr?: () => XhrLike;
  };
};

// Backstop for the pull drain loop; the real exits are "no hasMore" and "cursor stalled".
// Generous so a large cold start drains in one go.
const MAX_PULL_ROUNDS = 10000;

export type OperationOutcome =
  | { readonly opId: string; readonly status: "acked"; readonly result: unknown }
  | { readonly opId: string; readonly status: "rejected"; readonly error: string };

/** One collected member of an in-flight atomic write group (engine.batch). Its op is
 *  built (with the group tag) and committed only when the batch's fn settles. */
type PlannedBatchOp = {
  readonly opId: string;
  readonly id: LocalId;
  readonly buildOperation: (
    createdAt: number,
    group: { groupId: string; groupSize: number; groupIndex: number }
  ) => LocalOperation;
  readonly resolveLocal: (commit: LocalCommit) => void;
  readonly rejectLocal: (error: Error) => void;
  readonly resolveServer: (value: unknown) => void;
  readonly rejectServer: (error: Error) => void;
};

/** The mutable context for one engine.batch(fn) call. `active` is true only while fn is
 *  running (or awaiting), gating the "don't await .server inside fn" error. */
type BatchContext = {
  readonly groupId: string;
  active: boolean;
  readonly planned: PlannedBatchOp[];
};

/**
 * Split ordered pending ops into request-sized chunks that never split an atomic group.
 * Groups are contiguous in the input (their createdAt block is reserved in one pass), so
 * a group is a maximal run of ops sharing a groupId. A group is added whole: if it would
 * push the current chunk past `limit`, the chunk is flushed first and the group starts a
 * fresh one (a lone group larger than `limit` still ships whole — correctness over the
 * soft cap). `limit === Infinity` (the default) yields exactly one chunk.
 */
function chunkRespectingGroups(
  pending: readonly LocalOperation[],
  limit: number
): LocalOperation[][] {
  if (!(limit > 0) || pending.length === 0) return pending.length ? [pending.slice()] : [];
  const chunks: LocalOperation[][] = [];
  let chunk: LocalOperation[] = [];
  let index = 0;
  while (index < pending.length) {
    // The next unit is a whole group (a run of same-groupId ops) or a single ungrouped op.
    const op = pending[index]!;
    let end = index + 1;
    if (op.groupId !== undefined) {
      while (end < pending.length && pending[end]!.groupId === op.groupId) end++;
    }
    const unit = pending.slice(index, end);
    if (chunk.length > 0 && chunk.length + unit.length > limit) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(...unit);
    index = end;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

// ---- Undo/redo (DX v4 §7) ---------------------------------------------------
// A concrete, ready-to-emit inverse operation: the mutation NAME + kind + payload the
// engine will push to undo (or redo) an earlier op. insert re-inserts a captured row,
// patch restores the touched fields, delete removes a row.
type ResolvedUndoOp =
  | { readonly kind: "insert"; readonly table: string; readonly id: LocalId; readonly functionName: string; readonly value: Record<string, unknown> }
  | { readonly kind: "patch"; readonly table: string; readonly id: LocalId; readonly functionName: string; readonly patch: Record<string, unknown> }
  | { readonly kind: "delete"; readonly table: string; readonly id: LocalId; readonly functionName: string };

/** One undoable unit: a single user op, or a whole atomic batch group (its members'
 *  inverses in reverse order, replayed as ONE group so the group undoes as a unit). */
type UndoEntry = {
  readonly scopeKey: ScopeKey;
  /** Global monotonic sequence, so a scope-less undo can pick the most-recent action. */
  readonly seq: number;
  readonly ops: readonly ResolvedUndoOp[];
};

/** Per-scope undo/redo cap (DX v4 §7). Oldest entries fall off the bottom. */
const UNDO_CAP = 100;

/** Strip client-only system fields (`_id`, `_version`, `_deleted`, `_pending`, …) from a
 *  captured row so it re-inserts as a plain document (the idField carries identity). */
function stripSystemFields(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("_")) out[key] = value;
  }
  return out;
}

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
  private readonly maxPushBatch: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private status: SyncStatus = {
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
  private readonly opStatuses = new Map<string, MutationStatus>();
  private readonly dataListeners = new Set<() => void>();
  // The product-grade local read model: an in-memory per-table row cache with local
  // secondary indexes and incremental query views, hydrated once at boot from the store
  // and maintained purely by row deltas emitted at every commit site below (P3).
  private readonly cache: LocalCache;
  // Local full-text search (P4): an incremental inverted index over declared searchFields,
  // built once from the hydrated cache and maintained from the SAME row-delta bus as the
  // read model above — never by rescanning tables. Backs useSearch.
  private readonly search: SearchManager;
  // Leader-owned offline attachment uploader (P5): durable blob outbox + background
  // queue with retry/backoff, resumable across reloads, maintained from the same
  // row-delta bus (delete → cancel, storageId synced-in → evict). Backs
  // useCreateAttachment / useAttachmentUpload.
  private readonly attachments: AttachmentManager;
  private disposeAttachmentDeltas: (() => void) | null = null;
  // Depth counter: while > 0 an engine-driven store write is in flight, so the store's
  // change notification is NOT turned into a cache resync (the engine already applied the
  // exact delta). A notify at depth 0 is an out-of-band write (a test, or another writer
  // to a shared store) → resync to reconcile. See the store subscription in the constructor.
  private cacheWriteDepth = 0;
  private disposeStoreSubscription: (() => void) | null = null;
  // Separate from the store's data-change listeners so a status change (online/syncing/
  // pending) wakes only useSyncStatus, not every data query (avoids a re-render storm).
  private readonly statusListeners = new Set<() => void>();
  // Refcounted reactive subscriptions, keyed by scope: many hooks on one scope share ONE
  // watch + drain loop instead of a per-hook herd of redundant pulls.
  private readonly scopeWatchers = new Map<string, { count: number; dispose: () => void }>();
  // Removes the engine-owned browser online/offline listeners (noop outside a browser).
  private disposeConnectivity: () => void = () => {};
  // Multi-tab leadership gate. A coordinated follower never pushes; its durable op is
  // drained by the leader and its .server promise settles from the broadcast outcome.
  private syncEnabled = true;
  private multiTabEnabled = false;
  // High-water mark keeping operation createdAt (the I4 replay key) strictly increasing per
  // engine, so a backward wall-clock step can't reorder two local edits. seeded across
  // reloads from durable ops by seedTimestampHighWater().
  private tsHighWater = 0;
  private readonly timestampSeed: Promise<void>;
  private activeSyncs = 0;
  private readonly partialScopes = new Set<string>();
  private readonly partialRuns = new Map<string, number>();
  private nextPartialRun = 0;
  private readonly scopeEpochs = new Map<string, number>();
  // ---- Per-scope status (DX v4 §10) ------------------------------------------
  // hydratedScopes: a scope whose pull has delivered a cursor at least once (first paint
  // ready). pullingScopes: in-flight pull count per scope (syncing). Denial rides the
  // roles map (a `null` marker). partial rides partialScopes. useScopeStatus derives all
  // four; scopeStatusListeners wake it on any per-scope transition.
  private readonly hydratedScopes = new Set<string>();
  private readonly pullingScopes = new Map<string, number>();
  private readonly scopeStatusListeners = new Set<() => void>();
  private pullApplyChain: Promise<void> = Promise.resolve();
  private pushChain: Promise<void> = Promise.resolve();
  private readonly outcomeListeners = new Set<(outcome: OperationOutcome) => void>();
  private readonly outcomeWaiters = new Map<
    string,
    Set<{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>
  >();
  private readonly observedOutcomes = new Map<string, OperationOutcome>();
  // ---- Permission-aware UI (DX v4 §6) ----------------------------------------
  // Per membership scope: the role the server resolved (durable via the store, so it
  // survives reload). A stored `null` is a DENIED marker (useRole → null); an absent
  // entry is "not yet synced" (useRole → undefined). Seeded from the store at boot.
  private readonly roles = new Map<ScopeKey, RoleValue | null>();
  private readonly roleListeners = new Set<() => void>();
  private readonly rolesSeed: Promise<void>;
  // ---- Undo/redo (DX v4 §7) --------------------------------------------------
  // Per-scope inverse stacks. A user op pushes onto undo + clears redo; undo emits the
  // inverse (ordinary local-first ops) and pushes the counter-inverse onto redo; redo
  // does the reverse. NOT durable — cleared with local data on logout.
  private readonly undoStacks = new Map<ScopeKey, UndoEntry[]>();
  private readonly redoStacks = new Map<ScopeKey, UndoEntry[]>();
  private readonly undoListeners = new Set<() => void>();
  private undoSeq = 0;
  // Table → its insert/patch/delete mutation NAME, so an inverse can name a real declared
  // mutation the server will accept (invert an insert with the table's delete mutation, etc).
  private readonly tableMutationNames = new Map<string, { insert?: string; patch?: string; delete?: string }>();
  // Logout detection: the store epoch this engine last observed. A bump means clear() ran.
  private knownEpoch = 0;

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
    this.maxPushBatch = options.maxPushBatch && options.maxPushBatch > 0 ? options.maxPushBatch : Infinity;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // Reflect any operations already durable in the store (e.g. after a reload)
    // so getStatus() is accurate without waiting for the first sync.
    void this.refreshPendingCount();
    this.timestampSeed = this.seedTimestampHighWater();
    // Index each table's insert/patch/delete mutation name for undo (§7): inverting an
    // insert needs the table's delete mutation, inverting a delete needs its insert, etc.
    for (const definition of Object.values(this.manifest.mutations)) {
      if (!definition.operationKind) continue;
      const entry = this.tableMutationNames.get(definition.table) ?? {};
      if (entry[definition.operationKind] === undefined) entry[definition.operationKind] = definition.name;
      this.tableMutationNames.set(definition.table, entry);
    }
    // Seed the durable role cache so useRole/useCan are accurate right after a reload,
    // before the first pull, and detect a logout (epoch bump) to clear derived state.
    this.rolesSeed = this.seedRoles();
    void this.store.getEpoch().then((epoch) => {
      this.knownEpoch = epoch;
    });
    this.cache = new LocalCache(this, this.store);
    void this.cache.hydrate();
    // The search index shares the cache's hydration + delta bus (built after hydrate,
    // then delta-maintained). Constructed after the cache so it can hook the bus at boot.
    this.search = new SearchManager(this.cache, this.manifest);
    // Attachment uploader. Constructed after the cache so it can hook the delta bus.
    // isLeader mirrors the multi-tab single-writer gate (syncEnabled); isOnline mirrors
    // the same hard-offline + soft-status check sync uses.
    this.attachments = new AttachmentManager(
      this.store,
      {
        isOnline: () => this.status.online && !this.isLikelyOffline(),
        isLeader: () => this.syncEnabled,
        newLocalId: (table) => this.idFactory(table),
        resolveInsertTable: (reference) => this.getMutationDefinition(reference)?.table ?? null,
        mutateInsert: (reference, args, localId) => this.mutateInternal(reference, args, { localId }).local,
        getOperation: (opId) => this.store.getOperation(opId),
        onRecoveryChange: (list) => this.setFailedAttachments(list)
      },
      {
        backend: options.attachments?.backend,
        storageIdField: options.attachments?.storageIdField,
        createXhr: options.attachments?.createXhr,
        retry: this.retry,
        sleep: this.sleep,
        clock: this.clock
      }
    );
    this.disposeAttachmentDeltas = this.cache.subscribeDeltas((deltas) => this.attachments.handleDeltas(deltas));
    void this.attachments.hydrate();
    this.disposeStoreSubscription = this.store.subscribe(() => this.onStoreNotify());
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

  /** Seed the high-water from durable ops so monotonic order holds across reloads. */
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
    return definition.run(visibleRows, args, { now: this.clock(), userId: this.userId });
  }

  /**
   * Keep only rows in the active scope (owner==userId for byUser, field==value for
   * byWorkspace/byProject). The client caches every scope the user can see, so a query
   * with an incomplete filter could otherwise observe another scope's rows; enforcing it
   * here mirrors the server's I7. `custom` scopes have no client-known field → server-only.
   */
  private filterToScope(table: string, rows: readonly RowValue[], scopeArgs: unknown): readonly RowValue[] {
    const scope = this.manifest.tables[table]?.scope;
    if (!scope || (scope.kind === "byUser" && this.userId == null)) return rows;
    return rows.filter((row) => this.rowMatchesScope(table, row, scopeArgs));
  }

  private rowMatchesScope(table: string, row: RowValue, scopeArgs: unknown): boolean {
    const scope = this.manifest.tables[table]?.scope;
    if (!scope) return true;
    if (scope.kind === "byUser") return this.userId == null || row[scope.field] === this.userId;
    const field = scope.kind === "byWorkspace" ? scope.workspaceIdField : scope.projectIdField;
    const value = (scopeArgs as Record<string, unknown> | null | undefined)?.[field];
    // Missing value is already failed closed by scopedQueryMissingScope. Keep this
    // direct guard too so the count-only row path can never widen a scope.
    return value != null && row[field] === value;
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
  tablesForPlan(plan: AnyLocalQueryPlan): string[] {
    return [plan.table, ...relationTables(plan.relations)];
  }

  /**
   * Apply a query plan to already-fetched rows (keyed by table), enforcing the
   * scoped fail-closed guard and attaching relations in memory. Synchronous so the
   * React hook (useLiveQuery) can call it at render and cannot bypass the guard by
   * running plan.run directly.
   */
  applyLocalQuery<Row extends Record<string, unknown>, Rel, Group extends string = never>(
    plan: LocalQueryPlan<Row, Rel, Group>,
    rowsByTable: Record<string, readonly RowValue[]>
  ): LocalQueryResult<Row, Rel, Group> {
    if (this.scopedQueryMissingScope(plan.table, plan.scopeValues)) {
      // Fail closed: a workspace/project query with no scope value must not return
      // the whole local cache (which can span scopes). Empty .scope({}) lands here.
      return (plan.groupField === undefined ? [] : new Map()) as unknown as LocalQueryResult<Row, Rel, Group>;
    }
    const scoped = this.filterToScope(plan.table, rowsByTable[plan.table] ?? [], plan.scopeValues);
    const base = plan.run(scoped);
    const rows = attachRelations(base, plan.relations, rowsByTable) as Array<Row & Rel>;
    if (plan.groupField === undefined) return rows as LocalQueryResult<Row, Rel, Group>;
    const grouped = new Map<LocalQueryGroupKey, Array<Row & Rel>>();
    for (const row of rows) {
      const value = row[plan.groupField];
      const key = value == null ? null : String(value);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(row);
      else grouped.set(key, [row]);
    }
    return grouped as unknown as LocalQueryResult<Row, Rel, Group>;
  }

  async runLocalQuery<Row extends Record<string, unknown>, Rel, Group extends string = never>(
    plan: LocalQueryPlan<Row, Rel, Group>
  ): Promise<LocalQueryResult<Row, Rel, Group>> {
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
  async read<Row extends Record<string, unknown>, Rel, Group extends string = never>(
    plan: LocalQueryPlan<Row, Rel, Group>
  ): Promise<LocalQueryResult<Row, Rel, Group>> {
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
  scopeForPlan(plan: AnyLocalQueryPlan): SyncScope | null {
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
  async refreshPlan(plan: AnyLocalQueryPlan): Promise<void> {
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
  watchPlan(plan: AnyLocalQueryPlan): (() => void) | null {
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
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  private notifyDataListeners(): void {
    for (const listener of Array.from(this.dataListeners)) listener();
  }

  /** Store change notification. Always wakes the legacy data listeners; turns into a
   *  cache resync only for OUT-OF-BAND writes (depth 0) — engine-driven writes already
   *  push the exact delta into the cache, so their notify must not trigger a full reload. */
  private onStoreNotify(): void {
    this.notifyDataListeners();
    if (this.cacheWriteDepth === 0) void this.cache.resyncFromStore();
    void this.detectLogoutClear();
  }

  /** A store epoch bump means clear() ran (logout / clear-local-data): drop the in-memory
   *  role cache and the undo/redo stacks (§6/§7). The store already wiped its durable
   *  copies; this reconciles the engine's derived state and wakes useRole/useUndo. */
  private async detectLogoutClear(): Promise<void> {
    const epoch = await this.store.getEpoch();
    if (epoch === this.knownEpoch) return;
    this.knownEpoch = epoch;
    this.undoStacks.clear();
    this.redoStacks.clear();
    this.roles.clear();
    this.notifyUndoListeners();
    this.notifyRoleListeners();
  }

  /** Run an engine-owned store write with cache-resync suppression, so the store's
   *  notify doesn't double-apply on top of the explicit delta the caller pushes. */
  private async cacheWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.cacheWriteDepth++;
    try {
      return await fn();
    } finally {
      this.cacheWriteDepth--;
    }
  }

  /** @internal Cache host: false when a scoped table is queried with no scope value. */
  planScopeSatisfied(plan: AnyLocalQueryPlan): boolean {
    return !this.scopedQueryMissingScope(plan.table, plan.scopeValues);
  }

  /** @internal Cache host: exact parity with the store read path — a row passes iff the
   *  scope guard holds, it survives filterToScope (byUser owner / byWorkspace field), and
   *  every predicate matches. */
  rowMatchesPlan(plan: AnyLocalQueryPlan, row: RowValue): boolean {
    if (this.scopedQueryMissingScope(plan.table, plan.scopeValues)) return false;
    if (!this.rowMatchesScope(plan.table, row, plan.scopeValues)) return false;
    return plan.matchesRow ? plan.matchesRow(row) : plan.run([row]).length === 1;
  }

  /**
   * Subscribe to the engine's typed row-delta bus — every mutation apply, server-change
   * apply, op-status transition, eviction, and resync emits {table, localId, kind, row}
   * deltas after commit. The substrate every reactive view is built on.
   */
  subscribeDeltas(listener: (deltas: readonly RowDelta[]) => void): () => void {
    return this.cache.subscribeDeltas(listener);
  }

  /**
   * Register an incremental view for a `collection()` plan. Returns the live result
   * (stable array identity while unchanged, `undefined` until the cache hydrates), the
   * chosen query plan (`explain`), and a disposer. `onChange` fires only when the visible
   * result actually changes — the engine never re-reads whole tables per notification.
   */
  subscribeLiveQuery<Row extends Record<string, unknown>, Rel, Group extends string = never>(
    plan: LocalQueryPlan<Row, Rel, Group>,
    onChange: () => void
  ): { current(): LocalQueryResult<Row, Rel, Group> | undefined; explain(): QueryExplain | null; dispose(): void } {
    let sub: {
      current(): LocalQueryResult<Row, Rel, Group>;
      explain(): QueryExplain;
      dispose(): void;
    } | null = null;
    let disposed = false;
    const start = () => {
      if (disposed) return;
      sub = this.cache.subscribeQuery(plan, onChange);
      onChange();
    };
    if (this.cache.isHydrated) start();
    else void this.cache.hydrate().then(start);
    return {
      current: () => (sub ? sub.current() : undefined),
      explain: () => (sub ? sub.explain() : null),
      dispose: () => {
        disposed = true;
        sub?.dispose();
      }
    };
  }

  /** Count-only live aggregation. Grouped plans return a record keyed by group;
   * ungrouped plans return one number. No row result arrays are built. */
  subscribeLiveCounts<Row extends Record<string, unknown>, Rel, Group extends string = never>(
    plan: LocalQueryPlan<Row, Rel, Group>,
    onChange: () => void
  ): { current(): LocalQueryCountResult<Group> | undefined; explain(): QueryExplain | null; dispose(): void } {
    let sub: {
      current(): LocalQueryCountResult<Group>;
      explain(): QueryExplain;
      dispose(): void;
    } | null = null;
    let disposed = false;
    const start = () => {
      if (disposed) return;
      sub = this.cache.subscribeCounts(plan, onChange);
      onChange();
    };
    if (this.cache.isHydrated) start();
    else void this.cache.hydrate().then(start);
    return {
      current: () => (sub ? sub.current() : undefined),
      explain: () => (sub ? sub.explain() : null),
      dispose: () => {
        disposed = true;
        sub?.dispose();
      }
    };
  }

  /**
   * Register a live full-text search over a table's declared searchFields (P4). The
   * result is maintained from the same row deltas as the read model — a delta touching the
   * table refreshes only the live searches on it — and `onChange` fires only when the
   * visible result changes (stable array identity while unchanged). Empty until the cache
   * hydrates; a table without searchFields yields `{ results: [], total: 0 }`.
   */
  subscribeSearch(
    table: string,
    query: string,
    options: SearchOptions | undefined,
    onChange: () => void
  ): { current(): SearchResult; dispose(): void } {
    const sub = this.search.subscribe(table, query, options, onChange);
    // Mirror subscribeLiveQuery: notify once so the caller reads the initial result (which
    // is empty until the cache hydrates; the manager re-notifies when the index is built).
    onChange();
    return sub;
  }

  /** Fire `listener` when a delta touches `table` — the declarative useQuery path only
   *  re-runs when its own table changed, instead of on every unrelated store change. */
  subscribeTableChange(table: string, listener: () => void): () => void {
    return this.cache.subscribeTable(table, listener);
  }

  /** The base table a local query definition reads, or null if it isn't local. */
  queryTable(reference: unknown): string | null {
    return this.getQueryDefinition(reference)?.table ?? null;
  }

  /** The plan the incremental query engine would choose for `plan` (index vs full scan),
   *  for debugging/telemetry. */
  explainQuery(plan: AnyLocalQueryPlan): QueryExplain {
    return this.cache.explain(plan);
  }

  /** Subscribe to SYNC STATUS changes (online/syncing/pending). Used by useSyncStatus. */
  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  mutate<TArgs, TResult = unknown>(reference: unknown, args: TArgs): LocalFirstMutationCall<TResult> {
    return this.mutateInternal<TArgs, TResult>(reference, args);
  }

  /**
   * @internal The mutate implementation, with an optional forced row id. The
   * attachment pipeline persists a blob keyed by localId, then inserts the metadata
   * row through THIS path with `options.localId` so the row id equals the blob key.
   */
  private mutateInternal<TArgs, TResult = unknown>(
    reference: unknown,
    args: TArgs,
    options?: { readonly localId?: string }
  ): LocalFirstMutationCall<TResult> {
    const definition = this.getMutationDefinition<TArgs, TResult>(reference);
    if (!definition) {
      throw new Error("Cannot run local-first mutation because the function is not in the manifest");
    }

    const opId = createOpId(this.clientId);
    const planned = definition.plan(args, {
      now: this.clock(),
      clientId: this.clientId,
      userId: this.userId,
      localId: (table) => options?.localId ?? this.idFactory(table)
    });
    const id =
      planned.kind === "insert" ? planned.id ?? options?.localId ?? this.idFactory(planned.table) : planned.id;
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
    this.opStatuses.set(opId, { opId, status: "pending" });
    // Build the durable operation at a given createdAt, optionally tagged with the atomic
    // group it belongs to. Shared by the single-op and batch paths so a grouped op is
    // byte-identical to an ungrouped one except for the group fields.
    const buildOperation = (
      createdAt: number,
      group?: { readonly groupId: string; readonly groupSize: number; readonly groupIndex: number }
    ): LocalOperation => ({
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
      createdAt,
      status: "pending",
      ...(group ?? {})
    });

    // Inside engine.batch(fn): defer commit+push and collect this op into the group. The
    // synchronously-known id/opId are returned immediately so insert-then-patch-same-row
    // works within the batch.
    if (this.currentBatch) {
      return this.enqueueBatched<TResult>(this.currentBatch, opId, id, buildOperation);
    }

    // Do not assign createdAt until the durable high-water seed finishes. This is the
    // reload/backward-clock fence: an immediate post-reload edit can never sort before
    // an older operation still in the outbox.
    const prepared = this.timestampSeed.then(async () => {
      // A coordinated tab may have completed its constructor seed before another tab
      // enqueued a causally-earlier op. Refresh once at mutation time so cross-tab
      // insert→delete intent cannot be reversed by equal/backward wall clocks.
      if (this.multiTabEnabled) await this.seedTimestampHighWater();
      const operation = buildOperation(this.monotonicNow());
      // Record the inverse from the before-image (§7) BEFORE commit — commitLocal rewrites
      // set/counter patch fields into deltas, so the raw touched-field values must be read now.
      const before = await this.getRow(operation.table, operation.id);
      const inverse = this.inverseOf(this.toResolvedUndoOp(operation), before ?? null);
      const local = await this.commitLocal(operation);
      if (inverse) this.pushUndoEntry(this.scopeKeyForOp(operation, before ?? null), [inverse]);
      return { operation, local };
    });
    const local = prepared.then(({ local }) => local);
    const server = prepared.then(({ operation }) =>
      this.multiTabEnabled
        ? this.pushCoordinatedOperation<TResult>(operation)
        : this.pushSingleOperation<TResult>(operation)
    );
    // The optimistic caller usually awaits only `.local`, so without this nothing handles a
    // failed background push and it becomes an unhandled rejection. The failure is already in
    // status.lastError and the op stays pending for retry. .catch marks it handled without
    // altering `server`, so a caller who awaits `.server`/the call still observes the rejection.
    server.catch(() => {});

    return createLocalFirstMutationCall<TResult>({
      opId,
      id,
      local,
      server,
      status: () => this.operationStatus(opId)
    });
  }

  // ---- Atomic write groups (DX v4 §5) ---------------------------------------
  // The active batch context. Set only while an engine.batch(fn) is running; a mutate
  // call sees it and joins the group instead of pushing on its own. A single mutable
  // pointer means batches must not overlap concurrently — the documented contract.
  private currentBatch: BatchContext | null = null;

  /**
   * Run `fn`, collecting every local-first mutation it issues into ONE atomic write
   * group. The ops apply optimistically in order, are pushed together in a single
   * request, and the server commits or rejects them as a unit. Returns a handle whose
   * `.local` resolves once all ops are durably enqueued + applied, and whose `.server`
   * resolves with the group's per-op results (or rejects with the group reason, reverting
   * every op as one unit).
   *
   * `fn` may be sync or async, but MUST NOT await a batched call's `.server` (or the call
   * itself) inside `fn` — the group hasn't been dispatched yet, so it would deadlock;
   * doing so throws a clear error instead. Read a fresh insert's id synchronously via the
   * returned call's `.id` (e.g. `const { id } = create({...}); update({ id, ... })`).
   */
  batch<T = unknown>(fn: () => void | Promise<void>): LocalFirstBatchCall<T> {
    const groupId = createOpId(this.clientId);
    const ctx: BatchContext = { groupId, active: true, planned: [] };
    const previous = this.currentBatch;
    this.currentBatch = ctx;

    // Await fn (sync fns settle immediately; async fns keep the batch open across their
    // awaits). Restore the previous batch pointer once fn settles, whatever the outcome.
    const ran = (async () => {
      try {
        await fn();
      } finally {
        ctx.active = false;
        this.currentBatch = previous;
      }
    })();

    const dispatched = ran.then(
      () => this.finalizeBatch(ctx),
      (error) => {
        // fn threw: nothing was committed (commit is deferred to finalize), so there is
        // nothing to revert. Fail every collected op's promises and the group.
        const err = error instanceof Error ? error : new Error(String(error));
        for (const op of ctx.planned) {
          op.rejectLocal(err);
          op.rejectServer(err);
        }
        throw err;
      }
    );

    const local = dispatched.then((r) => r.commits);
    const server = dispatched.then((r) => r.server);
    // Mark handled so a group whose caller only awaits `.local` doesn't surface an
    // unhandled rejection when the server rejects (mirrors the single-op path).
    server.catch(() => {});
    local.catch(() => {});

    return createLocalFirstBatchCall<T>({
      groupId,
      local,
      server: server as Promise<readonly T[]>
    });
  }

  /** Collect one op into the active batch and return its deferred call handle. The
   *  handle's `.server` (and awaiting it) throws while the batch is still open. */
  private enqueueBatched<TResult>(
    ctx: BatchContext,
    opId: string,
    id: LocalId,
    buildOperation: (
      createdAt: number,
      group: { groupId: string; groupSize: number; groupIndex: number }
    ) => LocalOperation
  ): LocalFirstMutationCall<TResult> {
    let resolveLocal!: (commit: LocalCommit) => void;
    let rejectLocal!: (error: Error) => void;
    let resolveServer!: (value: unknown) => void;
    let rejectServer!: (error: Error) => void;
    const localPromise = new Promise<LocalCommit>((resolve, reject) => {
      resolveLocal = resolve;
      rejectLocal = reject;
    });
    const serverPromise = new Promise<TResult>((resolve, reject) => {
      resolveServer = resolve as (value: unknown) => void;
      rejectServer = reject;
    });
    // Never lets a deferred rejection escape as "unhandled" if the caller ignores it.
    localPromise.catch(() => {});
    serverPromise.catch(() => {});
    ctx.planned.push({ opId, id, buildOperation, resolveLocal, rejectLocal, resolveServer, rejectServer });

    const guard = () => {
      if (ctx.active) {
        throw new Error(
          "convex-localfirst: do not await a batched mutation's .server (or the call itself) inside batch(fn) — the group has not been dispatched yet. Await the handle returned by batch() after fn returns."
        );
      }
    };
    // A bespoke handle (not a real Promise): `.server` and the thenable both throw while
    // the batch is open, so an accidental in-fn await is a clear error instead of a hang.
    const handle = {
      opId,
      id,
      local: localPromise,
      get server(): Promise<TResult> {
        guard();
        return serverPromise;
      },
      status: () => this.operationStatus(opId),
      then<A = TResult, B = never>(
        onF?: ((value: TResult) => A | PromiseLike<A>) | null,
        onR?: ((reason: unknown) => B | PromiseLike<B>) | null
      ): Promise<A | B> {
        guard();
        return serverPromise.then(onF, onR);
      },
      catch<B = never>(onR?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<TResult | B> {
        guard();
        return serverPromise.catch(onR);
      },
      finally(onFinally?: (() => void) | null): Promise<TResult> {
        guard();
        return serverPromise.finally(onFinally);
      }
    };
    return handle as unknown as LocalFirstMutationCall<TResult>;
  }

  /** Commit the collected group locally (in order) then push it as one contiguous
   *  request. Returns the local commits and a promise for the group's server outcome. */
  private async finalizeBatch(
    ctx: BatchContext
  ): Promise<{ commits: readonly LocalCommit[]; server: Promise<readonly unknown[]> }> {
    const planned = ctx.planned;
    const groupSize = planned.length;
    if (groupSize === 0) {
      return { commits: [], server: Promise.resolve([]) };
    }
    await this.timestampSeed;
    if (this.multiTabEnabled) await this.seedTimestampHighWater();
    // Reserve a CONTIGUOUS createdAt block up front (tight loop, no awaits) so no
    // interleaving mutation can land a createdAt inside the group's range — the group
    // stays contiguous in the outbox and is never split across a push request.
    const createdAts = planned.map(() => this.monotonicNow());
    const operations: LocalOperation[] = planned.map((p, index) =>
      p.buildOperation(createdAts[index]!, { groupId: ctx.groupId, groupSize, groupIndex: index })
    );
    // Register outcome waiters BEFORE pushing so the single-writer push (or a leader
    // broadcast) settles each op's .server. observedOutcomes buffers any that resolve
    // before the waiter is attached, so ordering is not load-bearing.
    const serverPerOp = operations.map((op) => this.waitForOperationOutcome<unknown>(op.opId));
    for (const promise of serverPerOp) promise.catch(() => {});

    const commits: LocalCommit[] = [];
    // Collect each member's inverse (from its before-image, in order) so the group undoes
    // as ONE unit (§7). Applied in REVERSE order at undo time (last op undone first).
    const inverses: ResolvedUndoOp[] = [];
    let undoScopeKey: ScopeKey | null = null;
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]!;
      const before = await this.getRow(operation.table, operation.id);
      const inverse = this.inverseOf(this.toResolvedUndoOp(operation), before ?? null);
      if (inverse) {
        inverses.push(inverse);
        undoScopeKey ??= this.scopeKeyForOp(operation, before ?? null);
      }
      const commit = await this.commitLocal(operation);
      commits.push(commit);
      planned[index]!.resolveLocal(commit);
    }
    if (inverses.length > 0 && undoScopeKey) this.pushUndoEntry(undoScopeKey, inverses.reverse());

    // Aggregate the group outcome: resolve with per-op results when all accept; reject
    // with the group reason when any rejects (each op already reverted via its rejected
    // status). Per-op .server promises settle from the same outcomes.
    const server = Promise.allSettled(serverPerOp).then((settled) => {
      const rejection = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
      settled.forEach((s, index) => {
        if (s.status === "fulfilled") planned[index]!.resolveServer(s.value);
        else planned[index]!.rejectServer(s.reason instanceof Error ? s.reason : new Error(String(s.reason)));
      });
      if (rejection) {
        throw rejection.reason instanceof Error ? rejection.reason : new Error(String(rejection.reason));
      }
      return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value);
    });
    server.catch(() => {});

    // Dispatch the group. In single-writer/leader mode this pushes the whole outbox (the
    // group included, contiguously); a coordinated follower's commit already poked the
    // leader via the cross-tab "changed" broadcast, so it just waits on the outcomes.
    if (this.syncEnabled) this.flushPending();

    return { commits, server };
  }

  async syncOnce(scopes: readonly SyncScope[] = []): Promise<void> {
    if (this.status.blockedBySchemaMismatch) {
      // A schema mismatch is not retryable by syncing; the client must upgrade.
      return;
    }
    this.activeSyncs++;
    this.setStatus({ syncing: true, lastError: null });
    try {
      await this.pushPendingOperations();
      if (this.status.blockedBySchemaMismatch) return;
      await this.pullScopes(scopes);
    } catch (error) {
      this.setStatus({ lastError: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.activeSyncs--;
      this.setStatus({ syncing: this.activeSyncs > 0 });
      await this.refreshPendingCount();
    }
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  /** Reflect externally-known connectivity (e.g. the browser's online/offline events). */
  setOnline(online: boolean): void {
    this.setStatus({ online });
    // Reconnect resumes the attachment upload queue (manager reads isOnline() live).
    this.attachments.setOnline(online);
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
    this.disposeStoreSubscription?.();
    this.disposeStoreSubscription = null;
    // The attachment delta subscription is re-hooked in resume() (like the store one),
    // so a StrictMode dispose→resume cycle keeps the uploader reacting to deletes/finalizes.
    this.disposeAttachmentDeltas?.();
    this.disposeAttachmentDeltas = null;
    // The search index is NOT torn down here: it holds no browser listener, only an
    // internal cache-delta subscription that is GC'd with the engine. dispose()/resume()
    // reuse the same (memoized) engine under StrictMode, so keeping search live across the
    // cycle is correct — tearing it down would leave it deaf with no resume() counterpart.
  }

  /** (Re)attach the engine-owned browser listeners after a dispose(). Idempotent.
   *  The React provider pairs this with dispose() in an effect, so a StrictMode
   *  mount→cleanup→mount cycle can't leave the (memoized, reused) engine deaf to
   *  the browser's online/offline events. */
  resume(): void {
    this.disposeConnectivity();
    this.disposeConnectivity = this.wireConnectivity();
    this.disposeStoreSubscription ??= this.store.subscribe(() => this.onStoreNotify());
    this.disposeAttachmentDeltas ??= this.cache.subscribeDeltas((deltas) => this.attachments.handleDeltas(deltas));
    // Re-scan the durable blob outbox and resume any owed uploads after a remount.
    void this.attachments.wake();
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
    // Leadership gates the uploader too: gaining it resumes any inherited attachment
    // backlog (e.g. after the previous leader tab died mid-upload).
    this.attachments.setLeader(enabled);
    if (enabled) {
      this.flushPending();
    }
  }

  /** @internal Mark this engine as part of a cross-tab single-writer group. */
  setMultiTabEnabled(enabled: boolean): void {
    this.multiTabEnabled = enabled;
  }

  /**
   * Drain the outbox if this engine is the leader (or is not coordinated). Never throws.
   */
  flushPending(): void {
    void this.pushPendingOperations().catch(() => {
      // status.lastError already records it; an explicit flush must not throw to callers.
    });
  }

  /**
   * Cross-tab "db changed" poke: IndexedDB has no cross-tab change event, so when the
   * leader pulls into the shared DB, follower tabs are told to re-derive. Safe to over-call
   * (applyServerChanges is version-folded, so a re-read only surfaces equal-or-newer rows).
   */
  pokeLocalChange(): void {
    this.notifyDataListeners();
    // Cross-tab: the shared store changed under us with no delta payload — resync the
    // cache from the store (the gap-recovery path), emitting only the rows that changed.
    void this.cache.resyncFromStore();
  }

  /** @internal Broadcast accepted/rejected results to follower tabs. */
  subscribeOperationOutcomes(listener: (outcome: OperationOutcome) => void): () => void {
    this.outcomeListeners.add(listener);
    return () => this.outcomeListeners.delete(listener);
  }

  /** @internal Settle a follower's .server promise from a leader broadcast. */
  observeOperationOutcome(outcome: OperationOutcome): void {
    this.recordOutcome(outcome, false);
    void this.refreshPendingCount();
  }

  /** Current durable recovery work. Rejected writes survive reload; older-schema
   * writes are populated by the React provider's namespace scan. */
  getRecoveryStatus(): RecoveryStatus {
    return this.status.recovery;
  }

  /** @internal Provider hook for pending operations found in older default namespaces. */
  setOlderSchemaOperations(operations: readonly RecoveryOperation[]): void {
    this.setStatus({ recovery: { ...this.status.recovery, olderSchemaOperations: operations } });
  }

  /** @internal AttachmentManager hook: surface upload failures through recovery. */
  setFailedAttachments(failed: readonly AttachmentRecovery[]): void {
    this.setStatus({ recovery: { ...this.status.recovery, failedAttachments: failed } });
  }

  /**
   * Create an attachment: persist its blob durably in the local outbox AND insert the
   * metadata row optimistically through the normal local-first mutation path (so it
   * syncs/rebases like any row). Fully succeeds offline; the blob uploads in the
   * background when online + leader. `insert` is a local-first INSERT mutation
   * reference (from an lf.table); `metadata` is its args. Returns the metadata row's
   * `localId` — the key used by useAttachmentUpload and the blob outbox.
   */
  createAttachment(input: {
    insert: unknown;
    metadata: Record<string, unknown>;
    blob: Blob;
  }): Promise<{ localId: string }> {
    return this.attachments.create(input);
  }

  /** Live upload state for one attachment (by metadata-row localId), or null if
   *  unknown to this engine. Backs useAttachmentUpload. */
  getAttachmentState(localId: string): AttachmentUploadState | null {
    return this.attachments.getState(localId);
  }

  /** Subscribe to one attachment's upload-state changes. */
  subscribeAttachment(localId: string, listener: () => void): () => void {
    return this.attachments.subscribe(localId, listener);
  }

  // ---- Permission-aware UI: role sync + write mirror (DX v4 §6) --------------

  /** Load the durable role cache into memory at boot so useRole/useCan don't wait for a
   *  first pull after a reload. Best-effort — a store without role support just stays empty. */
  private async seedRoles(): Promise<void> {
    try {
      const stored = await this.store.getRoles?.();
      if (stored) for (const [scopeKey, role] of Object.entries(stored)) this.roles.set(scopeKey, role);
      if (stored && Object.keys(stored).length > 0) this.notifyRoleListeners();
    } catch {
      // In-memory roles still fill in from the next pull; only the reload seed is lost.
    }
  }

  private notifyRoleListeners(): void {
    for (const listener of Array.from(this.roleListeners)) listener();
  }

  /** Subscribe to role-cache changes (a pull delivered/updated a role, or logout cleared it). */
  subscribeRoles(listener: () => void): () => void {
    this.roleListeners.add(listener);
    return () => this.roleListeners.delete(listener);
  }

  /**
   * The caller's synced role in a membership scope: the role value, `null` (denied / no
   * access), or `undefined` (not yet synced — a 0.3.x server, or the first pull hasn't
   * landed). `scope` is the scope-value object (e.g. `{ workspace_id }`), mapped to the
   * membership scope key via the table declarations.
   */
  getRole(scope: Record<string, unknown> | null | undefined): RoleValue | null | undefined {
    const scopeKey = this.scopeKeyForScopeArgs(scope);
    if (!scopeKey) return undefined;
    return this.roles.has(scopeKey) ? (this.roles.get(scopeKey) ?? null) : undefined;
  }

  /** Pull the given membership scope so its role (and rows) are fetched — lets `useRole`
   *  be self-sufficient even without a mounted query on that scope. Never throws. */
  async syncRoleScope(scope: Record<string, unknown> | null | undefined): Promise<void> {
    const key = this.scopeKeyForScopeArgs(scope);
    if (!key) return;
    const kind = key.slice(0, key.indexOf(":")) as SyncScope["kind"];
    await this.refreshPlanScope({ kind, key });
  }

  // ---- Per-scope status (DX v4 §10) ------------------------------------------

  private notifyScopeStatusListeners(): void {
    for (const listener of Array.from(this.scopeStatusListeners)) listener();
  }

  /** Subscribe to per-scope status transitions (hydration, in-flight pull, partial, denial). */
  subscribeScopeStatus(listener: () => void): () => void {
    this.scopeStatusListeners.add(listener);
    return () => this.scopeStatusListeners.delete(listener);
  }

  /** The sync scope key for a scope-value object: the membership key when a workspace/
   *  project field is present, else this engine's user scope (`u:<userId>`). Null when
   *  neither applies (anonymous byUser). Mirrors the keys pullScopes uses. */
  private scopeStatusKey(scope: Record<string, unknown> | null | undefined): ScopeKey | null {
    const membership = this.scopeKeyForScopeArgs(scope);
    if (membership) return membership;
    return this.userId != null ? `u:${this.userId}` : null;
  }

  /**
   * Per-scope hydration/sync/denial (DX v4 §10). `hydrated`: the scope has received server
   * data at least once (first paint can render rather than flash empty). `partial`: a
   * budget-limited drain left more to fetch. `syncing`: a pull is in flight. `denied`: the
   * caller is not (or no longer) a member. Derived from the engine's existing per-scope
   * bootstrap/partial/epoch/role state — cheap and reactive (subscribeScopeStatus).
   */
  getScopeStatus(scope: Record<string, unknown> | null | undefined): {
    hydrated: boolean;
    partial: boolean;
    syncing: boolean;
    denied: boolean;
  } {
    const key = this.scopeStatusKey(scope);
    if (!key) return { hydrated: false, partial: false, syncing: false, denied: false };
    return {
      hydrated: this.hydratedScopes.has(key),
      partial: this.partialScopes.has(key),
      syncing: (this.pullingScopes.get(key) ?? 0) > 0,
      denied: this.roles.has(key) && this.roles.get(key) === null
    };
  }

  /** Background-pull the scope behind a `useScopeStatus` (membership OR byUser), so its
   *  hydration/denial resolves even without a mounted query on it. Never throws. */
  async syncScope(scope: Record<string, unknown> | null | undefined): Promise<void> {
    const key = this.scopeStatusKey(scope);
    if (!key) return;
    const kind: SyncScope["kind"] = key.startsWith("u:") ? "byUser" : (key.slice(0, key.indexOf(":")) as SyncScope["kind"]);
    await this.refreshPlanScope({ kind, key });
  }

  // ---- Devtools introspection (DX v4 §8) -------------------------------------
  // Read-only snapshots for <LocalFirstDevtools />. Cheap and additive — nothing here
  // changes engine behavior. The store-backed views are async (they read the durable store).

  /** Every active live query/count view with its chosen plan (index vs scan) + result sizes. */
  debugQueries(): QueryDebugInfo[] {
    return this.cache.debugQueries();
  }

  /** Per-scope sync snapshot: cursor, hydrated/partial/syncing/denied, and the synced role. */
  async debugScopes(): Promise<
    Array<{
      scopeKey: string;
      cursor: string | null;
      hydrated: boolean;
      partial: boolean;
      syncing: boolean;
      denied: boolean;
      role: RoleValue | null | undefined;
    }>
  > {
    const keys = new Set<string>([
      ...this.hydratedScopes,
      ...this.partialScopes,
      ...this.pullingScopes.keys(),
      ...this.roles.keys()
    ]);
    const out: Array<{
      scopeKey: string;
      cursor: string | null;
      hydrated: boolean;
      partial: boolean;
      syncing: boolean;
      denied: boolean;
      role: RoleValue | null | undefined;
    }> = [];
    for (const scopeKey of keys) {
      out.push({
        scopeKey,
        cursor: await this.store.getCursor(scopeKey),
        hydrated: this.hydratedScopes.has(scopeKey),
        partial: this.partialScopes.has(scopeKey),
        syncing: (this.pullingScopes.get(scopeKey) ?? 0) > 0,
        denied: this.roles.has(scopeKey) && this.roles.get(scopeKey) === null,
        role: this.roles.has(scopeKey) ? (this.roles.get(scopeKey) ?? null) : undefined
      });
    }
    return out.sort((a, b) => (a.scopeKey < b.scopeKey ? -1 : 1));
  }

  /** The durable outbox for the devtools Outbox tab: every op with kind/table/status/age. */
  async debugOutbox(): Promise<
    Array<{
      opId: string;
      table: string;
      id: string;
      kind: OperationKind;
      functionName: string;
      status: string;
      createdAt: number;
      groupId?: string;
      error?: string;
    }>
  > {
    const operations = await this.store.getAllOperations();
    return operations.map((op) => ({
      opId: op.opId,
      table: op.table,
      id: op.id,
      kind: op.kind,
      functionName: op.functionName,
      status: op.status,
      createdAt: op.createdAt,
      groupId: op.groupId,
      error: op.error
    }));
  }

  /** Local storage footprint for the devtools Storage tab: per-table row counts, the
   *  attachment blob outbox size, and which tables have a local search index. */
  async debugStorage(): Promise<{
    tables: Array<{ table: string; rows: number }>;
    attachments: { count: number; bytes: number };
    search: Array<{ table: string; indexed: boolean }>;
  }> {
    const counts = this.cache.debugTableCounts();
    const tables = Object.keys(this.manifest.tables).map((table) => ({ table, rows: counts[table] ?? 0 }));
    let count = 0;
    let bytes = 0;
    try {
      for (const record of await this.store.getAllBlobs()) {
        count++;
        bytes += record.blob.size ?? 0;
      }
    } catch {
      // A store without a blob outbox reports zero attachments.
    }
    const search = Object.entries(this.manifest.tables).map(([table, def]) => ({
      table,
      indexed: (def.searchFields?.length ?? 0) > 0
    }));
    return { tables, attachments: { count, bytes }, search };
  }

  /** Background-sync a raw sync scope (push pending + pull it). Never throws. */
  private async refreshPlanScope(scope: SyncScope): Promise<void> {
    try {
      await this.syncOnce([scope]);
    } catch {
      // status.lastError already captures it; background sync must not throw to React.
    }
  }

  /** Map a scope-value object (`{ <partitionField>: value }`) to its membership scope
   *  key (`byWorkspace:<value>` / `byProject:<value>`). Null when no membership table
   *  declares that field, or the value is missing — byUser scopes carry no role. */
  private scopeKeyForScopeArgs(scope: Record<string, unknown> | null | undefined): ScopeKey | null {
    if (!scope) return null;
    for (const definition of Object.values(this.manifest.tables)) {
      const def = definition.scope;
      if (def.kind !== "byWorkspace" && def.kind !== "byProject") continue;
      const field = def.kind === "byWorkspace" ? def.workspaceIdField : def.projectIdField;
      const value = scope[field];
      if (value != null) return `${def.kind}:${String(value)}`;
    }
    return null;
  }

  /** The membership scope key a row lives in, or null for a byUser/unscoped table. */
  private membershipScopeKeyForRow(table: string, row: Record<string, unknown> | null): ScopeKey | null {
    if (!row) return null;
    const scope = this.manifest.tables[table]?.scope;
    if (!scope || scope.kind === "byUser") return null;
    const field = scope.kind === "byWorkspace" ? scope.workspaceIdField : scope.projectIdField;
    const value = row[field];
    return value == null ? null : `${scope.kind}:${String(value)}`;
  }

  /**
   * Evaluate the client-side write mirror (§6) for one action. ADVISORY — the server is
   * authoritative. Returns `true` when the table declares no mirror, or when the row's role
   * is not yet synced (a 0.3.x server / pre-first-pull); `false` when the scope is denied
   * (role `null`); otherwise the mirror's verdict. byUser tables have no role → always true.
   */
  can(
    table: string,
    action: OperationKind,
    input: { before?: Record<string, unknown> | null; patch?: Record<string, unknown>; proposed?: Record<string, unknown> | null }
  ): boolean {
    const mirror = this.manifest.tables[table]?.clientCan?.write;
    if (!mirror) return true;
    const before = input.before ?? null;
    const proposed = input.proposed ?? null;
    const subject = action === "insert" ? proposed : before;
    const scopeKey = this.membershipScopeKeyForRow(table, subject);
    if (!scopeKey) return true; // byUser / unscoped — server enforces ownership
    if (!this.roles.has(scopeKey)) return true; // not synced yet — advisory, don't block
    const role = this.roles.get(scopeKey) ?? null;
    if (role === null) return false; // denied
    const args: ClientCanWriteInput = { userId: this.userId, role, table, action, before, patch: input.patch, proposed };
    return mirror(args);
  }

  // ---- Undo/redo (DX v4 §7) --------------------------------------------------

  private notifyUndoListeners(): void {
    for (const listener of Array.from(this.undoListeners)) listener();
  }

  /** Subscribe to undo/redo stack changes (a recorded op, an undo/redo, or a logout clear). */
  subscribeUndo(listener: () => void): () => void {
    this.undoListeners.add(listener);
    return () => this.undoListeners.delete(listener);
  }

  /** Whether an undo is available — for `scope` (a scope-value object) if given, else any scope. */
  canUndo(scope?: Record<string, unknown> | null): boolean {
    return this.hasEntry(this.undoStacks, scope);
  }

  /** Whether a redo is available — scoped like canUndo. */
  canRedo(scope?: Record<string, unknown> | null): boolean {
    return this.hasEntry(this.redoStacks, scope);
  }

  private hasEntry(stacks: Map<ScopeKey, UndoEntry[]>, scope?: Record<string, unknown> | null): boolean {
    if (scope) {
      const key = this.scopeKeyForScopeArgs(scope);
      return key ? (stacks.get(key)?.length ?? 0) > 0 : false;
    }
    for (const stack of stacks.values()) if (stack.length > 0) return true;
    return false;
  }

  /** Undo the most recent action — in `scope` if given, else globally (most-recent by
   *  seq). Emits ordinary local-first mutations (they sync like any op) and records the
   *  redo. A batch group undoes as ONE group. No-op if nothing to undo. */
  async undo(scope?: Record<string, unknown> | null): Promise<void> {
    const entry = this.popEntry(this.undoStacks, scope);
    if (entry) await this.emitInverse(entry, this.redoStacks);
  }

  /** Redo the most recently undone action — scoped like undo. */
  async redo(scope?: Record<string, unknown> | null): Promise<void> {
    const entry = this.popEntry(this.redoStacks, scope);
    if (entry) await this.emitInverse(entry, this.undoStacks);
  }

  private popEntry(stacks: Map<ScopeKey, UndoEntry[]>, scope?: Record<string, unknown> | null): UndoEntry | null {
    if (scope) {
      const key = this.scopeKeyForScopeArgs(scope);
      const stack = key ? stacks.get(key) : undefined;
      return stack && stack.length > 0 ? stack.pop()! : null;
    }
    // Scope-less: pop the globally most-recent entry across every stack.
    let best: { stack: UndoEntry[]; entry: UndoEntry } | null = null;
    for (const stack of stacks.values()) {
      const top = stack[stack.length - 1];
      if (top && (!best || top.seq > best.entry.seq)) best = { stack, entry: top };
    }
    if (!best) return null;
    best.stack.pop();
    return best.entry;
  }

  /** Push a recorded undo unit (a user op or a batch group). Clears the scope's redo
   *  stack (a new action forks history) and caps the undo stack at UNDO_CAP. */
  private pushUndoEntry(scopeKey: ScopeKey, ops: readonly ResolvedUndoOp[]): void {
    if (ops.length === 0) return;
    const stack = this.undoStacks.get(scopeKey) ?? [];
    stack.push({ scopeKey, seq: ++this.undoSeq, ops });
    if (stack.length > UNDO_CAP) stack.shift();
    this.undoStacks.set(scopeKey, stack);
    this.redoStacks.delete(scopeKey); // a fresh action invalidates the redo future
    this.notifyUndoListeners();
  }

  /**
   * Emit an entry's inverse ops as ordinary local-first mutations and record the
   * counter-entry onto `counterStacks`. A multi-op entry is emitted as ONE atomic group.
   * The deleted-row edge (§7): a patch inverse whose row was remotely deleted is skipped
   * (its entry is dropped, never resurrected). Counter ops are computed from before-images
   * captured HERE, so redo is the inverse of the undo.
   */
  private async emitInverse(entry: UndoEntry, counterStacks: Map<ScopeKey, UndoEntry[]>): Promise<void> {
    const applicable: Array<{ op: ResolvedUndoOp; before: Record<string, unknown> | null }> = [];
    for (const op of entry.ops) {
      const before = (await this.getRow(op.table, op.id)) ?? null;
      // Deleted-row edge: undoing a patch on a remotely-deleted row is a no-op — skip it
      // (do not resurrect). An insert inverse (undo of a delete) is meant to resurrect.
      if (op.kind === "patch" && !before) continue;
      applicable.push({ op, before });
    }
    if (applicable.length === 0) {
      this.notifyUndoListeners(); // the entry was dropped
      return;
    }
    await this.timestampSeed;
    if (this.multiTabEnabled) await this.seedTimestampHighWater();
    const isGroup = applicable.length > 1;
    const groupId = isGroup ? createOpId(this.clientId) : undefined;
    const createdAts = applicable.map(() => this.monotonicNow());
    const operations: LocalOperation[] = [];
    const counterOps: ResolvedUndoOp[] = [];
    applicable.forEach(({ op, before }, index) => {
      operations.push(
        this.buildUndoOperation(
          op,
          createdAts[index]!,
          isGroup ? { groupId: groupId!, groupSize: applicable.length, groupIndex: index } : undefined
        )
      );
      const counter = this.inverseOf(op, before);
      if (counter) counterOps.push(counter);
    });
    for (const operation of operations) await this.commitLocal(operation);
    // The counter-entry replays in REVERSE order (mirror of how a group is recorded).
    if (counterOps.length > 0) {
      const stack = counterStacks.get(entry.scopeKey) ?? [];
      stack.push({ scopeKey: entry.scopeKey, seq: ++this.undoSeq, ops: counterOps.reverse() });
      if (stack.length > UNDO_CAP) stack.shift();
      counterStacks.set(entry.scopeKey, stack);
    }
    if (this.syncEnabled) this.flushPending();
    this.notifyUndoListeners();
  }

  /** Drop the table's server-minted fields (manifest `serverFields`) from a value, so an
   *  undo-of-delete re-insert carries only client-writable fields (the server re-mints the
   *  rest). No-op for a table that declares none. */
  private stripServerFields(table: string, value: Record<string, unknown>): Record<string, unknown> {
    const serverFields = this.manifest.tables[table]?.serverFields;
    if (!serverFields || serverFields.length === 0) return value;
    const drop = new Set(serverFields);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) if (!drop.has(key)) out[key] = val;
    return out;
  }

  /** A concrete op the engine committed/will commit, in the shape the inverter needs. */
  private toResolvedUndoOp(operation: LocalOperation): ResolvedUndoOp {
    if (operation.kind === "insert") {
      return { kind: "insert", table: operation.table, id: operation.id, functionName: operation.functionName, value: operation.value ?? {} };
    }
    if (operation.kind === "patch") {
      return { kind: "patch", table: operation.table, id: operation.id, functionName: operation.functionName, patch: operation.patch ?? {} };
    }
    return { kind: "delete", table: operation.table, id: operation.id, functionName: operation.functionName };
  }

  /**
   * The inverse of an op, ready to emit — or null when it can't be built (no
   * insert/delete mutation declared for the table, or a delete with no before-image).
   *  - insert → delete (needs the table's delete mutation)
   *  - delete → insert of the captured before-row (needs the table's insert mutation)
   *  - patch  → patch restoring the touched fields to their before values (same mutation)
   */
  private inverseOf(op: ResolvedUndoOp, before: Record<string, unknown> | null): ResolvedUndoOp | null {
    const names = this.tableMutationNames.get(op.table);
    if (op.kind === "insert") {
      const functionName = names?.delete;
      return functionName ? { kind: "delete", table: op.table, id: op.id, functionName } : null;
    }
    if (op.kind === "delete") {
      const functionName = names?.insert;
      if (!functionName || !before) return null;
      // Strip client system fields AND server-minted fields (serverStamp/serverOnly): the
      // resurrected row is a NEW server row that re-mints those fresh, and re-sending the
      // captured stale value would be rejected as a serverOnlyField (§0). A sequence_id-style
      // field therefore CHANGES on undo-of-delete — documented, and correct (it is a fresh row).
      return { kind: "insert", table: op.table, id: op.id, functionName, value: this.stripServerFields(op.table, stripSystemFields(before)) };
    }
    // patch: restore each touched field to its prior value. A field absent before the
    // patch has no clean "unset" via a field-LWW patch, so it's restored to null.
    const inversePatch: Record<string, unknown> = {};
    for (const field of Object.keys(op.patch)) {
      inversePatch[field] = before && field in before ? before[field] : null;
    }
    return { kind: "patch", table: op.table, id: op.id, functionName: op.functionName, patch: inversePatch };
  }

  /** Build a durable LocalOperation for an inverse op (an undo/redo emission). */
  private buildUndoOperation(
    op: ResolvedUndoOp,
    createdAt: number,
    group?: { readonly groupId: string; readonly groupSize: number; readonly groupIndex: number }
  ): LocalOperation {
    const opId = createOpId(this.clientId);
    this.opStatuses.set(opId, { opId, status: "pending" });
    return {
      opId,
      clientId: this.clientId,
      userId: this.userId,
      schemaVersion: this.manifest.schemaVersion,
      functionName: op.functionName,
      table: op.table,
      kind: op.kind,
      id: op.id,
      args: {},
      value: op.kind === "insert" ? op.value : undefined,
      patch: op.kind === "patch" ? op.patch : undefined,
      createdAt,
      status: "pending",
      ...(group ?? {})
    };
  }

  /** The scope key an op's undo entry belongs to: byUser → the user scope; membership →
   *  the row's partition (from the inserted value, or the before-image for patch/delete). */
  private scopeKeyForOp(operation: LocalOperation, before: Record<string, unknown> | null): ScopeKey {
    const scope = this.manifest.tables[operation.table]?.scope;
    if (!scope || scope.kind === "byUser") return `u:${this.userId ?? "anon"}`;
    const row = operation.kind === "insert" ? operation.value ?? null : before;
    return this.membershipScopeKeyForRow(operation.table, row) ?? `u:${this.userId ?? "anon"}`;
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
    await this.cacheWrite(() => this.store.enqueueOperation(operation));
    this.cache.applyLocalOperation(operation);
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
    await this.cacheWrite(() => this.store.updateOperationStatus(opId, status, error));
    this.cache.updateOperationStatus(opId, status, error);
  }

  private async pushSingleOperation<TResult>(operation: LocalOperation): Promise<TResult> {
    return this.serializePush(() => this.pushSingleOperationNow<TResult>(operation));
  }

  private async pushSingleOperationNow<TResult>(operation: LocalOperation): Promise<TResult> {
    const epoch = await this.store.getEpoch();
    await this.markStatus(operation.opId, "pushing");
    if (this.isLikelyOffline()) {
      this.setStatus({ online: false });
      await this.markStatus(operation.opId, "pending");
      throw new Error("Local-first transport is offline; operation remains pending.");
    }
    // Retry transient failures: the server dedupes by (userId, opId) and re-delivers the
    // confirming change (R9), so a retry after a lost ACK resolves correctly rather than
    // spuriously rejecting call.server. Sustained offline still rejects (op syncs later).
    let response: Awaited<ReturnType<SyncTransport["push"]>>;
    try {
      response = await this.tracked(() =>
        this.withTimeout(
          () =>
            this.withRetry(() =>
              this.transport.push({
                clientId: this.clientId,
                userId: this.userId,
                schemaVersion: this.manifest.schemaVersion,
                mutations: [operation]
              })
            ),
          "push"
        )
      );
    } catch (error) {
      const durable = await this.store.getOperation(operation.opId);
      if ((await this.store.getEpoch()) !== epoch || !durable) {
        const cancelled = new Error(`Local-first operation ${operation.opId} was cancelled because its local data was cleared.`);
        this.opStatuses.set(operation.opId, { opId: operation.opId, status: "rejected", error: cancelled.message });
        throw cancelled;
      }
      await this.markStatus(operation.opId, "pending");
      throw error;
    }

    if ((await this.store.getEpoch()) !== epoch) {
      const cancelled = new Error(`Local-first operation ${operation.opId} was cancelled because its local data was cleared.`);
      this.opStatuses.set(operation.opId, { opId: operation.opId, status: "rejected", error: cancelled.message });
      throw cancelled;
    }

    if (response.schemaMismatch) {
      // A schema mismatch is not an ack: leave the op pending (do NOT mark acked,
      // or it would drop out of sync and replay forever as local-only state) and
      // block sync until the client upgrades. Mirrors pushPendingOperations.
      this.blockForSchemaMismatch();
      await this.markStatus(operation.opId, "pending");
      await this.refreshPendingCount();
      throw new Error("Local-first schema version is behind the server; reload to upgrade.");
    }

    try {
      await this.cacheWrite(() => this.store.applyServerChanges(response.changes, epoch));
      this.cache.applyServerChanges(response.changes);
    } catch (error) {
      if (await this.store.getOperation(operation.opId)) await this.markStatus(operation.opId, "pending");
      throw error;
    }

    if ((await this.store.getEpoch()) !== epoch) {
      const cancelled = new Error(`Local-first operation ${operation.opId} was cancelled because its local data was cleared.`);
      this.opStatuses.set(operation.opId, { opId: operation.opId, status: "rejected", error: cancelled.message });
      throw cancelled;
    }

    const rejection = response.rejected.find((item) => item.opId === operation.opId);
    if (rejection) {
      await this.markStatus(operation.opId, "rejected", rejection.message);
      this.recordOutcome({ opId: operation.opId, status: "rejected", error: rejection.message });
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
      await this.applyNoopDelete(operation, response.serverTime, epoch);
    }
    this.recordOutcome({ opId: operation.opId, status: "acked", result: accepted.serverResult });
    this.setStatus({ lastPushAt: response.serverTime });
    await this.refreshPendingCount();
    return accepted.serverResult as TResult;
  }

  private async pushPendingOperations(): Promise<void> {
    return this.serializePush(() => this.pushPendingOperationsNow());
  }

  private async pushPendingOperationsNow(): Promise<void> {
    if (!this.syncEnabled) {
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
    // Partition into request-sized chunks that never split an atomic group. Default cap
    // is Infinity → one chunk → identical to the historical single-request behavior.
    for (const chunk of chunkRespectingGroups(pending, this.maxPushBatch)) {
      const stop = await this.pushChunkNow(chunk);
      if (stop) return;
    }
  }

  /** Push ONE contiguous chunk of pending ops (a whole request). Returns true to stop the
   *  outer drain (schema mismatch or a logout clear). Grouped ops within the chunk are
   *  applied atomically by the server; the client acks/rejects each op as it comes back. */
  private async pushChunkNow(pending: readonly LocalOperation[]): Promise<boolean> {
    const epoch = await this.store.getEpoch();
    for (const op of pending) await this.markStatus(op.opId, "pushing");
    let response: Awaited<ReturnType<SyncTransport["push"]>>;
    try {
      response = await this.tracked(() =>
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
    } catch (error) {
      for (const op of pending) {
        if (await this.store.getOperation(op.opId)) await this.markStatus(op.opId, "pending");
      }
      throw error;
    }
    if ((await this.store.getEpoch()) !== epoch) {
      for (const op of pending) {
        this.opStatuses.set(op.opId, { opId: op.opId, status: "rejected", error: "Local data was cleared during push." });
      }
      throw new Error("Local-first push was cancelled because local data was cleared.");
    }
    if (response.schemaMismatch) {
      this.blockForSchemaMismatch();
      for (const op of pending) await this.markStatus(op.opId, "pending");
      return true;
    }
    // Apply confirming changes BEFORE acking: applyServerChanges is what prunes a
    // confirmed op from the outbox. If it threw AFTER we'd marked ops acked, those ops
    // would be neither owed (so never re-pushed) nor canonical — stuck _pending forever.
    try {
      await this.cacheWrite(() => this.store.applyServerChanges(response.changes, epoch));
      this.cache.applyServerChanges(response.changes);
    } catch (error) {
      for (const op of pending) {
        if (await this.store.getOperation(op.opId)) await this.markStatus(op.opId, "pending");
      }
      throw error;
    }
    if ((await this.store.getEpoch()) !== epoch) {
      for (const op of pending) {
        this.opStatuses.set(op.opId, { opId: op.opId, status: "rejected", error: "Local data was cleared during push." });
      }
      throw new Error("Local-first push was cancelled because local data was cleared.");
    }
    const pendingById = new Map(pending.map((op) => [op.opId, op]));
    for (const accepted of response.accepted) {
      await this.markStatus(accepted.opId, "acked");
      // A no-op delete acks with no confirming change, so nothing would ever prune it — drop
      // it explicitly. A normal op is pruned by its change (above/redelivered), so leave it
      // here: dropping before its change arrived would lose the row.
      if (isNoopAck(accepted.serverResult)) {
        const operation = pendingById.get(accepted.opId);
        if (operation) await this.applyNoopDelete(operation, response.serverTime, epoch);
      }
      this.recordOutcome({ opId: accepted.opId, status: "acked", result: accepted.serverResult });
    }
    for (const rejected of response.rejected) {
      await this.markStatus(rejected.opId, "rejected", rejected.message);
      this.recordOutcome({ opId: rejected.opId, status: "rejected", error: rejected.message });
    }
    const covered = new Set([...response.accepted.map((x) => x.opId), ...response.rejected.map((x) => x.opId)]);
    for (const op of pending) {
      if (!covered.has(op.opId) && (await this.store.getOperation(op.opId))) await this.markStatus(op.opId, "pending");
    }
    this.setStatus({ lastPushAt: response.serverTime });
    await this.refreshPendingCount();
    return false;
  }

  private serializePush<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.pushChain.then(fn, fn);
    this.pushChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private pushCoordinatedOperation<TResult>(operation: LocalOperation): Promise<TResult> {
    const outcome = this.waitForOperationOutcome<TResult>(operation.opId);
    if (this.syncEnabled) this.flushPending();
    return outcome;
  }

  private waitForOperationOutcome<TResult>(opId: string): Promise<TResult> {
    const observed = this.observedOutcomes.get(opId);
    if (observed) {
      this.observedOutcomes.delete(opId);
      return observed.status === "acked"
        ? Promise.resolve(observed.result as TResult)
        : Promise.reject(new Error(observed.error));
    }
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.outcomeWaiters.get(opId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.outcomeWaiters.delete(opId);
        void this.store.getOperation(opId).then(async (operation) => {
          if (operation && (operation.status === "pending" || operation.status === "pushing")) {
            await this.markStatus(opId, "pending");
          }
          reject(new Error(`Timed out waiting for the leader to acknowledge local-first operation ${opId}; it remains pending.`));
        });
      }, this.syncTimeoutMs > 0 ? this.syncTimeoutMs : 15000);
      (timer as { unref?: () => void }).unref?.();
      const waiter = { resolve: resolve as (value: unknown) => void, reject, timer };
      let waiters = this.outcomeWaiters.get(opId);
      if (!waiters) {
        waiters = new Set();
        this.outcomeWaiters.set(opId, waiters);
      }
      waiters.add(waiter);
    });
  }

  private recordOutcome(outcome: OperationOutcome, broadcast = true): void {
    this.opStatuses.set(outcome.opId, {
      opId: outcome.opId,
      status: outcome.status,
      error: outcome.status === "rejected" ? outcome.error : undefined
    });
    const waiters = this.outcomeWaiters.get(outcome.opId);
    if (waiters?.size) {
      this.outcomeWaiters.delete(outcome.opId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        if (outcome.status === "acked") waiter.resolve(outcome.result);
        else waiter.reject(new Error(outcome.error));
      }
    } else {
      this.observedOutcomes.set(outcome.opId, outcome);
      if (this.observedOutcomes.size > 100) this.observedOutcomes.delete(this.observedOutcomes.keys().next().value!);
    }
    if (broadcast) for (const listener of Array.from(this.outcomeListeners)) listener(outcome);
    // A newly-acked metadata insert may unblock an attachment whose upload was gated
    // on it being synced server-side; nudge the uploader.
    if (outcome.status === "acked") void this.attachments.wake();
  }

  private async applyNoopDelete(operation: LocalOperation, serverTime: number, expectedEpoch: number): Promise<void> {
    if (operation.kind !== "delete") {
      await this.cacheWrite(() => this.store.dropOperation(operation.opId));
      this.cache.dropOperation(operation.opId);
      return;
    }
    const current = (await this.store.getCanonicalRows(operation.table)).find((row) => row._id === operation.id);
    if (!current) {
      await this.cacheWrite(() => this.store.dropOperation(operation.opId));
      this.cache.dropOperation(operation.opId);
      return;
    }
    const scopeKey = this.scopeKeyForRow(operation.table, current) ?? "";
    if (scopeKey) this.scopeEpochs.set(scopeKey, (this.scopeEpochs.get(scopeKey) ?? 0) + 1);
    const change = {
      changeId: `noop-delete:${operation.opId}`,
      scopeKey,
      table: operation.table,
      id: operation.id,
      kind: "delete" as const,
      version: (typeof current._version === "number" ? current._version : 0) + 1,
      serverTime,
      opId: operation.opId
    };
    await this.cacheWrite(() => this.store.applyServerChange(change, expectedEpoch));
    this.cache.applyServerChanges([change]);
  }

  private scopeKeyForRow(tableName: string, row: RowValue): string | null {
    const table = this.manifest.tables[tableName];
    if (!table) return null;
    const scope = table.scope;
    const field =
      scope.kind === "byUser" ? scope.field : scope.kind === "byWorkspace" ? scope.workspaceIdField : scope.projectIdField;
    const value = row[field];
    return typeof value !== "string" ? null : scope.kind === "byUser" ? `u:${value}` : `${scope.kind}:${value}`;
  }

  /** Evict canonical rows of every table living in `scopeKey`. With `keep`
   *  (table → ids a completed snapshot bootstrap delivered), rows the snapshot did
   *  not contain are removed — ghost eviction. Without it (membership revoked),
   *  the whole scope leaves the device. Tables are matched by scope kind; rows by
   *  their partition field. */
  private async evictScope(
    scopeKey: string,
    keep: ReadonlyMap<string, ReadonlySet<string>> | null,
    expectedEpoch?: number
  ): Promise<void> {
    const sep = scopeKey.indexOf(":");
    if (sep === -1) {
      return;
    }
    const prefix = scopeKey.slice(0, sep);
    const value = scopeKey.slice(sep + 1);
    const kind = prefix === "u" ? "byUser" : prefix;
    for (const table of Object.values(this.manifest.tables)) {
      const scope = table.scope;
      if (scope.kind !== kind) {
        continue;
      }
      const field =
        scope.kind === "byUser" ? scope.field : scope.kind === "byWorkspace" ? scope.workspaceIdField : scope.projectIdField;
      const keepIds = keep ? keep.get(table.table) ?? new Set<string>() : undefined;
      await this.cacheWrite(() => this.store.removeCanonicalRows(table.table, field, value, keepIds, expectedEpoch));
      this.cache.removeCanonicalRows(table.table, field, value, keepIds);
    }
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
    // Mark these scopes as pulling (useScopeStatus → syncing) for the duration of the drain.
    for (const scope of scopes) this.pullingScopes.set(scope.key, (this.pullingScopes.get(scope.key) ?? 0) + 1);
    this.notifyScopeStatusListeners();
    try {
      await this.pullScopesInner(scopes);
    } finally {
      for (const scope of scopes) {
        const next = (this.pullingScopes.get(scope.key) ?? 1) - 1;
        if (next <= 0) this.pullingScopes.delete(scope.key);
        else this.pullingScopes.set(scope.key, next);
      }
      this.notifyScopeStatusListeners();
    }
  }

  private async pullScopesInner(scopes: readonly SyncScope[]): Promise<void> {
    const partialRun = ++this.nextPartialRun;
    for (const scope of scopes) this.partialRuns.set(scope.key, partialRun);
    const cursors: Record<string, string | null> = {};
    for (const scope of scopes) {
      cursors[scope.key] = await this.store.getCursor(scope.key);
    }
    // In-flight bootstrap continuations (opaque server tokens). Deliberately NOT
    // persisted: an interrupted bootstrap simply restarts from its first page.
    let bootstrapCursors: Record<string, string> = {};
    // Rows delivered by an in-flight snapshot bootstrap, per scope per table. On
    // completion, canonical rows NOT in this set are evicted (ghosts whose delete
    // changes were GC'd). Accumulating instead of clearing upfront keeps the local
    // cache whole during the bootstrap and makes an aborted bootstrap a no-op.
    const snapshotSeen = new Map<string, Map<string, Set<string>>>();
    // Drain: the server caps each scope per pull, so keep pulling with the advanced cursors
    // until every scope reports no hasMore (a cold client may be many pages behind). Exits
    // early — marking the cache partial — if a round advances no cursor or hits the backstop.
    const incompleteScopes = new Set<string>();
    let shouldUpdatePartial = true;
    for (let round = 0; round < MAX_PULL_ROUNDS; round++) {
      const storeEpoch = await this.store.getEpoch();
      const responseEpochs = new Map(scopes.map((scope) => [scope.key, this.scopeEpochs.get(scope.key) ?? 0]));
      const response = await this.tracked(() =>
        this.withTimeout(
          () =>
            this.withRetry(() =>
              this.transport.pull({
                clientId: this.clientId,
                userId: this.userId,
                schemaVersion: this.manifest.schemaVersion,
                scopes,
                cursors,
                bootstrapCursors
              })
            ),
          "pull"
        )
      );
      const applied = await this.serializePullApply(async () => {
        // A denied-scope response or clear that won while this request was in flight
        // invalidates the WHOLE response — changes, cursors, and bootstrap state.
        if (
          (await this.store.getEpoch()) !== storeEpoch ||
          scopes.some((scope) => (this.scopeEpochs.get(scope.key) ?? 0) !== responseEpochs.get(scope.key))
        ) {
          return null;
        }
        if (response.schemaMismatch) {
          this.blockForSchemaMismatch();
          return { schemaMismatch: true, advanced: false, more: false, nextBootstrap: {} as Record<string, string> };
        }

        const denied = new Set(response.deniedScopes ?? []);
        let rolesChanged = false;
        // Bump before eviction. Any older response waiting in the apply queue now fails
        // the epoch check above and cannot resurrect this scope.
        for (const scopeKey of denied) {
          this.scopeEpochs.set(scopeKey, (this.scopeEpochs.get(scopeKey) ?? 0) + 1);
          await this.evictScope(scopeKey, null, storeEpoch);
          await this.store.removeCursor(scopeKey, storeEpoch);
          cursors[scopeKey] = null;
          snapshotSeen.delete(scopeKey);
          // Revoked: no longer hydrated (its data left the device). useScopeStatus →
          // { hydrated:false, denied:true }.
          this.hydratedScopes.delete(scopeKey);
          // Record the denial durably as a `null` role marker (§6): useRole → null (denied),
          // distinct from an absent entry (not yet synced → undefined).
          if (this.roles.get(scopeKey) !== null) {
            this.roles.set(scopeKey, null);
            await this.store.setRole?.(scopeKey, null, storeEpoch);
            rolesChanged = true;
          }
        }
        // Ship the server-resolved roles into the durable cache (§6). Denied scopes are
        // handled above (null); everything here is an authorized membership role.
        for (const [scopeKey, role] of Object.entries(response.roles ?? {})) {
          if (denied.has(scopeKey)) continue;
          if (this.roles.get(scopeKey) !== role) {
            this.roles.set(scopeKey, role as RoleValue);
            await this.store.setRole?.(scopeKey, role as RoleValue, storeEpoch);
            rolesChanged = true;
          }
        }
        if (rolesChanged) this.notifyRoleListeners();

        for (const scopeKey of response.snapshotScopes ?? []) {
          if (!denied.has(scopeKey) && !snapshotSeen.has(scopeKey)) snapshotSeen.set(scopeKey, new Map());
        }
        const changes = response.changes.filter((change) => !denied.has(change.scopeKey));
        for (const change of changes) {
          const tables = snapshotSeen.get(change.scopeKey);
          if (!tables) continue;
          let ids = tables.get(change.table);
          if (!ids) {
            ids = new Set();
            tables.set(change.table, ids);
          }
          ids.add(change.id);
        }
        await this.cacheWrite(() => this.store.applyServerChanges(changes, storeEpoch));
        this.cache.applyServerChanges(changes);

        const nextBootstrap = Object.fromEntries(
          Object.entries(response.bootstrapCursors ?? {}).filter(([scopeKey]) => !denied.has(scopeKey))
        );
        let advanced =
          JSON.stringify(nextBootstrap) !== JSON.stringify(bootstrapCursors) && Object.keys(nextBootstrap).length > 0;

        // Ghost eviction MUST commit before the tail cursor. A crash after eviction
        // merely re-bootstraps; a cursor-first crash would strand ghosts forever.
        for (const [scopeKey, tables] of Array.from(snapshotSeen)) {
          if (scopeKey in response.cursors && !(scopeKey in nextBootstrap)) {
            await this.evictScope(scopeKey, tables, storeEpoch);
            snapshotSeen.delete(scopeKey);
          }
        }
        for (const [scopeKey, cursor] of Object.entries(response.cursors)) {
          if (denied.has(scopeKey)) continue;
          if (cursors[scopeKey] !== cursor) advanced = true;
          await this.store.setCursor(scopeKey, cursor, storeEpoch);
          cursors[scopeKey] = cursor;
          // A delivered cursor means this scope has received server data at least once —
          // it is hydrated (first paint can render) even if a later round marks it partial.
          this.hydratedScopes.add(scopeKey);
        }
        if ((await this.store.getEpoch()) !== storeEpoch) return null;
        this.setStatus({ lastPullAt: response.serverTime });
        return {
          schemaMismatch: false,
          advanced,
          more: response.hasMore ? Object.values(response.hasMore).some(Boolean) : changes.length > 0,
          nextBootstrap
        };
      });
      if (!applied) {
        shouldUpdatePartial = false;
        break;
      }
      if (applied.schemaMismatch) return;
      bootstrapCursors = applied.nextBootstrap;
      const more = applied.more;
      if (!more) {
        break;
      }
      if (!applied.advanced || round === MAX_PULL_ROUNDS - 1) {
        // More remains but the cursor didn't move (or we hit the backstop): stop and
        // surface that the cache is not fully caught up rather than spin.
        const serverIncomplete = response.hasMore
          ? Object.entries(response.hasMore).filter(([, value]) => value).map(([key]) => key)
          : scopes.map((scope) => scope.key);
        for (const key of serverIncomplete) incompleteScopes.add(key);
        break;
      }
    }
    if (shouldUpdatePartial) {
      for (const scope of scopes) {
        if (this.partialRuns.get(scope.key) !== partialRun) continue;
        if (incompleteScopes.has(scope.key)) this.partialScopes.add(scope.key);
        else this.partialScopes.delete(scope.key);
      }
      this.setStatus({ partial: this.partialScopes.size > 0 });
    }
  }

  private serializePullApply<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.pullApplyChain.then(fn, fn);
    this.pullApplyChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
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
    const operations = await this.store.getAllOperations();
    const pending = operations.filter((operation) => operation.status === "pending" || operation.status === "pushing");
    const rejected = operations.filter((operation) => operation.status === "rejected");
    // Ungrouped rejected ops keep the exact per-op shape every prior release produced.
    const rejectedOperations: RecoveryOperation[] = rejected
      .filter((operation) => operation.groupId === undefined)
      .map(({ opId, table, id, kind, schemaVersion, createdAt, error }) => ({
        opId,
        table,
        id,
        kind,
        schemaVersion,
        createdAt,
        error
      }));
    // A rejected atomic group surfaces ONCE — fold every member op into one entry keyed
    // by groupId (ordered by groupIndex), not N per-op rejections.
    const groups = new Map<string, LocalOperation[]>();
    for (const operation of rejected) {
      if (operation.groupId === undefined) continue;
      const bucket = groups.get(operation.groupId);
      if (bucket) bucket.push(operation);
      else groups.set(operation.groupId, [operation]);
    }
    const failedGroups: RecoveryGroup[] = Array.from(groups.entries()).map(([groupId, members]) => {
      const ordered = [...members].sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0));
      return {
        groupId,
        opIds: ordered.map((operation) => operation.opId),
        tables: Array.from(new Set(ordered.map((operation) => operation.table))),
        schemaVersion: ordered[0]!.schemaVersion,
        createdAt: Math.min(...ordered.map((operation) => operation.createdAt)),
        error: ordered.find((operation) => operation.error)?.error
      };
    });
    this.setStatus({
      pendingMutations: pending.length,
      recovery: { ...this.status.recovery, rejectedOperations, failedGroups }
    });
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
