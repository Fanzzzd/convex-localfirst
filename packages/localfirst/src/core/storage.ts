import type {
  Cursor,
  LocalId,
  LocalOperation,
  OperationStatus,
  RowValue,
  ScopeKey,
  ServerChange,
  TableName
} from "./types.js";

export type StoreListener = () => void;
export type StoreUnsubscribe = () => void;

/**
 * Canonical-centric local store.
 *
 * Invariant I1: the live view returned by getRows/getRow is ALWAYS derived as
 * `canonical snapshot + replay(pending ops)`. There is no separately-mutated
 * "live" row map, so a server change physically cannot clobber a pending local
 * operation. Local mutations only enqueue operations; the canonical snapshot
 * only changes through applyServerChange.
 */
export type LocalStore = {
  /**
   * @internal Derived live view for a table (canonical + replayed pending ops);
   * includes _deleted rows. The store is a persistence PRIMITIVE for the engine —
   * its reads are UNSCOPED. App code must read through the React hooks
   * (useQuery/useLiveQuery), which enforce the scoped fail-closed guard; do not
   * call getRows/getRow directly to display data.
   */
  getRows(table: TableName): Promise<readonly RowValue[]>;
  getRow(table: TableName, id: LocalId): Promise<RowValue | null>;

  /** Canonical server snapshot, for inspection/tests. */
  getCanonicalRows(table: TableName): Promise<readonly RowValue[]>;
  /** Apply one authoritative server change to the canonical snapshot (and prune a confirmed op). */
  applyServerChange(change: ServerChange): Promise<void>;
  /**
   * Apply a batch of server changes with a SINGLE notify (and, for durable stores,
   * a single transaction). The hot path for sync pulls: applying N changes one at
   * a time would fire N notifications — each re-deriving + re-cloning every row in
   * every mounted query — turning a cold pull into O(N×rows). Order is preserved so
   * repeated changes to the same row resolve correctly.
   */
  applyServerChanges(changes: readonly ServerChange[]): Promise<void>;

  /** Outbox. */
  enqueueOperation(operation: LocalOperation): Promise<void>;
  /** Ops still owed to the server (pending|pushing), ordered deterministically. */
  getPendingOperations(): Promise<readonly LocalOperation[]>;
  /** Every op still in the log, for conflict inspection. */
  getAllOperations(): Promise<readonly LocalOperation[]>;
  getOperation(opId: string): Promise<LocalOperation | null>;
  updateOperationStatus(opId: string, status: OperationStatus, error?: string): Promise<void>;
  /** Remove an op from the outbox. Used for an accepted op that produced NO canonical
   *  change (an idempotent no-op delete): applyServerChanges only prunes ops a change
   *  references, so without this the op lingers, replayed forever. */
  dropOperation(opId: string): Promise<void>;

  getCursor(scopeKey: ScopeKey): Promise<Cursor>;
  setCursor(scopeKey: ScopeKey, cursor: string): Promise<void>;

  /** Delete canonical rows of `table` whose `field` equals `value`, except ids in
   *  `keepIds`. Ghost eviction after a snapshot bootstrap (keepIds = rows the
   *  snapshot delivered) and full scope eviction on membership revocation (no
   *  keepIds). Pending operations are untouched: they replay/push as usual. */
  removeCanonicalRows(table: TableName, field: string, value: unknown, keepIds?: ReadonlySet<LocalId>): Promise<void>;

  /** Forget a scope's cursor entirely (revocation): a later re-grant must
   *  re-bootstrap instead of resuming from a cursor whose rows were evicted. */
  removeCursor(scopeKey: ScopeKey): Promise<void>;

  /** Drop all data for this namespace (logout). */
  clear(): Promise<void>;

  subscribe(listener: StoreListener): StoreUnsubscribe;
  notify(): void;
};
