export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type TableName = string;
export type FunctionName = string;
export type LocalId = string;
export type ClientId = string;
export type UserId = string;
export type ScopeKey = string;
export type Cursor = string | null;

export type RowValue = Record<string, unknown> & {
  _id: LocalId;
  _table?: TableName;
  _version?: number;
  _deleted?: boolean;
  _pending?: boolean;
  _conflict?: ConflictInfo;
};

export type ConflictInfo = {
  // schema-mismatch is surfaced separately via SyncStatus.blockedBySchemaMismatch, not as a
  // per-row conflict — view.ts only ever emits these two kinds.
  readonly kind: "serverRejected" | "mergeFailed";
  readonly message: string;
  readonly opId?: string;
  readonly serverVersion?: number;
};

export type OperationKind = "insert" | "patch" | "delete";
export type OperationStatus = "pending" | "pushing" | "acked" | "rejected";

export type OperationPlan =
  | {
      readonly kind: "insert";
      readonly table: TableName;
      readonly id?: LocalId;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly kind: "patch";
      readonly table: TableName;
      readonly id: LocalId;
      readonly patch: Record<string, unknown>;
    }
  | {
      readonly kind: "delete";
      readonly table: TableName;
      readonly id: LocalId;
    };

export type LocalOperation = {
  readonly opId: string;
  readonly clientId: ClientId;
  readonly userId: UserId | null;
  readonly schemaVersion: number;
  readonly functionName: FunctionName;
  readonly table: TableName;
  readonly kind: OperationKind;
  readonly id: LocalId;
  readonly args: JsonValue;
  readonly value?: Record<string, unknown>;
  readonly patch?: Record<string, unknown>;
  readonly createdAt: number;
  readonly status: OperationStatus;
  readonly error?: string;
};

export type ServerChangeKind = "insert" | "patch" | "delete" | "replace";

export type ServerChange = {
  readonly changeId: string;
  readonly scopeKey: ScopeKey;
  readonly table: TableName;
  readonly id: LocalId;
  readonly kind: ServerChangeKind;
  readonly value?: Record<string, unknown>;
  readonly patch?: Record<string, unknown>;
  readonly version: number;
  readonly serverTime: number;
  readonly opId?: string;
};

export type SyncScope = {
  readonly kind: "byUser" | "byWorkspace" | "byProject";
  readonly key: ScopeKey;
  readonly table?: TableName;
};

export type PushRequest = {
  readonly clientId: ClientId;
  readonly userId: UserId | null;
  readonly schemaVersion: number;
  readonly mutations: readonly LocalOperation[];
};

export type AcceptedMutation = {
  readonly opId: string;
  readonly serverResult?: unknown;
};

export type RejectedMutation = {
  readonly opId: string;
  readonly message: string;
  readonly code?: string;
  readonly rowId?: LocalId;
};

export type IdMapEntry = {
  readonly table: TableName;
  readonly localId: LocalId;
  readonly serverId: string;
};

export type PushResponse = {
  readonly accepted: readonly AcceptedMutation[];
  readonly rejected: readonly RejectedMutation[];
  readonly idMaps: readonly IdMapEntry[];
  readonly changes: readonly ServerChange[];
  readonly serverTime: number;
  /** Server signals the client schema version is incompatible; client must not apply. */
  readonly schemaMismatch?: boolean;
};

export type PullRequest = {
  readonly clientId: ClientId;
  readonly userId: UserId | null;
  readonly schemaVersion: number;
  readonly scopes: readonly SyncScope[];
  readonly cursors: Record<ScopeKey, Cursor>;
  /** Mid-bootstrap continuation tokens (opaque; echoed from the prior PullResponse). */
  readonly bootstrapCursors?: Record<ScopeKey, string>;
};

export type PullResponse = {
  readonly changes: readonly ServerChange[];
  readonly cursors: Record<ScopeKey, string>;
  readonly serverTime: number;
  /** Server signals the client schema version is incompatible; client must not apply. */
  readonly schemaMismatch?: boolean;
  /** Per-scope: true if the server capped this page and more changes remain past the
   *  returned cursor. Lets the client drain to completion and report partial hydration
   *  (a large cold start) instead of silently stopping behind. */
  readonly hasMore?: Record<ScopeKey, boolean>;
  /** Scopes whose changes in THIS response are snapshot-bootstrap pages. When such
   *  a scope completes (cursor delivered, no continuation token), the client evicts
   *  canonical rows the snapshot did not contain — ghost rows whose delete changes
   *  were GC'd. No upfront clear: reads stay whole throughout, and an aborted
   *  bootstrap changes nothing. */
  readonly snapshotScopes?: readonly ScopeKey[];
  /** Per-scope bootstrap continuation tokens to echo back in the next pull. */
  readonly bootstrapCursors?: Record<ScopeKey, string>;
  /** Requested scopes this user is not (or no longer) a member of: evict their
   *  rows and forget their cursors — revocation removes data from the device. */
  readonly deniedScopes?: readonly ScopeKey[];
};

