import type { LocalStore, StoreListener, StoreUnsubscribe } from "./storage.js";
import { compareOperations } from "./ordering.js";
import { deriveView, nextCanonicalRow } from "./view.js";
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

export type IndexedDbStoreOptions = {
  readonly databaseName: string;
  /** Per-user/per-tenant suffix; switching it isolates data (Invariant I9). */
  readonly namespace: string;
  /** Called when an upgrade is blocked by another open connection. */
  readonly onBlocked?: () => void;
};

export const INDEXED_DB_SCHEMA_VERSION = 3;

const CANONICAL = "canonical";
const OPERATIONS = "operations";
const CURSORS = "cursors";
const META = "meta";
const BY_TABLE = "by_table";
const EPOCH_KEY = "epoch";

const OWED_STATUSES: ReadonlySet<OperationStatus> = new Set(["pending", "pushing"]);

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

/** Schema migrations. Each block runs when upgrading past that version. */
function upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void {
  if (oldVersion < 1) {
    db.createObjectStore(CANONICAL, { keyPath: ["_table", "_id"] });
    db.createObjectStore(OPERATIONS, { keyPath: "opId" });
    db.createObjectStore(CURSORS, { keyPath: "scopeKey" });
  }
  if (oldVersion < 2) {
    const canonical = tx.objectStore(CANONICAL);
    if (!canonical.indexNames.contains(BY_TABLE)) {
      canonical.createIndex(BY_TABLE, "_table", { unique: false });
    }
  }
  if (oldVersion < 3) {
    // Durable logout epoch (I9). NOT wiped by clear(); clear() bumps it so a
    // concurrent apply in another tab sees the advance and aborts (no resurrection).
    // Guarded like the by_table index: opening AT an intermediate version runs every
    // `oldVersion < N` block, so a later open must not recreate an existing store.
    if (!db.objectStoreNames.contains(META)) {
      db.createObjectStore(META, { keyPath: "key" });
    }
  }
}

export function openLocalFirstDb(
  name: string,
  version: number,
  options: { onBlocked?: () => void } = {}
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, version);
    open.onupgradeneeded = (event) => {
      upgrade(open.result, event.oldVersion, open.transaction as IDBTransaction);
    };
    open.onblocked = () => options.onBlocked?.();
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/**
 * IndexedDB-backed canonical store. Same model as MemoryLocalStore (the live
 * view is derived via deriveView), persisted durably so pending operations and
 * canonical rows survive reloads (Invariant I3).
 */
export class IndexedDbStore implements LocalStore {
  private readonly listeners = new Set<StoreListener>();
  private readonly dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;
  /** Serializes canonical-mutating writes within this tab so a logout clear can't
   *  interleave with an in-flight apply and resurrect rows. Cross-tab safety comes from
   *  each apply being one atomic readwrite tx, not this lock. ponytail: promise-chain;
   *  errors swallowed so one failed write can't wedge the queue. */
  private writeChain: Promise<void> = Promise.resolve();
  // Logout epoch this instance opened under. clear() bumps the durable epoch; an apply
  // whose captured epoch no longer matches means a clear happened → the session is over.
  private epoch = 0;
  // Set once a clear/foreign-clear is seen: further applies become no-ops (else they'd
  // resurrect cleared data). Per-instance, not a permanent lock — a new login opens a
  // fresh store (the provider keys it on userId).
  private sessionEnded = false;

