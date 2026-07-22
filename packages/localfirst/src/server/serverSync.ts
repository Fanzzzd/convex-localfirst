import type { ScopeDefinition } from "../core/index.js";
import { applyCounterDelta, applySetDelta, isCounterDelta, isSetDelta } from "../core/internal.js";

/**
 * Pure, runtime-agnostic server sync engine. It enforces scope/ownership,
 * dedupes via the operation ledger, appends to the change log (deletes included),
 * and maintains the id map. The Convex component supplies a ServerStore backed by
 * ctx.db; tests supply an in-memory one. Pull cursors are client-driven (sent in the
 * request, advanced in the response) — the server keeps no per-client cursor state.
 *
 * Security invariants enforced here (the client never decides authorization):
 *  - I7: pull scope and push ownership/membership are derived from the
 *        authenticated userId, never from client-supplied scope/owner values.
 *  - I2: a re-pushed opId is idempotent (ledger lookup short-circuits).
 */

// Merge model: field-scoped patches merge field-by-field on the client
// (view.ts/rebase.ts use {...row, ...patch}) and here via ctx.db.patch, so concurrent
// edits to DIFFERENT fields both survive; same-field collisions resolve by ARRIVAL order.
// Convergent merges are per-field (setFields/counterFields) and never clobber.
export type ServerTableConfig = {
  readonly scope: ScopeDefinition;
  readonly idField: string;
  /** Auto-timestamp field names (lf.table's `timestamps` option); serverWriter stamps them. */
  readonly timestamps?: { readonly createdAt: string; readonly updatedAt: string };
  /** The declared local-first surface (shape + id + timestamps). Snapshot bootstrap
   *  projects app rows to EXACTLY these fields, so server-only `extra` columns never
   *  leak to clients. Absent (hand-written config): bootstrap strips only Convex
   *  system fields. collectTables always fills it. */
  readonly syncedFields?: readonly string[];
  /** Client-callable mutations collected from lf.table(). Query-only tables have
   *  no entries and therefore reject every client write. */
  readonly mutations?: Readonly<
    Record<string, { readonly kind: ServerOperation["kind"]; readonly fields: readonly string[] }>
  >;
  /** Fields minted by serverStamp. They are never accepted from a client. */
  readonly serverOnlyFields?: readonly string[];
  /** Server-minted fields merged into every insert (push AND serverWriter, where
   *  userId is "server") — e.g. an atomic per-project sequence number. Runs inside
   *  the push transaction, so counter reads are race-free under Convex OCC. Stamped
   *  fields must be part of the table's declared shape to sync back to clients, and
   *  may not touch the partition or id field. */
  readonly serverStamp?: (input: {
    userId: string;
    value: Record<string, unknown>;
  }) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
};

export type ServerOperation = {
  readonly opId: string;
  readonly clientId: string;
  readonly schemaVersion: number;
  readonly functionName: string;
  readonly table: string;
  readonly kind: "insert" | "patch" | "delete";
  readonly localId: string;
  readonly value?: Record<string, unknown>;
  readonly patch?: Record<string, unknown>;
  /**
   * Atomic write group (DX v4 §5). ABSENT ⇒ ungrouped ⇒ the exact single-op behavior of
   * every prior release (a 0.3.x client sends none). When present, all ops sharing a
   * `groupId` in one push are validated together (against an in-memory overlay of the
   * group's own effects) and either all applied or all rejected.
   */
  readonly groupId?: string;
  readonly groupSize?: number;
  readonly groupIndex?: number;
};

export type StoredChange = {
  readonly changeId: string;
  readonly scopeKey: string;
  readonly table: string;
  readonly localId: string;
  readonly kind: "insert" | "patch" | "delete";
  readonly data?: Record<string, unknown>;
  readonly patch?: Record<string, unknown>;
  readonly version: number;
  readonly serverTime: number;
  readonly opId?: string;
};

export type LedgerEntry = {
  readonly schemaVersion: number;
  readonly status: "accepted" | "rejected";
  readonly error?: string;
  readonly changes?: readonly StoredChange[];
};

type BoundAccessConfig<Role = unknown, Row extends Record<string, unknown> = Record<string, unknown>> = {
  readonly member: (input: {
    userId: string;
    scopeValue: string;
    table: string;
    membershipTable?: string;
  }, store?: ServerStore) => Role | null | undefined | Promise<Role | null | undefined>;
  readonly read?: (input: { userId: string; role: Role; table: string; row: Row }) => boolean | Promise<boolean>;
  readonly write?: (input: {
    userId: string;
    role: Role;
    table: string;
    action: ServerOperation["kind"];
    before: Row | null;
    patch?: Record<string, unknown>;
    proposed: Row | null;
  }) => boolean | Promise<boolean>;
};

type BoundOnWrite<Row extends Record<string, unknown> = Record<string, unknown>> = (input: {
  table: string;
  action: ServerOperation["kind"];
  before: Row | null;
  after: Row | null;
  userId: string;
  functionName: string;
}) => Promise<void>;

/**
 * Storage contract the sync engine drives. TRANSACTIONAL REQUIREMENT (I2/I5): each push
 * does read-then-write sequences that need transactional isolation —
 *  - idempotency: getLedger → apply → commitOp must be atomic, else concurrent pushes of
 *    the same opId both miss the ledger and double-apply;
 *  - per-row version monotonicity: latestChangeVersion → appendChange(version+1).
 * The Convex adapter gets this free (every method shares the parent mutation's tx + OCC).
 * A CUSTOM ServerStore MUST provide the same per-push isolation or it can race.
 */
export type ServerStore = {
  // Authoritative user-table rows, keyed by serverId.
  getRow(table: string, serverId: string): Promise<Record<string, unknown> | null>;
  insertRow(table: string, data: Record<string, unknown>): Promise<string>;
  patchRow(table: string, serverId: string, patch: Record<string, unknown>): Promise<void>;
  deleteRow(table: string, serverId: string): Promise<void>;

  // Operation ledger (idempotency), keyed by (userId, opId).
  getLedger(userId: string, opId: string): Promise<LedgerEntry | null>;
  /** Atomically append `change` and record the ledger entry. The app-row write,
   *  this call, and its id-map update must share the caller's transaction. */
  commitOp(
    userId: string,
    op: ServerOperation,
    entry: Omit<LedgerEntry, "schemaVersion" | "changes">,
    change?: Omit<StoredChange, "changeId">,
    serverId?: string
  ): Promise<StoredChange | null>;

  // Local id -> server id, keyed by (table, localId) — NOT by user. A
  // workspace/project row is created by one member but patched/deleted by others,
  // so resolution must not be scoped to the creator (membership is enforced
  // separately, in resolveScopeForWrite). localId is a globally-unique client id.
  getServerId(table: string, localId: string): Promise<string | null>;
  putIdMap(userId: string, table: string, localId: string, serverId: string): Promise<void>;

  // Append-only change log. Returns the assigned monotonic changeId. `serverId`
  // (when known) is denormalized onto the row-version entry so snapshot bootstrap
  // can load app rows without a per-row id-map lookup.
  appendChange(change: Omit<StoredChange, "changeId">, serverId?: string): Promise<string>;
  changesAfter(scopeKey: string, cursor: string | null, limit: number): Promise<readonly StoredChange[]>;
  /** Highest change version recorded for a row (0 if none). Row versions live in
   *  the change log, never on the user row, so user schemas stay clean.
   *
   *  CONCURRENCY (I5 monotonicity): handlePush reads this then appendChange writes
   *  `version+1`. In the real Convex adapter both are component calls FROM a mutation,
   *  which share the parent's transaction + OCC — a concurrent push to the same row
   *  invalidates this read and retries, so two writers can't commit a duplicate or
   *  regressing per-row version. (A non-transactional custom/in-memory ServerStore has
   *  no such guarantee; the bundled tests run sequentially so they never race.) */
  latestChangeVersion(table: string, localId: string): Promise<number>;
  /** The scope a row last lived in (from the change log), or null if never seen.
   *  Authorizes an idempotent no-op delete of an already-gone row (whose scope can
   *  no longer come from the row itself) so it can't become a cross-scope oracle. */
  scopeForLocalId(table: string, localId: string): Promise<string | null>;

  // OPTIONAL: snapshot bootstrap + change-log GC support (the bundled component
  // provides all three). Absent, pull always replays full history and the log is
  // never GC'd — correct, just unbounded.
  /** Oldest / newest RETAINED changeId for a scope (null when the log is empty). */
  firstChangeId?(scopeKey: string): Promise<string | null>;
  lastChangeId?(scopeKey: string): Promise<string | null>;
  /** Page of per-row versions for a scope, ordered by rowKey (`table:localId`),
   *  strictly after `afterRowKey`. Drives snapshot bootstrap: each entry resolves
   *  to the CURRENT app row (deleted rows resolve to nothing and are skipped). */
  rowVersionsByScope?(
    scopeKey: string,
    afterRowKey: string | null,
    limit: number
  ): Promise<ReadonlyArray<{ table: string; localId: string; version: number; rowKey: string; serverId?: string | null }>>;

};

