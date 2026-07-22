import type {
  LedgerEntry,
  ServerOperation,
  ServerStore,
  StoredChange,
} from "../server/serverSync.js";

/**
 * A complete in-memory authoritative server store — the SAME `ServerStore` contract the
 * bundled Convex component implements, backed by plain Maps. It powers `createTestHarness`
 * (convex-localfirst/testing) and the package's own server tests, so the harness runs the
 * REAL `handlePush`/`handlePull` against real bookkeeping rather than a mock.
 *
 * It provides the optional bootstrap methods (`firstChangeId`/`lastChangeId`/
 * `rowVersionsByScope`) and a `gc()` helper, so cold-client snapshot bootstrap and change-log
 * pruning behave exactly as in production. Membership is a simple `${userId}:${scopeValue}:${
 * membershipTable}` set; `denyWrite` lets an `access.write` hook reject specific rows.
 *
 * Not transactional (the bundled tests run sequentially): a custom production `ServerStore`
 * must provide per-push isolation, as documented on `ServerStore`.
 */
export class MemoryServerStore implements ServerStore {
  rows = new Map<string, Map<string, Record<string, unknown>>>();
  ledger = new Map<string, LedgerEntry>();
  idmap = new Map<string, string>();
  changes: StoredChange[] = []; // append-only
  members = new Set<string>();
  /** Denylist of `${table}:${localId}` an access.write hook may reject (authz tests). */
  denyWrite = new Set<string>();
  rowVersions = new Map<
    string,
    { table: string; localId: string; rowKey: string; scopeKey: string; version: number }
  >();
  private seq = 0;
  private serverIdSeq = 0;

  private table(table: string) {
    let m = this.rows.get(table);
    if (!m) {
      m = new Map();
      this.rows.set(table, m);
    }
    return m;
  }

  async getRow(table: string, serverId: string) {
    return this.table(table).get(serverId) ?? null;
  }
  async insertRow(table: string, data: Record<string, unknown>) {
    const serverId = `srv_${++this.serverIdSeq}`;
    // Store exactly what serverSync inserts — no synthetic _version column (the real
    // Convex backend's schema would reject unknown fields).
    this.table(table).set(serverId, { ...data });
    return serverId;
  }
  async patchRow(table: string, serverId: string, patch: Record<string, unknown>) {
    const current = this.table(table).get(serverId) ?? {};
    this.table(table).set(serverId, { ...current, ...patch });
  }
  async deleteRow(table: string, serverId: string) {
    this.table(table).delete(serverId);
  }

  async getLedger(userId: string, opId: string) {
    // Keyed by (userId, opId) only — opId is globally unique, so a replay under a
    // different envelope clientId (reload/new tab) still dedups.
    return this.ledger.get(`${userId}:${opId}`) ?? null;
  }
  async commitOp(
    userId: string,
    op: ServerOperation,
    entry: Omit<LedgerEntry, "schemaVersion" | "changes">,
    change?: Omit<StoredChange, "changeId">,
  ) {
    let stored: StoredChange | null = null;
    if (change) {
      const changeId = await this.appendChange(change);
      stored = { ...change, changeId };
    }
    this.ledger.set(`${userId}:${op.opId}`, {
      ...entry,
      schemaVersion: op.schemaVersion,
      changes: stored ? [stored] : undefined,
    });
    return stored;
  }

  async getServerId(table: string, localId: string) {
    // Keyed by (table, localId) only — any authorized member resolves the row, not
    // just its creator.
    return this.idmap.get(`${table}:${localId}`) ?? null;
  }
  async putIdMap(_userId: string, table: string, localId: string, serverId: string) {
    this.idmap.set(`${table}:${localId}`, serverId);
  }

  async appendChange(change: Omit<StoredChange, "changeId">) {
    const changeId = String(++this.seq).padStart(12, "0"); // lexicographically monotonic
    this.changes.push({ ...change, changeId });
    this.rowVersions.set(`${change.table}:${change.localId}`, {
      table: change.table,
      localId: change.localId,
      rowKey: `${change.table}:${change.localId}`,
      scopeKey: change.scopeKey,
      version: change.version,
    });
    return changeId;
  }

  /** Simulate the component's opportunistic GC: prune this scope's oldest changes,
   *  always keeping the newest `keepLast`. */
  gc(scopeKey: string, keepLast = 1) {
    const rel = this.changes.filter((c) => c.scopeKey === scopeKey);
    const cut = new Set(rel.slice(0, Math.max(0, rel.length - keepLast)));
    this.changes = this.changes.filter((c) => !cut.has(c));
  }

  async firstChangeId(scopeKey: string) {
    const rel = this.changes.filter((c) => c.scopeKey === scopeKey);
    return rel.length ? rel[0]!.changeId : null;
  }
  async lastChangeId(scopeKey: string) {
    const rel = this.changes.filter((c) => c.scopeKey === scopeKey);
    return rel.length ? rel[rel.length - 1]!.changeId : null;
  }
  async rowVersionsByScope(scopeKey: string, afterRowKey: string | null, limit: number) {
    return [...this.rowVersions.values()]
      .filter((r) => r.scopeKey === scopeKey && r.rowKey > (afterRowKey ?? ""))
      .sort((a, b) => (a.rowKey < b.rowKey ? -1 : 1))
      .slice(0, limit);
  }
  async changesAfter(scopeKey: string, cursor: string | null, limit: number) {
    const from = cursor ?? "";
    return this.changes.filter((c) => c.scopeKey === scopeKey && c.changeId > from).slice(0, limit);
  }
  async latestChangeVersion(table: string, localId: string) {
    return this.changes
      .filter((c) => c.table === table && c.localId === localId)
      .reduce((max, c) => Math.max(max, c.version), 0);
  }
  async scopeForLocalId(table: string, localId: string) {
    // Newest change for (table, localId), mirroring the component's by_table_local desc.
    const rel = this.changes.filter((c) => c.table === table && c.localId === localId);
    return rel.length ? rel[rel.length - 1]!.scopeKey : null;
  }
}
