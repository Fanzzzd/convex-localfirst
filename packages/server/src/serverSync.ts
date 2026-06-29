import type { ConflictPolicyName, ScopeDefinition } from "@convex-localfirst/core";
import { applyCounterDelta, applySetDelta, isCounterDelta, isSetDelta, lwwWins, type FieldClock } from "@convex-localfirst/core/internal";

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

export type ServerTableConfig = {
  readonly scope: ScopeDefinition;
  readonly idField: string;
  // The conflict policy (see ConflictPolicyName — only REAL policies are offered):
  //  - "fieldLww" (default): field-scoped patches merge field-by-field on the client
  //    (view.ts/rebase.ts use {...row, ...patch}) and here via ctx.db.patch, so concurrent
  //    edits to DIFFERENT fields both survive; same-field collisions resolve by ARRIVAL order.
  //  - "timestampLww": same field merge, but same-field collisions resolve by the op's logical
  //    timestamp (+clientId tiebreaker) via per-field write clocks — see the patch path below.
  // Orthogonal convergent merges are per-field (setFields/counterFields), not a row policy,
  // and are exempt from the LWW rule (they never clobber).
  readonly conflict: ConflictPolicyName;
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
  // The op's logical timestamp (the client's monotonic clock at write time). Used only by
  // `timestampLww` tables to resolve same-field collisions by recency, not arrival order.
  readonly timestamp?: number;
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
  readonly status: "accepted" | "rejected";
  readonly resultJson?: string;
  readonly error?: string;
  // The canonical change(s) this op produced, serialized. Returned again on a
  // duplicate replay so a client that committed the op server-side but never
  // received the ack (crash/network drop) still gets its confirming change and the
  // row leaves _pending — instead of replaying forever against an absent canonical.
  readonly changesJson?: string;
};

/**
 * Storage contract the sync engine drives. TRANSACTIONAL REQUIREMENT (I2/I5): each push
 * does read-then-write sequences that need transactional isolation —
 *  - idempotency: getLedger → apply → putLedger must be atomic, else concurrent pushes of
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

  // Operation ledger (idempotency), keyed by (userId, opId). opId is globally unique
  // (embeds the originating clientId), so this dedups a durable op even when it is
  // replayed under a different envelope clientId after a reload/new tab. putLedger keeps
  // clientId only as an audit column.
  getLedger(userId: string, opId: string): Promise<LedgerEntry | null>;
  putLedger(userId: string, clientId: string, op: ServerOperation, entry: LedgerEntry): Promise<void>;

  // Local id -> server id, keyed by (table, localId) — NOT by user. A
  // workspace/project row is created by one member but patched/deleted by others,
  // so resolution must not be scoped to the creator (membership is enforced
  // separately, in resolveScopeForWrite). localId is a globally-unique client id.
  getServerId(table: string, localId: string): Promise<string | null>;
  putIdMap(userId: string, table: string, localId: string, serverId: string): Promise<void>;

  // Append-only change log. Returns the assigned monotonic changeId.
  appendChange(change: Omit<StoredChange, "changeId">): Promise<string>;
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

  /** OPTIONAL on the type, but REQUIRED for any `timestampLww` table: per-field write clocks
   *  (field → {ts, tiebreaker}). A timestampLww table whose store lacks these REJECTS the op
   *  loudly (no silent arrival-order degrade — see applyOp). A store with only `fieldLww` tables
   *  never needs them. Like the version RMW, the get→put pair must share the push mutation's
   *  transaction (it does in the real Convex adapter) so concurrent writers can't lose a clock update. */
  getFieldClocks?(table: string, localId: string): Promise<Record<string, FieldClock>>;
  putFieldClocks?(table: string, localId: string, clocks: Record<string, FieldClock>): Promise<void>;

  // Workspace/project membership check.
  isMember(userId: string, scopeValue: string, membershipTable: string): Promise<boolean>;
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
};

export type PullResult = {
  readonly changes: StoredChange[];
  readonly cursors: Record<string, string>;
  readonly serverTime: number;
  readonly schemaMismatch?: boolean;
  /** Per-scope: true when this page hit the pull limit, so more changes remain. */
  readonly hasMore: Record<string, boolean>;
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
};