export type PushOp = ServerOperation;

export type PushInput = {
  readonly userId: string;
  readonly clientId: string;
  readonly schemaVersion: number;
  readonly mutations: readonly PushOp[];
};

export type PushResult = {
  readonly accepted: Array<{ opId: string; serverResult?: unknown }>;
  readonly rejected: Array<{ opId: string; message: string }>;
  readonly idMaps: Array<{ table: string; localId: string; serverId: string }>;
  readonly changes: StoredChange[];
  readonly serverTime: number;
  readonly schemaMismatch?: boolean;
};

export type PullScope = { readonly kind: ScopeDefinition["kind"]; readonly value?: string };

export type PullInput = {
  readonly userId: string;
  readonly clientId: string;
  readonly schemaVersion: number;
  readonly scopes: readonly PullScope[];
  readonly cursors: Record<string, string | null>;
  /** Mid-bootstrap continuation tokens (echoed from a prior PullResult). Opaque. */
  readonly bootstrapCursors?: Record<string, string>;
  /** True for the reactive watch subscription: the result is a content-free
   *  doorbell, so the expensive bootstrap path is skipped and pages stay tiny. */
  readonly doorbell?: boolean;
};

export type PullResult = {
  readonly changes: StoredChange[];
  readonly cursors: Record<string, string>;
  readonly serverTime: number;
  readonly schemaMismatch?: boolean;
  /** Per-scope: true when this page hit the pull limit, so more changes remain. */
  readonly hasMore: Record<string, boolean>;
  /** Scopes whose changes in THIS response are snapshot-bootstrap pages (cold
   *  client, or a cursor that fell behind the GC horizon). When such a scope
   *  completes (its cursor is delivered and it is absent from bootstrapCursors),
   *  the client evicts canonical rows the snapshot did not contain — ghost rows
   *  whose delete changes were pruned. No upfront clear: the local cache stays
   *  fully readable throughout, and an aborted bootstrap changes nothing. */
  readonly snapshotScopes: string[];
  /** Per-scope bootstrap continuation; pass back via PullInput.bootstrapCursors.
   *  A scope absent here (with hasMore false) has finished bootstrapping. */
  readonly bootstrapCursors: Record<string, string>;
  /** Requested scopes the caller is NOT a member of (revoked or never granted).
   *  The client evicts the scope's rows and forgets its cursor: after a
   *  revocation, data leaves the device on the next sync. */
  readonly deniedScopes: string[];
  /** Per membership scope: the role `access.member` resolved for the caller (DX v4 §6),
   *  so the client can mirror access rules in the UI (useRole/useCan). Only membership
   *  scopes appear (byUser has no role). ADDITIVE — a 0.3.x client ignores the field. */
  readonly roles: Record<string, unknown>;
};

/**
 * Codec for serializing local-first row values to/from the JSON-string columns in
 * the component. The default is plain JSON (fine for tests + JSON-only values); the
 * Convex adapter injects one built on convexToJson/jsonToConvex so synced rows can
 * carry the FULL Convex value range (bigint, bytes, nested undefined) losslessly
 * rather than throwing (bigint) or silently changing shape.
 */
export type ValueCodec = {
  encode(value: unknown): string;
  decode(json: string): unknown;
};

export const JSON_VALUE_CODEC: ValueCodec = {
  encode: (value) => JSON.stringify(value ?? null),
  decode: (json) => JSON.parse(json)
};

export type SyncConfig = {
  readonly schemaVersion: number;
  readonly tables: Record<string, ServerTableConfig>;
  readonly now?: () => number;
  readonly pullLimit?: number;
  readonly valueCodec?: ValueCodec;
  readonly access?: BoundAccessConfig;
  readonly onWrite?: BoundOnWrite;
};

class RejectOp extends Error {}

const onWriteDepth = new WeakMap<object, number>();
const MAX_ON_WRITE_DEPTH = 8;

async function runOnWrite(
  config: SyncConfig,
  table: string,
  input: Parameters<BoundOnWrite>[0]
): Promise<void> {
  if (!config.onWrite) return;
  // configFor creates a fresh config/server store when onWrite calls serverWriter,
  // but the table's scope definition is shared across that chain and is therefore
  // the smallest stable recursion key available inside this runtime-agnostic file.
  const key = config.tables[table]?.scope ?? config;
  const depth = onWriteDepth.get(key) ?? 0;
  if (depth >= MAX_ON_WRITE_DEPTH) {
    throw new Error(
      `convex-localfirst: onWrite recursion exceeded ${MAX_ON_WRITE_DEPTH} nested writes for table "${table}". Do not write back to the same local-first table unconditionally from onWrite.`
    );
  }
  onWriteDepth.set(key, depth + 1);
  try {
    await config.onWrite(input);
  } finally {
    if (depth === 0) onWriteDepth.delete(key);
    else onWriteDepth.set(key, depth);
  }
}

export function scopeKeyForUser(userId: string): string {
  return `u:${userId}`;
}
export function scopeKeyForValue(kind: string, value: string): string {
  return `${kind}:${value}`;
}

/** The field that decides a row's partition. A write must never change it (a row
 * cannot move scopes), otherwise membership — checked against the row's CURRENT
 * scope — would be bypassed (I7). */
function partitionFieldOf(scope: ServerTableConfig["scope"]): string | null {
  if (scope.kind === "byUser") return scope.field;
  if (scope.kind === "byWorkspace") return scope.workspaceIdField;
  if (scope.kind === "byProject") return scope.projectIdField;
  return null;
}

type MemberCache = Map<string, Promise<unknown | null>>;

async function memberRole(
  store: ServerStore,
  config: SyncConfig,
  cache: MemberCache,
  userId: string,
  kind: "byWorkspace" | "byProject",
  scopeValue: string,
  table: string,
  membershipTable: string
): Promise<unknown | null> {
  if (!config.access) {
    throw new Error("serverSync: membership scopes require access.member");
  }
  const key = scopeKeyForValue(kind, scopeValue);
  let pending = cache.get(key);
  if (!pending) {
    pending = Promise.resolve(
      config.access.member({ userId, scopeValue, table, membershipTable }, store)
    ).then((role) => role ?? null);
    cache.set(key, pending);
  }
  return await pending;
}

