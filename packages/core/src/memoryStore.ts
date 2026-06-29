import { compareOperations } from "./ordering.js";
import { deriveView, nextCanonicalRow } from "./view.js";
import type { LocalStore, StoreListener, StoreUnsubscribe } from "./storage.js";
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
  private readonly listeners = new Set<StoreListener>();

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

  async applyServerChange(change: ServerChange): Promise<void> {
    this.applyOne(change);
    this.notify();
  }

  async applyServerChanges(changes: readonly ServerChange[]): Promise<void> {
    if (changes.length === 0) {
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

  async setCursor(scopeKey: ScopeKey, cursor: string): Promise<void> {
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

  async clear(): Promise<void> {
    this.canonical.clear();
    this.operations.clear();
    this.cursors.clear();
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
