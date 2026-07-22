import { compareOperations } from "./ordering.js";
import { deriveView, nextCanonicalRow } from "./view.js";
import type { LocalStore, StoreListener, StoreUnsubscribe, StoredBlob } from "./storage.js";
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

function clone<T>(value: T): T {
  // structuredClone (Node 18+/browsers) preserves the full Convex value range —
  // int64 (bigint), bytes (ArrayBuffer), and `undefined` properties — which a
  // JSON round-trip throws on or silently drops.
  return structuredClone(value);
}

const OWED_STATUSES: ReadonlySet<OperationStatus> = new Set(["pending", "pushing"]);

/**
 * In-memory implementation of the canonical-centric store. The live view is
 * never stored; it is derived on every read from the canonical snapshot plus a
 * deterministic replay of the pending operation log (see Invariant I1).
 */
export class MemoryLocalStore implements LocalStore {
  private readonly canonical = new Map<TableName, Map<LocalId, RowValue>>();
  private readonly operations = new Map<string, LocalOperation>();
  private readonly cursors = new Map<ScopeKey, string>();
  // Attachment blob outbox, keyed by localId. Blobs are immutable, so we share the
  // reference (no structuredClone — a Blob round-trip through it is a needless copy).
  private readonly blobs = new Map<LocalId, StoredBlob>();
  private readonly listeners = new Set<StoreListener>();
  private epoch = 0;
  private sessionEnded = false;

  async getRows(table: TableName): Promise<readonly RowValue[]> {
    return this.deriveTable(table).map(clone);
  }

  async getRow(table: TableName, id: LocalId): Promise<RowValue | null> {
    const row = this.deriveTable(table).find((candidate) => candidate._id === id);
    return row ? clone(row) : null;
  }

  async getCanonicalRows(table: TableName): Promise<readonly RowValue[]> {
    return Array.from(this.tableMap(table).values()).map(clone);
  }

  async applyServerChange(change: ServerChange, expectedEpoch = this.epoch): Promise<void> {
    if (this.sessionEnded || expectedEpoch !== this.epoch) return;
    this.applyOne(change);
    this.notify();
  }

  async applyServerChanges(changes: readonly ServerChange[], expectedEpoch = this.epoch): Promise<void> {
    if (changes.length === 0 || this.sessionEnded || expectedEpoch !== this.epoch) {
      return;
    }
    for (const change of changes) {
      this.applyOne(change);
    }
    this.notify(); // one notify for the whole batch — see LocalStore.applyServerChanges
  }

  private applyOne(change: ServerChange): void {
    const table = this.tableMap(change.table);
    const next = nextCanonicalRow(table.get(change.id) ?? null, change);
    if (next !== "stale") {
      table.set(change.id, next);
    }
    // The op that produced this change is now part of canonical: stop replaying it.
    if (change.opId) {
      this.operations.delete(change.opId);
    }
  }

  async enqueueOperation(operation: LocalOperation): Promise<void> {
    if (!this.operations.has(operation.opId)) {
      this.operations.set(operation.opId, clone(operation));
      this.notify();
    }
  }

  async getPendingOperations(): Promise<readonly LocalOperation[]> {
    return Array.from(this.operations.values())
      .filter((operation) => OWED_STATUSES.has(operation.status))
      .sort(compareOperations)
      .map(clone);
  }

  async getAllOperations(): Promise<readonly LocalOperation[]> {
    return Array.from(this.operations.values()).sort(compareOperations).map(clone);
  }

  async getOperation(opId: string): Promise<LocalOperation | null> {
    const operation = this.operations.get(opId);
    return operation ? clone(operation) : null;
  }

  async updateOperationStatus(opId: string, status: OperationStatus, error?: string): Promise<void> {
    const current = this.operations.get(opId);
    if (!current) {
      return;
    }
    this.operations.set(opId, { ...current, status, error });
    this.notify();
  }

  async dropOperation(opId: string): Promise<void> {
    if (this.operations.delete(opId)) {
      this.notify();
    }
  }

  async getCursor(scopeKey: ScopeKey): Promise<Cursor> {
    return this.cursors.get(scopeKey) ?? null;
  }

  async setCursor(scopeKey: ScopeKey, cursor: string, expectedEpoch = this.epoch): Promise<void> {
    if (this.sessionEnded || expectedEpoch !== this.epoch) return;
    // Monotonic (I5): cursors only advance. Concurrent same-scope pulls (multiple
    // mounted hooks + the reactive watch) can resolve out of order; a write that
    // would move the cursor backward is ignored, since it would cause redundant
    // re-delivery and destabilize the reactive resubscribe window.
    const current = this.cursors.get(scopeKey);
    if (current !== undefined && cursor <= current) {
      return;
    }
    this.cursors.set(scopeKey, cursor);
  }

  async removeCanonicalRows(
    table: TableName,
    field: string,
    value: unknown,
    keepIds?: ReadonlySet<LocalId>,
    expectedEpoch = this.epoch
  ): Promise<void> {
    if (this.sessionEnded || expectedEpoch !== this.epoch) return;
    const rows = this.tableMap(table);
    let removed = false;
    for (const [id, row] of rows) {
      if (row[field] === value && !keepIds?.has(id)) {
        rows.delete(id);
        removed = true;
      }
    }
    if (removed) {
      this.notify();
    }
  }

  async removeCursor(scopeKey: ScopeKey, expectedEpoch = this.epoch): Promise<void> {
    if (this.sessionEnded || expectedEpoch !== this.epoch) return;
    this.cursors.delete(scopeKey);
  }

  async getEpoch(): Promise<number> {
    return this.epoch;
  }

  async putBlob(record: StoredBlob): Promise<void> {
    if (this.sessionEnded) return;
    this.blobs.set(record.localId, { ...record });
  }

  async getBlob(localId: LocalId): Promise<StoredBlob | null> {
    const record = this.blobs.get(localId);
    return record ? { ...record } : null;
  }

  async getAllBlobs(): Promise<readonly StoredBlob[]> {
    return Array.from(this.blobs.values()).map((record) => ({ ...record }));
  }

  async deleteBlob(localId: LocalId): Promise<void> {
    this.blobs.delete(localId);
  }

  async clear(): Promise<void> {
    this.epoch++;
    this.sessionEnded = true;
    this.canonical.clear();
    this.operations.clear();
    this.cursors.clear();
    this.blobs.clear();
    this.notify();
  }

  subscribe(listener: StoreListener): StoreUnsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }

  /** Derive the live view for one table: canonical + deterministic replay of active ops. */
  private deriveTable(table: TableName): RowValue[] {
    return deriveView(table, Array.from(this.tableMap(table).values()), Array.from(this.operations.values()));
  }

  private tableMap(table: TableName): Map<LocalId, RowValue> {
    const current = this.canonical.get(table);
    if (current) {
      return current;
    }
    const next = new Map<LocalId, RowValue>();
    this.canonical.set(table, next);
    return next;
  }
}