class RejectOp extends Error {}

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
  config: ServerTableConfig,
  userId: string,
  op: ServerOperation
): Promise<{ scopeKey: string; value: Record<string, unknown> }> {
  const scope = config.scope;
  const value = { ...(op.value ?? {}) };

  if (scope.kind === "byUser") {
    if (op.kind === "insert") {
      // Ignore any client-supplied owner: ownership is the authenticated user.
      value[scope.field] = userId;
      return { scopeKey: scopeKeyForUser(userId), value };
    }
    // patch/delete: the row must exist AND be owned by this user. The id map is
    // global (by table+localId), so without this check a user who guesses another
    // user's localId could write their row.
    const existing = await loadRow(store, op);
    if (existing[scope.field] !== userId) {
      throw new RejectOp("Not the owner of this row");
    }
    return { scopeKey: scopeKeyForUser(userId), value };
  }

  if (scope.kind === "byWorkspace" || scope.kind === "byProject") {
    const field = scope.kind === "byWorkspace" ? scope.workspaceIdField : scope.projectIdField;
    let scopeValue: string | null;
    if (op.kind === "insert") {
      // An insert declares the scope it targets; membership on it is checked below.
      scopeValue = typeof value[field] === "string" ? String(value[field]) : null;
    } else {
      // patch/delete: scope comes from the existing row, NEVER from op.value.
      const existing = await loadRow(store, op);
      scopeValue = typeof existing[field] === "string" ? String(existing[field]) : null;
    }
    if (!scopeValue) {
      throw new RejectOp(`Missing ${field} for scoped write`);
    }
    const member = await store.isMember(userId, scopeValue, scope.membershipTable);
    if (!member) {
      throw new RejectOp("Not a member of the target scope");
    }
    return { scopeKey: scopeKeyForValue(scope.kind, scopeValue), value };
  }

  throw new RejectOp("Custom scopes require a server resolver");
}

/** True if `userId` may write rows in `scopeKey`. The boolean core of scope
 *  authorization — the caller decides whether to throw and with what message, so a
 *  delete can reject every denial (missing/foreign/gone) with ONE generic message
 *  and avoid leaking which case it was (an existence/ownership oracle, I7). */