export type SyncStatus = {
  readonly online: boolean;
  readonly syncing: boolean;
  readonly pendingMutations: number;
  readonly lastPushAt: number | null;
  readonly lastPullAt: number | null;
  readonly lastError: string | null;
  readonly blockedBySchemaMismatch: boolean;
  /** True while the local cache is still catching up to the server for some scope (a
   *  large cold start drained past the per-pull cap). False once fully hydrated. */
  readonly partial: boolean;
  /** Durable writes that need user/app recovery instead of disappearing silently.
   *  Rejected operations survive reload; older-schema operations live in the prior
   *  IndexedDB namespace and cannot be pushed under the current schema. */
  readonly recovery: RecoveryStatus;
};

export type RecoveryOperation = Pick<
  LocalOperation,
  "opId" | "table" | "id" | "kind" | "schemaVersion" | "createdAt" | "error"
> & { readonly namespace?: string };

export type RecoveryStatus = {
  readonly rejectedOperations: readonly RecoveryOperation[];
  readonly olderSchemaOperations: readonly RecoveryOperation[];
  /** Attachment uploads that exhausted retry (network) or were rejected by the
   *  server finalize. The metadata row stays synced and the local blob is RETAINED
   *  (never evicted before a confirmed finalize), so the app can offer a retry. */
  readonly failedAttachments: readonly AttachmentRecovery[];
};

/** A durable attachment upload that needs app/user recovery. The blob is still in
 *  the local outbox (retained), keyed by `localId` — the metadata row's id. */
export type AttachmentRecovery = {
  readonly localId: LocalId;
  readonly table: TableName;
  readonly error: string;
  readonly createdAt: number;
};

/** Live upload state for one attachment (keyed by the metadata row's localId).
 *  `progress` is a 0..1 fraction while uploading (bytes sent / total), null otherwise. */
export type AttachmentUploadState = {
  readonly state: "queued" | "uploading" | "done" | "failed";
  readonly progress: number | null;
  readonly error?: string;
};

/**
 * The result of a durable local commit (the `mutate(ref, args).local` promise).
 * `id` is the CANONICAL row id this mutation targets — the new row's id for an
 * insert, or the edited/removed row's id otherwise. It equals `row[idField]` and
 * `row._id` on every subsequent read (the engine stamps the idField on inserts;
 * the server re-stamps it on sync; the client keys rows by this same id). So a
 * headless consumer reads it back with no guesswork: `const id = (await
 * engine.mutate(ref, args).local).id`.
 */
export type LocalCommit = {
  readonly opId: string;
  readonly table: TableName;
  readonly id: LocalId;
  readonly committedAt: number;
  /**
   * The resulting row, so a caller can use it directly instead of a readback round-trip:
   *  - INSERT: the optimistic row just written — `value` with `row[idField] === id`,
   *    identical to what a read returns immediately after (and what the server re-stamps
   *    on sync).
   *  - PATCH: the canonical-plus-pending merge AFTER this patch is applied (same as
   *    `getRow(table, id)` right after) — `undefined` only if the row isn't local yet.
   *  - REMOVE: `undefined` — the row is gone.
   *
   * Reading it is local-only (no server pull), since the write already flushes via its
   * background `.server` push.
   */
  readonly row?: Record<string, unknown>;
};

export type MutationStatus = {
  readonly opId: string;
  readonly status: OperationStatus;
  readonly error?: string;
};

/**
 * A single row-level change to the live (canonical + replayed-pending) view of a
 * table, emitted by the engine's delta bus after every commit — local mutation,
 * server-change apply, op-status transition, eviction, or resync. The in-memory
 * table cache, secondary indexes, and every active query view are maintained from
 * these deltas instead of re-reading whole tables. `upsert` carries the new row;
 * `delete` means the row left the visible view (removed or tombstoned).
 */
export type RowDelta =
  | { readonly table: TableName; readonly localId: LocalId; readonly kind: "upsert"; readonly row: RowValue }
  | { readonly table: TableName; readonly localId: LocalId; readonly kind: "delete"; readonly row: null };