/**
 * Resolve the scope key for an op, enforcing ownership/membership against the
 * authenticated userId. CRUCIAL (I7): for a patch/delete the scope is derived
 * from the EXISTING SERVER ROW, never from client-supplied `op.value` — otherwise
 * a client could name a scope it belongs to and so authorize a write to a row in
 * a scope it does not. Only an insert declares its own scope (and membership on
 * that claimed value is checked).
 */
async function resolveScopeForWrite(
  store: ServerStore,
  syncConfig: SyncConfig,
  tableConfig: ServerTableConfig,
  memberCache: MemberCache,
  userId: string,
  op: ServerOperation
): Promise<{
  scopeKey: string;
  value: Record<string, unknown>;
  before: Record<string, unknown> | null;
  role: unknown | null;
}> {
  const scope = tableConfig.scope;
  const value = { ...(op.value ?? {}) };

  if (scope.kind === "byUser") {
    if (op.kind === "insert") {
      // Ignore any client-supplied owner: ownership is the authenticated user.
      value[scope.field] = userId;
      return { scopeKey: scopeKeyForUser(userId), value, before: null, role: null };
    }
    // patch/delete: the row must exist AND be owned by this user. The id map is
    // global (by table+localId), so without this check a user who guesses another
    // user's localId could write their row.
    const existing = await loadRow(store, op);
    if (existing[scope.field] !== userId) {
      throw new RejectOp("Not the owner of this row");
    }
    return { scopeKey: scopeKeyForUser(userId), value, before: existing, role: null };
  }

  if (scope.kind === "byWorkspace" || scope.kind === "byProject") {
    const field = scope.kind === "byWorkspace" ? scope.workspaceIdField : scope.projectIdField;
    let scopeValue: string | null;
    let before: Record<string, unknown> | null = null;
    if (op.kind === "insert") {
      // An insert declares the scope it targets; membership on it is checked below.
      scopeValue = typeof value[field] === "string" ? String(value[field]) : null;
    } else {
      // patch/delete: scope comes from the existing row, NEVER from op.value.
      before = await loadRow(store, op);
      scopeValue = typeof before[field] === "string" ? String(before[field]) : null;
    }
    if (!scopeValue) {
      throw new RejectOp(`Missing ${field} for scoped write`);
    }
    const role = await memberRole(store, syncConfig, memberCache, userId, scope.kind, scopeValue, op.table, scope.membershipTable);
    if (role === null) {
      throw new RejectOp("Not a member of the target scope");
    }
    return { scopeKey: scopeKeyForValue(scope.kind, scopeValue), value, before, role };
  }

  throw new RejectOp("Custom scopes require a server resolver");
}

/** True if `userId` may write rows in `scopeKey`. The boolean core of scope
 *  authorization — the caller decides whether to throw and with what message, so a
 *  delete can reject every denial (missing/foreign/gone) with ONE generic message
 *  and avoid leaking which case it was (an existence/ownership oracle, I7). */
async function isAuthorizedForScope(
  store: ServerStore,
  syncConfig: SyncConfig,
  memberCache: MemberCache,
  table: string,
  tableConfig: ServerTableConfig,
  userId: string,
  scopeKey: string
): Promise<{ authorized: boolean; role: unknown | null }> {
  const scope = tableConfig.scope;
  if (scope.kind === "byUser") {
    return { authorized: scopeKey === scopeKeyForUser(userId), role: null };
  }
  if (scope.kind === "byWorkspace" || scope.kind === "byProject") {
    const value = scopeKey.slice(scopeKey.indexOf(":") + 1);
    const role = await memberRole(store, syncConfig, memberCache, userId, scope.kind, value, table, scope.membershipTable);
    return { authorized: role !== null, role };
  }
  return { authorized: false, role: null }; // defensive: fail closed
}

/** The scopeKey a stored row belongs to, from its partition field (the inverse of
 *  resolveScopeForWrite). Returns null if the row lacks a usable partition value. */
function scopeKeyForRow(config: ServerTableConfig, row: Record<string, unknown>): string | null {
  const scope = config.scope;
  if (scope.kind === "byUser") {
    const owner = row[scope.field];
    return typeof owner === "string" ? scopeKeyForUser(owner) : null;
  }
  if (scope.kind === "byWorkspace" || scope.kind === "byProject") {
    const field = scope.kind === "byWorkspace" ? scope.workspaceIdField : scope.projectIdField;
    const value = row[field];
    return typeof value === "string" ? scopeKeyForValue(scope.kind, value) : null;
  }
  return null;
}

/**
 * True if `userId` may perform a server-assisted patch of an EXISTING row (the
 * attachment getUploadUrl/finalize path). Reuses the SAME authorization as a client
 * patch: ownership for byUser, membership + `access.write` for workspace/project —
 * so attachments never open a second, weaker authz path. Returns false (never throws)
 * when the row is missing, foreign, or the write hook denies it.
 */
export async function authorizeRowWrite(
  store: ServerStore,
  config: SyncConfig,
  userId: string,
  table: string,
  localId: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  const tableConfig = config.tables[table];
  if (!tableConfig) return false;
  const op: ServerOperation = {
    opId: "",
    clientId: "",
    schemaVersion: config.schemaVersion,
    functionName: "",
    table,
    kind: "patch",
    localId,
    patch
  };
  let resolved: { before: Record<string, unknown> | null; role: unknown | null };
  try {
    // Enforces ownership (byUser) or membership (workspace/project) against the
    // CURRENT server row — and rejects a missing row.
    resolved = await resolveScopeForWrite(store, config, tableConfig, new Map(), userId, op);
  } catch {
    return false;
  }
  if (tableConfig.scope.kind === "byUser") return true; // ownership already enforced
  if (!config.access?.write) return true; // member, no row-level write hook
  return await config.access.write({
    userId,
    role: resolved.role,
    table,
    action: "patch",
    before: resolved.before,
    patch,
    proposed: { ...(resolved.before ?? {}), ...patch }
  });
}

/** Load the existing server row for a non-insert op, or reject if it's gone. */
async function loadRow(store: ServerStore, op: ServerOperation): Promise<Record<string, unknown>> {
  const serverId = await store.getServerId(op.table, op.localId);
  const row = serverId ? await store.getRow(op.table, serverId) : null;
  if (!row) {
    throw new RejectOp(`No server row for ${op.table}:${op.localId}`);
  }
  return row;
}

export async function handlePush(store: ServerStore, config: SyncConfig, input: PushInput): Promise<PushResult> {
  const now = config.now ?? (() => Date.now());
  const serverTime = now();
  const result: PushResult = { accepted: [], rejected: [], idMaps: [], changes: [], serverTime };
  const memberCache: MemberCache = new Map();

  if (input.schemaVersion !== config.schemaVersion) {
    return { ...result, schemaMismatch: true };
  }

  // Partition into ordered segments: each ungrouped op is its own segment; ops sharing a
  // groupId form one group segment (gathered in first-appearance order — the client sends
  // them contiguously anyway). Ungrouped ops process exactly as every prior release did.
  const segments: Array<{ kind: "single"; op: ServerOperation } | { kind: "group"; ops: ServerOperation[] }> = [];
  const groupIndex = new Map<string, number>();
  for (const op of input.mutations) {
    if (op.groupId === undefined) {
      segments.push({ kind: "single", op });
      continue;
    }
    const at = groupIndex.get(op.groupId);
    if (at === undefined) {
      groupIndex.set(op.groupId, segments.length);
      segments.push({ kind: "group", ops: [op] });
    } else {
      (segments[at] as { kind: "group"; ops: ServerOperation[] }).ops.push(op);
    }
  }

  for (const segment of segments) {
    if (segment.kind === "single") {
      await processPushOp(store, config, memberCache, input, segment.op, serverTime, result);
    } else {
      await processPushGroup(store, config, memberCache, input, segment.ops, serverTime, result);
    }
  }

  return result;
}