async function isAuthorizedForScope(
  store: ServerStore,
  config: ServerTableConfig,
  userId: string,
  scopeKey: string
): Promise<boolean> {
  const scope = config.scope;
  if (scope.kind === "byUser") {
    return scopeKey === scopeKeyForUser(userId);
  }
  if (scope.kind === "byWorkspace" || scope.kind === "byProject") {
    const value = scopeKey.slice(scopeKey.indexOf(":") + 1);
    return await store.isMember(userId, value, scope.membershipTable);
  }
  return false; // defensive: fail closed on any unknown scope kind
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
  const codec = config.valueCodec ?? JSON_VALUE_CODEC;
  const result: PushResult = { accepted: [], rejected: [], idMaps: [], changes: [], serverTime };

  if (input.schemaVersion !== config.schemaVersion) {
    return { ...result, schemaMismatch: true };
  }

  for (const op of input.mutations) {
    // I2: idempotency — a known opId is never re-applied (keyed by (userId, opId) so a
    // reload/new-tab replay under a different envelope clientId is still deduped).
    const prior = await store.getLedger(input.userId, op.opId);
    if (prior) {
      if (prior.status === "accepted") {
        result.accepted.push({ opId: op.opId, serverResult: prior.resultJson ? JSON.parse(prior.resultJson) : undefined });
        // Re-deliver the confirming change so a replayed (already-committed) op can
        // leave _pending even if its original ack was lost. The client version-checks
        // it (nextCanonicalRow), so re-applying a now-stale change is ignored — never a
        // regression. The server log is NOT re-appended (this is read from the ledger).
        if (prior.changesJson) {
          result.changes.push(...(codec.decode(prior.changesJson) as StoredChange[]));
        }
      } else {
        result.rejected.push({ opId: op.opId, message: prior.error ?? "rejected" });
      }
      continue;
    }

    // I8: an op carries the schema it was BUILT under. The envelope already matches the
    // server (checked above), so a per-op mismatch means a stale offline op queued before
    // a client schema upgrade. Applying it under the new schema can silently corrupt
    // (changed field meaning, new required field). Reject it loudly — the client must
    // migrate queued ops before pushing — rather than commit semantically stale data.
    if (op.schemaVersion !== input.schemaVersion) {
      const message = `Operation ${op.opId} was created under schema v${op.schemaVersion} but the client now declares v${input.schemaVersion}; migrate queued operations before pushing.`;
      result.rejected.push({ opId: op.opId, message });
      await store.putLedger(input.userId, input.clientId, op, { status: "rejected", error: message });
      continue;
    }

    const tableConfig = config.tables[op.table];
    if (!tableConfig) {
      const message = `Unknown local-first table: ${op.table}`;
      result.rejected.push({ opId: op.opId, message });
      await store.putLedger(input.userId, input.clientId, op, { status: "rejected", error: message });
      continue;
    }

    try {
      const change = await applyOp(store, tableConfig, input.userId, op, serverTime);
      if (change) {
        result.changes.push(change);
      }
      const serverId = await store.getServerId(op.table, op.localId);
      if (op.kind === "insert" && serverId) {
        result.idMaps.push({ table: op.table, localId: op.localId, serverId });
      }
      // change === null is an idempotent no-op delete (row already gone): still ack it
      // so the client stops retrying, and ledger it for opId idempotency. Do NOT echo
      // serverId on a no-op — the row is gone, so its internal id must not leak.
      const serverResult =
        change === null
          ? { ok: true, localId: op.localId, noop: true }
          : { ok: true, localId: op.localId, serverId };
      result.accepted.push({ opId: op.opId, serverResult });
      await store.putLedger(input.userId, input.clientId, op, {
        status: "accepted",
        resultJson: JSON.stringify(serverResult),
        // Persist the confirming change so a later duplicate replay can recover it.
        changesJson: change ? codec.encode([change]) : undefined
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.rejected.push({ opId: op.opId, message });
      await store.putLedger(input.userId, input.clientId, op, { status: "rejected", error: message });
    }
  }

  return result;
}

// Bound how far a client's logical write-clock may lead the server clock. op.timestamp
// is the client's own clock (legitimately ahead of serverTime by real skew), so we don't
// clamp to serverTime exactly — but an UNBOUNDED future timestamp would let an authorized
// writer pin a timestampLww field forever (every later honest write has a smaller ts and
// loses). Clamping to serverTime + this bound caps that abuse to a small window while
// leaving every real write (op.createdAt ≈ now) untouched.
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

async function applyOp(
  store: ServerStore,
  tableConfig: ServerTableConfig,
  userId: string,
  op: ServerOperation,
  serverTime: number
): Promise<StoredChange | null> {
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
    if (scopeKey === null || !(await isAuthorizedForScope(store, tableConfig, userId, scopeKey))) {
      throw new RejectOp(`Cannot delete ${op.table}:${op.localId}`);
    }
    // Deletes commute: an authorized delete of an already-gone row acks as a no-op
    // (the EXPECTED case for an insert-only log with compaction, where two clients
    // can concurrently prune the same subsumed rows, and for any replayed delete).
    if (!existingRow) {
      return null;
    }
    const version = (await store.latestChangeVersion(op.table, op.localId)) + 1;
    await store.deleteRow(op.table, existingId as string);
    const changeId = await store.appendChange({
      scopeKey,
      table: op.table,
      localId: op.localId,
      kind: "delete",
      version,
      serverTime,
      opId: op.opId
    });
    return changeAsStored(changeId, scopeKey, op, "delete", version, serverTime, undefined, undefined);
  }

  let scopeKey: string;
  let value: Record<string, unknown>;
  try {
    ({ scopeKey, value } = await resolveScopeForWrite(store, tableConfig, userId, op));
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
    // reaching here with an existing (table, localId) means a DIFFERENT op reused
    // the localId. localId must be globally unique — treat a collision as invalid
    // rather than as license to append a change against an existing row.
    if (await store.getServerId(op.table, op.localId)) {
      throw new RejectOp(`Duplicate localId for ${op.table}:${op.localId}`);
    }
    const serverId = await store.insertRow(op.table, value);
    await store.putIdMap(userId, op.table, op.localId, serverId);
    // First change for a fresh row is version 1 (I5 monotonicity).
    const version = (await store.latestChangeVersion(op.table, op.localId)) + 1;
    const changeId = await store.appendChange({
      scopeKey,
      table: op.table,
      localId: op.localId,
      kind: "insert",
      data: value,
      version,
      serverTime,
      opId: op.opId
    });
    return changeAsStored(changeId, scopeKey, op, "insert", version, serverTime, value, undefined);
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
    // Convergent (set/counter) delta fields are merged commutatively below and are EXEMPT
    // from timestamp-LWW (they never clobber by design). Capture them before materialization.
    const deltaFields = new Set(
      Object.keys(patch).filter((f) => isSetDelta(patch[f]) || isCounterDelta(patch[f]))
    );
    if (deltaFields.size > 0) {
      const current = await loadRow(store, op);
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
    // Timestamp-ordered LWW: for a `timestampLww` table, resolve each plain scalar field-write
    // against the field's last-write clock so a newer edit wins regardless of arrival order; a
    // stale write is dropped. Delta fields (set/counter) are exempt (they never clobber), so a
    // delta-only patch skips this. A patch writing ANY plain field MUST carry a timestamp and a
    // field-clock store — applying by arrival order without updating the clock would desync it
    // and wrongly drop a later write — so we fail closed loudly rather than corrupt.
    if (tableConfig.conflict === "timestampLww") {
      const plainFields = Object.keys(patch).filter((f) => !deltaFields.has(f));
      if (plainFields.length > 0) {
        if (op.timestamp === undefined) {
          throw new RejectOp(
            `Table "${op.table}" uses conflict: "timestampLww" but this op writes scalar field(s) [${plainFields.join(", ")}] without a timestamp — upgrade the client (the local-first transport sends one automatically).`
          );
        }
        if (!store.getFieldClocks || !store.putFieldClocks) {
          throw new RejectOp(
            `Table "${op.table}" uses conflict: "timestampLww" but the ServerStore has no getFieldClocks/putFieldClocks. Use the bundled component or implement both.`
          );
        }
        const ts = Math.min(op.timestamp, serverTime + MAX_CLOCK_SKEW_MS); // cap far-future pinning
        const incoming: FieldClock = { ts, tiebreaker: op.clientId };
        const clocks = await store.getFieldClocks(op.table, op.localId);
        const winners: Record<string, unknown> = {};
        const updated: Record<string, FieldClock> = {};
        for (const [field, value] of Object.entries(patch)) {
          if (deltaFields.has(field)) {
            winners[field] = value; // convergent delta — always kept, no clock
          } else if (lwwWins(incoming, clocks[field])) {
            winners[field] = value;
            updated[field] = incoming;
          }
          // else: a stale plain field-write — drop it, keeping the current (newer) value.
        }
        if (Object.keys(updated).length > 0) {
          await store.putFieldClocks(op.table, op.localId, { ...clocks, ...updated });
        }
        patch = winners;
      }
    }
    // A patch that resolved to no fields — every plain field lost the timestamp-LWW race,
    // or the op carried an empty patch — is an ACCEPTED no-op (like an already-gone delete):
    // skip the write so it never appends a spurious empty change, consumes a version, or
    // gets re-delivered to every puller. Do NOT leak the serverId (handlePush noop path).
    if (Object.keys(patch).length === 0) {
      return null;
    }
    await store.patchRow(op.table, serverId, patch);
    const changeId = await store.appendChange({
      scopeKey,
      table: op.table,
      localId: op.localId,
      kind: "patch",
      patch,
      version,
      serverTime,
      opId: op.opId
    });
    return changeAsStored(changeId, scopeKey, op, "patch", version, serverTime, undefined, patch);
  }

  // insert/patch return above; delete is fully handled at the top. This is
  // unreachable for the three known kinds — guard any future kind explicitly.
  throw new RejectOp(`Unsupported op kind for ${op.table}:${op.localId}`);
}

function changeAsStored(
  changeId: string,
  scopeKey: string,
  op: ServerOperation,
  kind: StoredChange["kind"],
  version: number,
  serverTime: number,
  data: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined
): StoredChange {
  return { changeId, scopeKey, table: op.table, localId: op.localId, kind, data, patch, version, serverTime, opId: op.opId };
}

/**
 * The membership table to enforce for a workspace/project scope kind. Scope keys
 * are per-value and SHARED across every table of a kind, so the kind must map to
 * exactly one membership table — otherwise a member of the laxer table could pull
 * the stricter table's changes (I7). Reject the ambiguity here (defense for direct
 * serverSync callers; createSyncFunctions also asserts this at config time).
 */
function membershipTableForScope(config: SyncConfig, kind: "byWorkspace" | "byProject"): string | null {
  const tables = new Set<string>();
  for (const table of Object.values(config.tables)) {
    if (table.scope.kind === kind) {
      tables.add(table.scope.membershipTable);
    }
  }
  if (tables.size > 1) {
    throw new Error(
      `serverSync: all ${kind} tables must share one membershipTable (found: ${[...tables].join(", ")}). Mixed membership tables would cross-authorize reads.`
    );
  }
  return tables.size === 1 ? [...tables][0] : null;
}

export async function handlePull(store: ServerStore, config: SyncConfig, input: PullInput): Promise<PullResult> {
  const now = config.now ?? (() => Date.now());
  const limit = config.pullLimit ?? 500;
  const out: PullResult = { changes: [], cursors: {}, hasMore: {}, serverTime: now() };

  if (input.schemaVersion !== config.schemaVersion) {
    return { ...out, schemaMismatch: true };
  }

  for (const scope of input.scopes) {
    let scopeKey: string;
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
      const membershipTable = membershipTableForScope(config, scope.kind);
      if (!membershipTable) {
        continue;
      }
      const member = await store.isMember(input.userId, scope.value, membershipTable);
      if (!member) {
        continue;
      }
      scopeKey = scopeKeyForValue(scope.kind, scope.value);
    } else {
      continue;
    }

    const cursor = input.cursors[scopeKey] ?? null;
    const changes = await store.changesAfter(scopeKey, cursor, limit);
    out.changes.push(...changes);
    const last = changes[changes.length - 1];
    out.cursors[scopeKey] = last ? last.changeId : cursor ?? "";
    // A full page means the server capped this scope; more may remain past the cursor.
    out.hasMore[scopeKey] = changes.length >= limit;
  }

  return out;
}