  constructor(readonly options: IndexedDbStoreOptions) {
    this.dbName = `${options.databaseName}:${options.namespace}`;
  }

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openLocalFirstDb(this.dbName, INDEXED_DB_SCHEMA_VERSION, {
        onBlocked: this.options.onBlocked
      }).then(async (db) => {
        // If another tab needs to upgrade, get out of the way and reopen lazily.
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        // Seed the epoch this instance opened under, so a later clear() (here or in
        // another tab) is detectable as an advance against this captured value.
        try {
          const row = (await request(db.transaction(META, "readonly").objectStore(META).get(EPOCH_KEY))) as
            | { value: number }
            | undefined;
          this.epoch = row?.value ?? 0;
        } catch {
          this.epoch = 0;
        }
        return db;
      });
    }
    return this.dbPromise;
  }

  /** Internal accessor for tests that need raw transactional access. */
  async _database(): Promise<IDBDatabase> {
    return this.db();
  }

  async getCanonicalRows(table: TableName): Promise<readonly RowValue[]> {
    const db = await this.db();
    const tx = db.transaction(CANONICAL, "readonly");
    const index = tx.objectStore(CANONICAL).index(BY_TABLE);
    return (await request(index.getAll(table))) as RowValue[];
  }

  async getRows(table: TableName): Promise<readonly RowValue[]> {
    const db = await this.db();
    const tx = db.transaction([CANONICAL, OPERATIONS], "readonly");
    const canonical = (await request(tx.objectStore(CANONICAL).index(BY_TABLE).getAll(table))) as RowValue[];
    const operations = (await request(tx.objectStore(OPERATIONS).getAll())) as LocalOperation[];
    return deriveView(table, canonical, operations);
  }

  async getRow(table: TableName, id: LocalId): Promise<RowValue | null> {
    const rows = await this.getRows(table);
    return rows.find((row) => row._id === id) ?? null;
  }

  async applyServerChange(change: ServerChange): Promise<void> {
    await this.applyServerChanges([change]);
  }

  async applyServerChanges(changes: readonly ServerChange[]): Promise<void> {
    if (changes.length === 0 || this.sessionEnded) {
      return;
    }
    // Queue behind any in-flight canonical write IN THIS TAB (so clear() cannot
    // interleave). Cross-tab safety is the atomic tx inside applyServerChangesAtomic.
    const run = this.writeChain.then(() => this.applyServerChangesAtomic(changes));
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async applyServerChangesAtomic(changes: readonly ServerChange[]): Promise<void> {
    const db = await this.db();
    // NUL separator: table names and localIds cannot contain it, so distinct
    // (table, id) pairs never collide in the grouping map below.
    const keyOf = (table: string, id: string) => `${table}\u0000${id}`;

    // Group changes per row, preserving arrival order. A batch may carry several
    // changes to the same row (e.g. insert then patch) that must fold in order.
    const perRow = new Map<string, { table: string; id: string; changes: ServerChange[] }>();
    const opIds = new Set<string>();
    for (const c of changes) {
      const k = keyOf(c.table, c.id);
      let entry = perRow.get(k);
      if (!entry) {
        entry = { table: c.table, id: c.id, changes: [] };
        perRow.set(k, entry);
      }
      entry.changes.push(c);
      if (c.opId) opIds.add(c.opId);
    }

    // ONE readwrite tx: the per-row get -> version-compare -> put happens atomically
    // via request callbacks. NEVER await between requests, which would let the tx
    // auto-commit early. Because IndexedDB serializes overlapping readwrite
    // transactions to the same store (INCLUDING across tabs/connections), a
    // concurrent apply's get observes our committed put, so an older version cannot
    // overwrite a newer one and the canonical row never regresses (I5). A delete
    // folds to a `_deleted: true` tombstone row (deriveView hides it), so we only put.
    // META is in the SAME tx as the canonical writes: read the durable epoch FIRST and
    // only apply if it still matches the epoch we opened under. IndexedDB serializes
    // overlapping readwrite txns to the same stores across tabs/connections, so a
    // clear() that committed first (bumping the epoch) is observed here and we abort —
    // an apply can never resurrect rows a concurrent logout just cleared (I9).
    const tx = db.transaction([CANONICAL, OPERATIONS, META], "readwrite");
    let applied = false;
    const epochReq = tx.objectStore(META).get(EPOCH_KEY);
    epochReq.onsuccess = () => {
      const epoch = (epochReq.result as { value: number } | undefined)?.value ?? 0;
      if (epoch !== this.epoch) {
        // A clear() advanced the epoch since we opened: applying now would resurrect
        // just-cleared (sensitive) rows. Abort — issue NO writes — and end this session.
        this.epoch = epoch;
        this.sessionEnded = true;
        return;
      }
      applied = true;
      const canonical = tx.objectStore(CANONICAL);
      const ops = tx.objectStore(OPERATIONS);
      for (const entry of perRow.values()) {
        const getReq = canonical.get([entry.table, entry.id]);
        getReq.onsuccess = () => {
          let row = (getReq.result as RowValue | undefined) ?? null;
          for (const change of entry.changes) {
            const next = nextCanonicalRow(row, change);
            if (next !== "stale") {
              row = next;
            }
          }
          if (row) {
            canonical.put(row);
          }
        };
      }
      for (const opId of opIds) {
        ops.delete(opId);
      }
    };
    await transactionDone(tx);
    if (applied) {
      this.notify();
    }
  }

  async enqueueOperation(operation: LocalOperation): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(OPERATIONS, "readwrite");
    const store = tx.objectStore(OPERATIONS);
    const existing = await request(store.get(operation.opId));
    if (!existing) {
      store.put(operation);
    }
    await transactionDone(tx);
    if (!existing) {
      this.notify();
    }
  }

  async getPendingOperations(): Promise<readonly LocalOperation[]> {
    const all = await this.getAllOperations();
    return all.filter((operation) => OWED_STATUSES.has(operation.status));
  }

  async getAllOperations(): Promise<readonly LocalOperation[]> {
    const db = await this.db();
    const tx = db.transaction(OPERATIONS, "readonly");
    const all = (await request(tx.objectStore(OPERATIONS).getAll())) as LocalOperation[];
    return all.sort(compareOperations);
  }

  async getOperation(opId: string): Promise<LocalOperation | null> {
    const db = await this.db();
    const tx = db.transaction(OPERATIONS, "readonly");
    return ((await request(tx.objectStore(OPERATIONS).get(opId))) as LocalOperation | undefined) ?? null;
  }

  async updateOperationStatus(opId: string, status: OperationStatus, error?: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(OPERATIONS, "readwrite");
    const store = tx.objectStore(OPERATIONS);
    const current = (await request(store.get(opId))) as LocalOperation | undefined;
    if (current) {
      store.put({ ...current, status, error });
    }
    await transactionDone(tx);
    if (current) {
      this.notify();
    }
  }

  async dropOperation(opId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(OPERATIONS, "readwrite");
    const store = tx.objectStore(OPERATIONS);
    const current = (await request(store.get(opId))) as LocalOperation | undefined;
    if (current) {
      store.delete(opId);
    }
    await transactionDone(tx);
    if (current) {
      this.notify();
    }
  }

  async getCursor(scopeKey: ScopeKey): Promise<Cursor> {
    const db = await this.db();
    const tx = db.transaction(CURSORS, "readonly");
    const row = (await request(tx.objectStore(CURSORS).get(scopeKey))) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  async setCursor(scopeKey: ScopeKey, cursor: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(CURSORS, "readwrite");
    const store = tx.objectStore(CURSORS);
    // Monotonic (I5): read-compare-write in ONE readwrite tx. IndexedDB serializes
    // readwrite txns on the same store, so this is atomic across concurrent pulls;
    // the put is issued inside the get's onsuccess so the tx can't auto-commit
    // between them. A write that would move the cursor backward is dropped.
    const getReq = store.get(scopeKey);
    getReq.onsuccess = () => {
      const existing = getReq.result as { cursor: string } | undefined;
      if (!existing || cursor > existing.cursor) {
        store.put({ scopeKey, cursor });
      }
    };
    await transactionDone(tx);
  }

  async clear(): Promise<void> {
    // Serialize through writeChain so a logout clear cannot land BETWEEN an
    // in-flight apply's read and write and resurrect the just-cleared rows.
    const run = this.writeChain.then(() => this.clearAtomic());
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async clearAtomic(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([CANONICAL, OPERATIONS, CURSORS, META], "readwrite");
    tx.objectStore(CANONICAL).clear();
    tx.objectStore(OPERATIONS).clear();
    tx.objectStore(CURSORS).clear();
    // Bump (NOT clear) the durable epoch in the SAME tx so a concurrent apply — in this
    // tab or another, which reads META in its own serialized tx — sees the advance and
    // aborts instead of resurrecting the just-cleared rows.
    const meta = tx.objectStore(META);
    const getReq = meta.get(EPOCH_KEY);
    getReq.onsuccess = () => {
      const next = ((getReq.result as { value: number } | undefined)?.value ?? 0) + 1;
      meta.put({ key: EPOCH_KEY, value: next });
      this.epoch = next;
    };
    await transactionDone(tx);
    this.sessionEnded = true;
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
}