/** Ledger replay for a known opId (shared by the single-op and group paths). Returns true
 *  when the op was decided previously and this call re-emitted its stored outcome. */
async function replayFromLedger(
  store: ServerStore,
  input: PushInput,
  op: ServerOperation,
  prior: LedgerEntry,
  result: PushResult
): Promise<void> {
  if (prior.schemaVersion !== input.schemaVersion) {
    result.rejected.push({ opId: op.opId, message: "schemaMismatch" });
    return;
  }
  if (prior.status === "accepted") {
    result.accepted.push({ opId: op.opId });
    // Re-deliver the confirming change so a replayed (already-committed) op can leave
    // _pending even if its original ack was lost. The client version-checks it, so
    // re-applying a now-stale change is ignored — never a regression.
    if (prior.changes) result.changes.push(...prior.changes);
  } else {
    result.rejected.push({ opId: op.opId, message: prior.error ?? "rejected" });
  }
}

/** Process one ungrouped op: idempotency replay, per-op schema/table gates, then
 *  validate + apply + commit. This is the historical per-op body, unchanged. */
async function processPushOp(
  store: ServerStore,
  config: SyncConfig,
  memberCache: MemberCache,
  input: PushInput,
  op: ServerOperation,
  serverTime: number,
  result: PushResult
): Promise<void> {
  // I2: idempotency — a known opId is never re-applied (keyed by (userId, opId) so a
  // reload/new-tab replay under a different envelope clientId is still deduped).
  const prior = await store.getLedger(input.userId, op.opId);
  if (prior) {
    await replayFromLedger(store, input, op, prior, result);
    return;
  }

  // I8: an op carries the schema it was BUILT under. The envelope already matches the
  // server (checked above), so a per-op mismatch means a stale offline op queued before
  // a client schema upgrade. Applying it under the new schema can silently corrupt
  // (changed field meaning, new required field). Reject it loudly — the client must
  // migrate queued ops before pushing — rather than commit semantically stale data.
  if (op.schemaVersion !== input.schemaVersion) {
    const message = `Operation ${op.opId} was created under schema v${op.schemaVersion} but the client now declares v${input.schemaVersion}; migrate queued operations before pushing.`;
    result.rejected.push({ opId: op.opId, message });
    await store.commitOp(input.userId, op, { status: "rejected", error: message });
    return;
  }

  const tableConfig = config.tables[op.table];
  if (!tableConfig) {
    const message = "unknownFunction";
    result.rejected.push({ opId: op.opId, message });
    await store.commitOp(input.userId, op, { status: "rejected", error: message });
    return;
  }

  try {
    validateDeclaredMutation(tableConfig, op);
    const applied = await applyOp(store, config, tableConfig, memberCache, input.userId, op, serverTime);
    await runOnWrite(config, op.table, {
      table: op.table,
      action: op.kind,
      before: applied.before,
      after: applied.after,
      userId: input.userId,
      functionName: op.functionName
    });
    // change === null is an idempotent no-op delete (row already gone): still ack it
    // so the client stops retrying, and ledger it for opId idempotency. Do NOT echo
    // serverId on a no-op — the row is gone, so its internal id must not leak.
    const serverResult =
      applied.change === null
        ? { ok: true, localId: op.localId, noop: true }
        : { ok: true, localId: op.localId, serverId: applied.serverId };
    const change = await store.commitOp(
      input.userId,
      op,
      { status: "accepted" },
      applied.change ?? undefined,
      applied.serverId
    );
    if (change) result.changes.push(change);
    if (op.kind === "insert" && applied.serverId) {
      result.idMaps.push({ table: op.table, localId: op.localId, serverId: applied.serverId });
    }
    result.accepted.push({ opId: op.opId, serverResult });
  } catch (error) {
    // Only validation/authorization failures are downgraded to per-op
    // rejections. Anything else may have followed a row write or onWrite side
    // effect, so rethrowing aborts the whole transaction.
    if (!(error instanceof RejectOp)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await store.commitOp(input.userId, op, { status: "rejected", error: message });
    result.rejected.push({ opId: op.opId, message });
  }
}

/**
 * Apply an atomic write group (DX v4 §5). Either every member op commits or none does,
 * with one rejection entry per op on failure. The group is validated FIRST against an
 * in-memory overlay of its own in-group effects (a later patch sees an earlier insert)
 * WITHOUT touching the db; only when all pass are the ops applied for real, in order.
 * commitOp per op shares the caller's transaction, so the group commits all-or-nothing.
 */
async function processPushGroup(
  store: ServerStore,
  config: SyncConfig,
  memberCache: MemberCache,
  input: PushInput,
  ops: readonly ServerOperation[],
  serverTime: number,
  result: PushResult
): Promise<void> {
  // Idempotency: a decided group has a ledger entry for EVERY member (commitOp per op
  // shares one transaction, so it is all-committed or none). Replaying any subset re-emits
  // each member's stored outcome — accepted re-acks with its change, rejected re-rejects.
  const priors = await Promise.all(ops.map((op) => store.getLedger(input.userId, op.opId)));
  if (priors.some((prior) => prior !== null)) {
    for (let i = 0; i < ops.length; i++) {
      const prior = priors[i];
      if (prior) {
        await replayFromLedger(store, input, ops[i]!, prior, result);
      } else {
        // Defensive: a decided group missing a member (should be unreachable given
        // transactional commit). Reject it so the client surfaces it rather than
        // silently landing a partial group.
        const message = "groupReplayIncomplete";
        result.rejected.push({ opId: ops[i]!.opId, message });
        await store.commitOp(input.userId, ops[i]!, { status: "rejected", error: message });
      }
    }
    return;
  }

  const rejectWholeGroup = async (reason: string): Promise<void> => {
    // Zero side effects: ledger each member rejected (so a replay re-rejects) and emit one
    // rejection entry per op. No row/onWrite/change writes happened.
    for (const op of ops) {
      result.rejected.push({ opId: op.opId, message: reason });
      await store.commitOp(input.userId, op, { status: "rejected", error: reason });
    }
  };

  // Pre-checks that don't need the overlay: a per-op schema/table failure fails the WHOLE
  // group (all-or-nothing), mirroring how the validation pass treats any single failure.
  for (const op of ops) {
    if (op.schemaVersion !== input.schemaVersion) {
      await rejectWholeGroup(
        `groupRejected: Operation ${op.opId} was created under schema v${op.schemaVersion} but the client now declares v${input.schemaVersion}; migrate queued operations before pushing.`
      );
      return;
    }
    if (!config.tables[op.table]) {
      await rejectWholeGroup("groupRejected: unknownFunction");
      return;
    }
  }

  // Validation pass: run each op through applyOp against an OVERLAY store, in order, so a
  // later patch/delete sees an earlier insert's simulated row. Writes hit only the overlay
  // — the real db is untouched — so a failing group leaves zero side effects. serverStamp
  // is skipped here (server-only fields don't affect authz; the real mint runs in the
  // apply pass), avoiding a double mint of sequence numbers.
  const overlay = createOverlayStore(store);
  let failReason: string | null = null;
  for (const op of ops) {
    const tableConfig = config.tables[op.table]!;
    try {
      validateDeclaredMutation(tableConfig, op);
      await applyOp(overlay, config, { ...tableConfig, serverStamp: undefined }, memberCache, input.userId, op, serverTime);
    } catch (error) {
      if (!(error instanceof RejectOp)) throw error; // a real error aborts the whole push
      failReason = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  if (failReason !== null) {
    await rejectWholeGroup(`groupRejected: ${failReason}`);
    return;
  }

  // Apply pass: all validated — commit each op for real, in order. Each op sees prior
  // members' real writes (they are committed before it runs), so no overlay is needed.
  for (const op of ops) {
    const tableConfig = config.tables[op.table]!;
    const applied = await applyOp(store, config, tableConfig, memberCache, input.userId, op, serverTime);
    await runOnWrite(config, op.table, {
      table: op.table,
      action: op.kind,
      before: applied.before,
      after: applied.after,
      userId: input.userId,
      functionName: op.functionName
    });
    const serverResult =
      applied.change === null
        ? { ok: true, localId: op.localId, noop: true }
        : { ok: true, localId: op.localId, serverId: applied.serverId };
    const change = await store.commitOp(input.userId, op, { status: "accepted" }, applied.change ?? undefined, applied.serverId);
    if (change) result.changes.push(change);
    if (op.kind === "insert" && applied.serverId) {
      result.idMaps.push({ table: op.table, localId: op.localId, serverId: applied.serverId });
    }
    result.accepted.push({ opId: op.opId, serverResult });
  }
}

/**
 * An in-memory overlay over a real ServerStore for the group validation pass. Reads layer
 * the overlay on top of the real store; writes (insert/patch/delete/id-map) mutate ONLY
 * the overlay, so validating a group never touches the db. Every OTHER member (versions,
 * scope, and any extra field an access.member hook reads off a custom store) falls through
 * to the REAL store via a Proxy; commitOp/appendChange are never reached during validation.
 */
function createOverlayStore(real: ServerStore): ServerStore {
  const rows = new Map<string, Record<string, unknown> | null>(); // null = simulated delete
  const ids = new Map<string, string>();
  let serverIdSeq = 0;
  const rowKey = (table: string, serverId: string) => `${table} ${serverId}`;
  const idKey = (table: string, localId: string) => `${table} ${localId}`;
  const overrides: Partial<ServerStore> = {
    async getRow(table, serverId) {
      const key = rowKey(table, serverId);
      if (rows.has(key)) return rows.get(key) ?? null;
      return await real.getRow(table, serverId);
    },
    async insertRow(table, data) {
      const serverId = `ovl_${++serverIdSeq}`;
      rows.set(rowKey(table, serverId), { ...data });
      return serverId;
    },
    async patchRow(table, serverId, patch) {
      const key = rowKey(table, serverId);
      const current = rows.has(key) ? rows.get(key) : await real.getRow(table, serverId);
      rows.set(key, { ...(current ?? {}), ...patch });
    },
    async deleteRow(table, serverId) {
      rows.set(rowKey(table, serverId), null);
    },
    async getServerId(table, localId) {
      const key = idKey(table, localId);
      if (ids.has(key)) return ids.get(key) ?? null;
      return await real.getServerId(table, localId);
    },
    async putIdMap(_userId, table, localId, serverId) {
      ids.set(idKey(table, localId), serverId);
    }
  };
  // Every other member (versions/scope, and any extra field an access.member hook reads
  // off a custom store) falls through to the REAL store, so authorization sees real data.
  return new Proxy(real as object, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return (overrides as Record<string, unknown>)[prop];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as ServerStore;
}

function validateDeclaredMutation(table: ServerTableConfig, op: ServerOperation): void {
  const mutation = table.mutations?.[op.functionName];
  if (!mutation || mutation.kind !== op.kind) {
    throw new RejectOp("unknownFunction");
  }
  if (op.kind === "delete") return;
  const payload = op.kind === "insert" ? op.value : op.patch;
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    throw new RejectOp("invalidPayload");
  }
  if (op.kind === "patch") {
    for (const field of [partitionFieldOf(table.scope), table.idField]) {
      if (field && Object.prototype.hasOwnProperty.call(payload ?? {}, field)) {
        throw new RejectOp(`Cannot patch the ${field === table.idField ? "id" : "scope"} field "${field}"`);
      }
    }
  }
  const allowed = new Set(mutation.fields);
  const serverOnly = new Set(table.serverOnlyFields ?? []);
  for (const field of Object.keys(payload ?? {})) {
    if (serverOnly.has(field)) throw new RejectOp("serverOnlyField");
    if (!allowed.has(field)) throw new RejectOp("unknownField");
  }
}

type AppliedOp = {
  readonly change: Omit<StoredChange, "changeId"> | null;
  readonly serverId?: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
};

async function applyOp(
  store: ServerStore,
  syncConfig: SyncConfig,
  tableConfig: ServerTableConfig,
  memberCache: MemberCache,
  userId: string,
  op: ServerOperation,
  serverTime: number
): Promise<AppliedOp> {
  // Delete is fully handled here so EVERY denial — never-seen localId, foreign live
  // row, foreign already-deleted row — rejects with ONE generic message. Splitting
  // them ("No server row" vs "Not the owner") would be an existence/ownership oracle
  // (I7). Authorize against the row's scope: the live row's partition field if it
  // still exists, else the scope it last lived in (the append-only change log).
  if (op.kind === "delete") {
    const existingId = await store.getServerId(op.table, op.localId);
    const existingRow = existingId ? await store.getRow(op.table, existingId) : null;
    const scopeKey = existingRow
      ? scopeKeyForRow(tableConfig, existingRow)
      : await store.scopeForLocalId(op.table, op.localId);
    if (scopeKey === null) {
      throw new RejectOp(`Cannot delete ${op.table}:${op.localId}`);
    }
    const access = await isAuthorizedForScope(store, syncConfig, memberCache, op.table, tableConfig, userId, scopeKey);
    if (!access.authorized) {
      throw new RejectOp(`Cannot delete ${op.table}:${op.localId}`);
    }
    if (
      tableConfig.scope.kind !== "byUser" &&
      syncConfig.access?.write &&
      !(await syncConfig.access.write({
        userId,
        role: access.role,
        table: op.table,
        action: "delete",
        before: existingRow,
        proposed: null
      }))
    ) {
      throw new RejectOp(`Cannot delete ${op.table}:${op.localId}`);
    }
    // Deletes commute: an authorized delete of an already-gone row acks as a no-op
    // (the EXPECTED case for an insert-only log with compaction, where two clients
    // can concurrently prune the same subsumed rows, and for any replayed delete).
    if (!existingRow) {
      return { change: null, before: null, after: null };
    }
    const version = (await store.latestChangeVersion(op.table, op.localId)) + 1;
    await store.deleteRow(op.table, existingId as string);
    return {
      change: { scopeKey, table: op.table, localId: op.localId, kind: "delete", version, serverTime, opId: op.opId },
      serverId: existingId as string,
      before: existingRow,
      after: null
    };
  }

  let scopeKey: string;
  let value: Record<string, unknown>;
  let before: Record<string, unknown> | null;
  let role: unknown | null;
  try {
    ({ scopeKey, value, before, role } = await resolveScopeForWrite(
      store,
      syncConfig,
      tableConfig,
      memberCache,
      userId,
      op
    ));
  } catch (error) {
    // A patch's denials (never-seen "No server row", foreign owner/member) would be
    // an existence/ownership oracle — collapse them ALL into one generic message
    // (mirrors delete). Insert has no such oracle (its row does not exist yet), so
    // its messages pass through unchanged.
    if (op.kind === "patch" && error instanceof RejectOp) {
      throw new RejectOp(`Cannot patch ${op.table}:${op.localId}`);
    }
    throw error;
  }

  if (op.kind === "insert") {
    // Record the client's stable local id under the table's idField so the row
    // satisfies the app schema and can be correlated back to the client.
    value[tableConfig.idField] = op.localId;
    // A re-push of the SAME op is short-circuited by the ledger before applyOp, so
    // reaching here with an existing (table, localId) means either (a) a DIFFERENT op
    // reused a LIVE localId — a collision, rejected — or (b) the id-map entry points at a
    // now-DELETED row (no current row). Case (b) is a RESURRECTION: undo-of-delete
    // re-inserts the same localId. Allow it — a fresh server row is minted below, the id
    // map is repointed, and the change version continues from latestChangeVersion (so it is
    // strictly greater than the delete's version and pulls order correctly). Any
    // serverStamp/server-only field is re-minted fresh (the client strips the stale value).
    const existingServerId = await store.getServerId(op.table, op.localId);
    if (existingServerId && (await store.getRow(op.table, existingServerId))) {
      throw new RejectOp(`Duplicate localId for ${op.table}:${op.localId}`);
    }
    if (
      tableConfig.scope.kind !== "byUser" &&
      syncConfig.access?.write &&
      !(await syncConfig.access.write({
        userId,
        role,
        table: op.table,
        action: "insert",
        before: null,
        proposed: value
      }))
    ) {
      throw new RejectOp(`Cannot insert ${op.table}:${op.localId}`);
    }
    // After the dup check so a rejected insert never burns a minted sequence number.
    mergeServerStamp(value, await tableConfig.serverStamp?.({ userId, value }), tableConfig);
    const serverId = await store.insertRow(op.table, value);
    await store.putIdMap(userId, op.table, op.localId, serverId);
    // First change for a fresh row is version 1 (I5 monotonicity).
    const version = (await store.latestChangeVersion(op.table, op.localId)) + 1;
    return {
      change: {
        scopeKey,
        table: op.table,
        localId: op.localId,
        kind: "insert",
        data: projectSyncedFields(value, tableConfig),
        version,
        serverTime,
        opId: op.opId
      },
      serverId,
      before: null,
      after: value
    };
  }

  const serverId = await store.getServerId(op.table, op.localId);
  if (!serverId) {
    // Only patch reaches here (delete/insert returned above), and resolveScopeForWrite
    // already loaded the row — so this is a defensive guard; keep it generic (no oracle).
    throw new RejectOp(`Cannot patch ${op.table}:${op.localId}`);
  }
  // Row version is derived from the append-only change log — the single source of
  // truth — never written onto the user row (which has no `_version` column).
  const version = (await store.latestChangeVersion(op.table, op.localId)) + 1;

  if (op.kind === "patch") {
    // I7 defense-in-depth: a patch must never move a row across scopes or rewrite
    // its id. Membership was checked against the row's CURRENT scope; letting the
    // patch change the partition field (workspaceId/ownerId/projectId) or idField
    // would bypass that check and corrupt the change log's scope key.
    let patch = op.patch ?? {};
    const guarded = partitionFieldOf(tableConfig.scope);
    for (const field of [guarded, tableConfig.idField]) {
      if (field && Object.prototype.hasOwnProperty.call(patch, field)) {
        throw new RejectOp(`Cannot patch the ${field === tableConfig.idField ? "id" : "scope"} field "${field}"`);
      }
    }
    // Set/counter-field merge: a patch field carrying a SetDelta or CounterDelta is
    // materialized against the CURRENT row → a plain array/number, so concurrent edits from
    // other clients merge (not last-writer-wins clobber) and the change log + pull stay
    // delta-free (clients pull concrete values). Shape-driven (the delta is self-describing),
    // so no per-table server config; only loads the row when a delta is actually present
    // (zero overhead otherwise). A delta over a wrong-typed field is a client bug/forge — reject.
    const deltaFields = new Set(
      Object.keys(patch).filter((f) => isSetDelta(patch[f]) || isCounterDelta(patch[f]))
    );
    if (deltaFields.size > 0) {
      const current = before ?? (await loadRow(store, op));
      const materialized: Record<string, unknown> = { ...patch };
      for (const [field, value] of Object.entries(patch)) {
        if (isSetDelta(value)) {
          if (current[field] !== undefined && !Array.isArray(current[field])) {
            throw new RejectOp(`Set delta on non-array field "${field}" of ${op.table}:${op.localId}`);
          }
          materialized[field] = applySetDelta(current[field], value.__lfSet);
        } else if (isCounterDelta(value)) {
          if (current[field] !== undefined && typeof current[field] !== "number") {
            throw new RejectOp(`Counter delta on non-number field "${field}" of ${op.table}:${op.localId}`);
          }
          materialized[field] = applyCounterDelta(current[field], value.__lfCounter);
        }
      }
      patch = materialized;
    }
    const proposed = { ...(before ?? {}), ...patch };
    if (
      tableConfig.scope.kind !== "byUser" &&
      syncConfig.access?.write &&
      !(await syncConfig.access.write({
        userId,
        role,
        table: op.table,
        action: "patch",
        before,
        patch,
        proposed
      }))
    ) {
      throw new RejectOp(`Cannot patch ${op.table}:${op.localId}`);
    }
    // An empty patch is an ACCEPTED no-op (like an already-gone delete): skip the write so
    // it never appends a spurious empty change, consumes a version, or gets re-delivered to
    // every puller. Do NOT leak the serverId (handlePush noop path).
    if (Object.keys(patch).length === 0) {
      return { change: null, serverId, before, after: before };
    }
    await store.patchRow(op.table, serverId, patch);
    return {
      change: {
        scopeKey,
        table: op.table,
        localId: op.localId,
        kind: "patch",
        patch: projectSyncedFields(patch, tableConfig),
        version,
        serverTime,
        opId: op.opId
      },
      serverId,
      before,
      after: proposed
    };
  }

  // insert/patch return above; delete is fully handled at the top. This is
  // unreachable for the three known kinds — guard any future kind explicitly.
  throw new RejectOp(`Unsupported op kind for ${op.table}:${op.localId}`);
}

/** Merge serverStamp output into an insert value. The stamp must never rewrite the
 *  partition or id field — that would bypass the scope checks already performed. */
function mergeServerStamp(
  value: Record<string, unknown>,
  stamped: Record<string, unknown> | undefined,
  tableConfig: ServerTableConfig
): void {
  if (!stamped) return;
  const declared = new Set(tableConfig.serverOnlyFields ?? []);
  for (const field of Object.keys(stamped)) {
    if (!declared.has(field)) {
      throw new Error(`serverStamp produced undeclared server-only field "${field}"`);
    }
  }
  for (const field of [partitionFieldOf(tableConfig.scope), tableConfig.idField]) {
    if (field && Object.prototype.hasOwnProperty.call(stamped, field)) {
      throw new Error(`serverStamp must not set the ${field === tableConfig.idField ? "id" : "scope"} field "${field}"`);
    }
  }
  Object.assign(value, stamped);
}

// ---- Server-authored writes ------------------------------------------------
// Ordinary Convex code (activity fan-out, notifications, importers, crons, HTTP
// endpoints) cannot call the client mutations (their handlers refuse) and must not
// write local-first tables via ctx.db directly (the change log would never see the
// write, so no client would sync it). This is the missing third writer: it applies
// a TRUSTED server-side write through the same row + id-map + change-log path the
// push endpoint uses, so every client pulls it like any other change. No ledger —
// server code is not a flaky network client; Convex OCC retries keep it atomic.

export type ServerWrite =
  | { readonly kind: "insert"; readonly table: string; readonly localId?: string; readonly value: Record<string, unknown> }
  | { readonly kind: "patch"; readonly table: string; readonly localId: string; readonly patch: Record<string, unknown> }
  | { readonly kind: "delete"; readonly table: string; readonly localId: string };

export type ServerWriteResult = { readonly localId: string; readonly serverId?: string };

export async function applyServerWrite(
  store: ServerStore,
  config: SyncConfig,
  write: ServerWrite,
  newLocalId: () => string,
  actingUserId = "server"
): Promise<ServerWriteResult> {
  const tableConfig = config.tables[write.table];
  if (!tableConfig) {
    throw new Error(`serverWriter: unknown local-first table "${write.table}"`);
  }
  const now = config.now ?? (() => Date.now());
  const serverTime = now();
  const partition = partitionFieldOf(tableConfig.scope);
  const ts = tableConfig.timestamps;

  if (write.kind === "insert") {
    const localId = write.localId ?? newLocalId();
    const value = { ...write.value, [tableConfig.idField]: localId };
    if (ts) {
      value[ts.createdAt] ??= serverTime;
      value[ts.updatedAt] ??= serverTime;
    }
    mergeServerStamp(value, await tableConfig.serverStamp?.({ userId: actingUserId, value }), tableConfig);
    const scopeValue = partition ? value[partition] : null;
    if (typeof scopeValue !== "string") {
      throw new Error(`serverWriter: insert into "${write.table}" is missing its scope field "${partition}"`);
    }
    const scopeKey =
      tableConfig.scope.kind === "byUser" ? scopeKeyForUser(scopeValue) : scopeKeyForValue(tableConfig.scope.kind, scopeValue);
    // Symmetric with the push path: a LIVE row is a duplicate; an id-map entry whose row
    // was deleted is a resurrection (re-insert the same localId), so a fresh row is minted
    // and the id map repointed. The change version continues from latestChangeVersion.
    const priorServerId = await store.getServerId(write.table, localId);
    if (priorServerId && (await store.getRow(write.table, priorServerId))) {
      throw new Error(`serverWriter: duplicate localId for ${write.table}:${localId}`);
    }
    const serverId = await store.insertRow(write.table, value);
    await store.putIdMap(actingUserId, write.table, localId, serverId);
    const version = (await store.latestChangeVersion(write.table, localId)) + 1;
    await runOnWrite(config, write.table, {
      table: write.table,
      action: "insert",
      before: null,
      after: value,
      userId: actingUserId,
      functionName: "serverWriter"
    });
    await store.appendChange(
      { scopeKey, table: write.table, localId, kind: "insert", data: projectSyncedFields(value, tableConfig), version, serverTime },
      serverId
    );
    return { localId, serverId };
  }

  const serverId = await store.getServerId(write.table, write.localId);
  const row = serverId ? await store.getRow(write.table, serverId) : null;

  if (write.kind === "delete") {
    // Deletes commute: deleting an already-gone row is a no-op (matches push).
    if (!row || !serverId) {
      return { localId: write.localId };
    }
    const scopeKey = scopeKeyForRow(tableConfig, row);
    if (!scopeKey) {
      throw new Error(`serverWriter: row ${write.table}:${write.localId} has no usable scope field`);
    }
    const version = (await store.latestChangeVersion(write.table, write.localId)) + 1;
    await store.deleteRow(write.table, serverId);
    await runOnWrite(config, write.table, {
      table: write.table,
      action: "delete",
      before: row,
      after: null,
      userId: actingUserId,
      functionName: "serverWriter"
    });
    await store.appendChange({ scopeKey, table: write.table, localId: write.localId, kind: "delete", version, serverTime }, serverId);
    return { localId: write.localId, serverId };
  }

  if (!row || !serverId) {
    throw new Error(`serverWriter: no row for ${write.table}:${write.localId}`);
  }
  const patch = { ...write.patch };
  // Same defense as push: a patch never moves a row across scopes or rewrites its id.
  for (const field of [partition, tableConfig.idField]) {
    if (field && Object.prototype.hasOwnProperty.call(patch, field)) {
      throw new Error(`serverWriter: cannot patch the ${field === tableConfig.idField ? "id" : "scope"} field "${field}"`);
    }
  }
  if (ts && Object.keys(patch).length > 0) {
    patch[ts.updatedAt] ??= serverTime;
  }
  if (Object.keys(patch).length === 0) {
    return { localId: write.localId, serverId };
  }
  const scopeKey = scopeKeyForRow(tableConfig, row);
  if (!scopeKey) {
    throw new Error(`serverWriter: row ${write.table}:${write.localId} has no usable scope field`);
  }
  const version = (await store.latestChangeVersion(write.table, write.localId)) + 1;
  const after = { ...row, ...patch };
  await store.patchRow(write.table, serverId, patch);
  await runOnWrite(config, write.table, {
    table: write.table,
    action: "patch",
    before: row,
    after,
    userId: actingUserId,
    functionName: "serverWriter"
  });
  await store.appendChange(
    { scopeKey, table: write.table, localId: write.localId, kind: "patch", patch: projectSyncedFields(patch, tableConfig), version, serverTime },
    serverId
  );
  return { localId: write.localId, serverId };
}

/**
 * The membership table to enforce for a workspace/project scope kind. Scope keys
 * are per-value and SHARED across every table of a kind, so the kind must map to
 * exactly one membership table — otherwise a member of the laxer table could pull
 * the stricter table's changes (I7). Reject the ambiguity here (defense for direct
 * serverSync callers; createSyncFunctions also asserts this at config time).
 */
function tableForScope(
  config: SyncConfig,
  kind: "byWorkspace" | "byProject"
): { table: string; membershipTable: string } | null {
  const tables = Object.entries(config.tables).filter(([, value]) => value.scope.kind === kind);
  const memberships = new Set(tables.map(([, value]) => (value.scope as { membershipTable: string }).membershipTable));
  if (memberships.size > 1) {
    throw new Error(
      `serverSync: all ${kind} tables must share one membershipTable (found: ${[...memberships].join(", ")}). Mixed membership tables would cross-authorize reads.`
    );
  }
  const first = tables[0];
  return first ? { table: first[0], membershipTable: [...memberships][0]! } : null;
}

// A completed bootstrap of a scope whose change log is empty still needs a cursor
// (so the client doesn't re-bootstrap forever). Sorts before every real changeId.
const ZERO_CURSOR = "000000000000";
// Bootstrap continuation token: `${endCursor}\u0001${lastRowKey}`. U+0001 cannot
// appear in a changeId (digits only), so the split is unambiguous.
const BOOT_SEP = "\u0001";

export async function handlePull(store: ServerStore, config: SyncConfig, input: PullInput): Promise<PullResult> {
  const now = config.now ?? (() => Date.now());
  // A doorbell (the reactive watch) only needs its read-set to cover "new changes
  // past the cursors" — one row per scope, and never the expensive bootstrap path.
  const limit = input.doorbell ? 1 : config.pullLimit ?? 500;
  const out: PullResult = {
    changes: [],
    cursors: {},
    hasMore: {},
    snapshotScopes: [],
    bootstrapCursors: {},
    deniedScopes: [],
    roles: {},
    serverTime: now()
  };

  if (input.schemaVersion !== config.schemaVersion) {
    return { ...out, schemaMismatch: true };
  }

  const scopes: PullScope[] = [];
  const seenScopes = new Set<string>();
  for (const scope of input.scopes) {
    const key = scope.kind === "byUser" ? "byUser" : `${scope.kind}:${scope.value ?? ""}`;
    if (!seenScopes.has(key)) {
      seenScopes.add(key);
      scopes.push(scope);
    }
  }
  if (scopes.length > 64) {
    throw new Error("convex-localfirst: pull accepts at most 64 unique scopes");
  }

  let remaining = limit;
  const memberCache: MemberCache = new Map();
  for (const scope of scopes) {
    let scopeKey: string;
    let role: unknown | null = null;
    if (scope.kind === "byUser") {
      // I7: derive from identity; ignore any client-supplied user value.
      scopeKey = scopeKeyForUser(input.userId);
    } else if (scope.kind === "byWorkspace" || scope.kind === "byProject") {
      if (!scope.value) {
        continue;
      }
      // Membership is required to read a workspace/project scope. The membership
      // table must be the SAME one push enforces against (the configured value),
      // not a synthesized name — otherwise read and write check different tables.
      const scopeTable = tableForScope(config, scope.kind);
      if (!scopeTable) {
        continue;
      }
      role = await memberRole(
        store,
        config,
        memberCache,
        input.userId,
        scope.kind,
        scope.value,
        scopeTable.table,
        scopeTable.membershipTable
      );
      if (role === null) {
        // Revoked (or never granted): tell the client so it evicts the scope's
        // rows and forgets its cursor. The value came from the client's own
        // request, so echoing it reveals nothing new.
        out.deniedScopes.push(scopeKeyForValue(scope.kind, scope.value));
        continue;
      }
      scopeKey = scopeKeyForValue(scope.kind, scope.value);
      // Ship the resolved role so the client can mirror access rules (DX v4 §6). Derived
      // from identity + membership here — never client-supplied. byUser has no role.
      out.roles[scopeKey] = role;
    } else {
      continue;
    }

    if (remaining === 0) {
      out.hasMore[scopeKey] = true;
      continue;
    }

    const cursor = input.cursors[scopeKey] ?? null;
    const bootCursor = input.bootstrapCursors?.[scopeKey] ?? null;

    // Snapshot bootstrap (store support required): a COLD client (no cursor) reads the
    // scope's CURRENT rows instead of replaying its entire history, and a client whose
    // cursor fell behind the GC horizon (its next changes were pruned) is refreshed the
    // same way. Everything else is the ordinary incremental read.
    if (!input.doorbell && store.rowVersionsByScope && store.firstChangeId && store.lastChangeId) {
      let bootstrap = bootCursor !== null || cursor === null;
      if (!bootstrap) {
        const first = await store.firstChangeId(scopeKey);
        // Gap: the change right after the cursor was GC'd. (A cursor exactly one
        // before the first retained change has missed nothing.)
        bootstrap = first !== null && Number(cursor) < Number(first) - 1;
      }
      if (bootstrap) {
        // endCursor is captured on the FIRST page and carried through the token:
        // changes appended DURING a multi-page bootstrap have changeId > endCursor,
        // so they replay incrementally afterwards (version-folded — never lost,
        // never double-applied).
        let endCursor: string;
        let afterRowKey: string | null;
        if (bootCursor === null) {
          endCursor = (await store.lastChangeId(scopeKey)) ?? "";
          afterRowKey = null;
        } else {
          const sep = bootCursor.indexOf(BOOT_SEP);
          endCursor = bootCursor.slice(0, sep);
          afterRowKey = bootCursor.slice(sep + 1);
        }
        out.snapshotScopes.push(scopeKey); // every page: this scope's changes are snapshot rows
        const page = await store.rowVersionsByScope(scopeKey, afterRowKey, limit);
        let processed = 0;
        let lastRowKey = afterRowKey;
        for (const rv of page) {
          if (remaining === 0) break;
          processed++;
          lastRowKey = rv.rowKey;
          const table = config.tables[rv.table];
          if (!table) {
            continue; // retired table: never expose its row or fallback projection
          }
          // Prefer the denormalized serverId (one point read); fall back to the id map.
          const serverId = rv.serverId ?? (await store.getServerId(rv.table, rv.localId));
          const row = serverId ? await store.getRow(rv.table, serverId) : null;
          if (!row) {
            continue; // deleted row: a cold client simply never sees it
          }
          if (scopeKeyForRow(table, row) !== scopeKey) {
            continue;
          }
          if (
            scope.kind !== "byUser" &&
            config.access?.read &&
            !(await config.access.read({ userId: input.userId, role, table: rv.table, row }))
          ) {
            continue; // row-filtered within the scope (e.g. guest rules)
          }
          out.changes.push({
            changeId: "", // synthetic — clients fold by version, cursors come from out.cursors
            scopeKey,
            table: rv.table,
            localId: rv.localId,
            kind: "insert",
            data: projectSyncedFields(row as Record<string, unknown>, table),
            version: rv.version,
            serverTime: out.serverTime
          });
          remaining--;
        }
        if (processed < page.length || page.length >= limit) {
          out.bootstrapCursors[scopeKey] = `${endCursor}${BOOT_SEP}${lastRowKey ?? ""}`;
          // NO cursor entry mid-bootstrap: the client's persisted cursor stays put,
          // so an interrupted bootstrap restarts as a bootstrap (never as a full
          // history replay from the "" sentinel).
          out.hasMore[scopeKey] = true;
        } else {
          out.cursors[scopeKey] = endCursor || ZERO_CURSOR;
          // Changes appended DURING the bootstrap (changeId > endCursor) still owe
          // an incremental pass — report them so the drain loop keeps going.
          out.hasMore[scopeKey] = (((await store.lastChangeId(scopeKey)) ?? "") > endCursor);
        }
        continue;
      }
    }

    const changes = await store.changesAfter(scopeKey, cursor, limit);
    let processed = 0;
    for (const change of changes) {
      if (remaining === 0) break;
      processed++;
      const table = config.tables[change.table];
      if (!table) {
        continue; // retired/deconfigured tables never leave the shared log
      }
      const serverId = await store.getServerId(change.table, change.localId);
      const row = serverId ? await store.getRow(change.table, serverId) : null;
      const readable =
        row !== null &&
        scopeKeyForRow(table, row) === scopeKey &&
        (scope.kind === "byUser" ||
          !config.access?.read ||
          (await config.access.read({ userId: input.userId, role, table: change.table, row })));
      if (readable) {
        out.changes.push({
          ...change,
          kind: "insert",
          patch: undefined,
          data: projectSyncedFields(row, table)
        });
      } else {
        // Judge every historical change against CURRENT state. Missing/invisible
        // rows become tombstones, so a formerly visible insert can never disclose
        // its old payload.
        out.changes.push({ ...change, kind: "delete", patch: undefined, data: undefined });
      }
      remaining--;
    }
    // The cursor advances past everything PROCESSED (retired rows included), not
    // past rows deferred by the global response budget.
    const last = processed > 0 ? changes[processed - 1] : undefined;
    out.cursors[scopeKey] = last ? last.changeId : cursor ?? "";
    out.hasMore[scopeKey] = processed < changes.length || changes.length >= limit;
  }

  return out;
}

/** Project an app row to the table's declared local-first surface. Server-only
 *  `extra` columns never ride snapshots or the change log. */
function projectSyncedFields(row: Record<string, unknown>, table: ServerTableConfig | undefined): Record<string, unknown> {
  if (table?.syncedFields) {
    const out: Record<string, unknown> = {};
    for (const field of table.syncedFields) {
      if (field in row) {
        out[field] = row[field];
      }
    }
    return out;
  }
  const { _id, _creationTime, ...data } = row as Record<string, unknown> & { _id?: unknown; _creationTime?: unknown };
  return data;
}
