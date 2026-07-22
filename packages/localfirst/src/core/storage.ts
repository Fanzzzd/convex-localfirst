import type {
  Cursor,
  LocalId,
  LocalOperation,
  OperationStatus,
  RoleValue,
  RowValue,
  ScopeKey,
  ServerChange,
  TableName,
} from "./types.js";

export type StoreListener = () => void;
export type StoreUnsubscribe = () => void;

/** Statuses a local store still owes the server — the filter for getPendingOperations. */
export const OWED_STATUSES: ReadonlySet<OperationStatus> = new Set(["pending", "pushing"]);

/**
 * A durable attachment blob in the local outbox (see AttachmentManager). Keyed by
 * `localId` — the id of the metadata row it belongs to — so it survives reloads and
 * re-enters the upload queue on boot. Evicted ONLY after the server confirms finalize
 * (never before), so an in-progress upload is always recoverable.
 */
export type StoredBlob = {
  readonly localId: LocalId;
  readonly table: TableName;
  readonly blob: Blob;
  /** The metadata-row insert op, so the uploader can wait until the row is synced
   *  server-side before requesting an upload URL / finalizing. Absent only for a
   *  best-effort update failure — the uploader then falls back to attempt+retry. */
  readonly opId?: string;
  readonly createdAt: number;
};

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
  applyServerChange(change: ServerChange, expectedEpoch?: number): Promise<void>;
  /**
   * Apply a batch of server changes with a SINGLE notify (and, for durable stores,
   * a single transaction). The hot path for sync pulls: applying N changes one at
   * a time would fire N notifications — each re-deriving + re-cloning every row in
   * every mounted query — turning a cold pull into O(N×rows). Order is preserved so
   * repeated changes to the same row resolve correctly.
   */
  applyServerChanges(changes: readonly ServerChange[], expectedEpoch?: number): Promise<void>;

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
  setCursor(scopeKey: ScopeKey, cursor: string, expectedEpoch?: number): Promise<void>;

  /** Delete canonical rows of `table` whose `field` equals `value`, except ids in
   *  `keepIds`. Ghost eviction after a snapshot bootstrap (keepIds = rows the
   *  snapshot delivered) and full scope eviction on membership revocation (no
   *  keepIds). Pending operations are untouched: they replay/push as usual. */
  removeCanonicalRows(
    table: TableName,
    field: string,
    value: unknown,
    keepIds?: ReadonlySet<LocalId>,
    expectedEpoch?: number,
  ): Promise<void>;

  /** Forget a scope's cursor entirely (revocation): a later re-grant must
   *  re-bootstrap instead of resuming from a cursor whose rows were evicted. */
  removeCursor(scopeKey: ScopeKey, expectedEpoch?: number): Promise<void>;

  /**
   * OPTIONAL durable per-scope role cache (DX v4 §6). The role the server resolved for
   * this user in a membership scope, persisted so useRole/useCan survive a reload without
   * waiting for the first pull. Absent (a custom store that predates this): roles live in
   * engine memory only — correct, just not reload-durable. Dropped by clear() on logout.
   */
  getRoles?(): Promise<Record<ScopeKey, RoleValue>>;
  setRole?(scopeKey: ScopeKey, role: RoleValue, expectedEpoch?: number): Promise<void>;
  removeRole?(scopeKey: ScopeKey, expectedEpoch?: number): Promise<void>;

  /** Logout generation. Pull responses carry the value they started under; stores
   *  reject every write from an older generation so clear() cannot be undone. */
  getEpoch(): Promise<number>;

  /** Durable attachment blob outbox (see StoredBlob). Blobs live in their own store,
   *  independent of canonical rows/ops, and are dropped by clear() on logout. */
  putBlob(record: StoredBlob): Promise<void>;
  getBlob(localId: LocalId): Promise<StoredBlob | null>;
  getAllBlobs(): Promise<readonly StoredBlob[]>;
  deleteBlob(localId: LocalId): Promise<void>;

  /** Drop all data for this namespace (logout). */
  clear(): Promise<void>;

  subscribe(listener: StoreListener): StoreUnsubscribe;
  notify(): void;
};
