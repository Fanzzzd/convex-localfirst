import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexedDbStore, MemoryLocalStore, type LocalOperation, type ServerChange } from "../src";
import { INDEXED_DB_SCHEMA_VERSION, openLocalFirstDb } from "../src/internal";

// Fresh IndexedDB per test for isolation.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

const op = (over: Partial<LocalOperation> & Pick<LocalOperation, "opId">): LocalOperation => ({
  clientId: "c",
  userId: "user_a",
  schemaVersion: 1,
  functionName: "todos:create",
  table: "todos",
  kind: "insert",
  id: "t1",
  args: {},
  value: { listId: "inbox", text: "hi", done: false },
  createdAt: 1,
  status: "pending",
  ...over
});

const insertChange = (id: string, version: number, value: Record<string, unknown>, opId?: string): ServerChange => ({
  changeId: `chg_${id}_${version}`,
  scopeKey: "user:user_a",
  table: "todos",
  id,
  kind: "insert",
  value,
  version,
  serverTime: version,
  opId
});

describe("IndexedDbStore", () => {
  it("derives the live view from canonical + pending (round-trips an insert)", async () => {
    const store = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    await store.enqueueOperation(op({ opId: "o1", id: "t1" }));
    const rows = await store.getRows("todos");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("hi");
  });

  it("a closed tab's pending op is recovered by a new store over the same db", async () => {
    const first = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    await first.enqueueOperation(op({ opId: "o1", id: "t1", value: { listId: "inbox", text: "persist" } }));
    (await first._database()).close();

    const second = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    expect((await second.getPendingOperations()).length).toBe(1);
    expect((await second.getRows("todos"))[0]?.text).toBe("persist");
  });

  it("logout clears the user namespace", async () => {
    const store = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    await store.enqueueOperation(op({ opId: "o1", id: "t1" }));
    await store.applyServerChange(insertChange("t1", 1, { listId: "inbox", text: "hi" }, "o1"));
    expect((await store.getCanonicalRows("todos")).length).toBe(1);

    await store.clear();
    expect((await store.getCanonicalRows("todos")).length).toBe(0);
    expect((await store.getAllOperations()).length).toBe(0);
  });

  it("two namespaces are isolated", async () => {
    const a = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    const b = new IndexedDbStore({ databaseName: "lf", namespace: "user_b" });
    await a.enqueueOperation(op({ opId: "o1", id: "t1" }));
    expect((await a.getRows("todos")).length).toBe(1);
    expect((await b.getRows("todos")).length).toBe(0);
  });

  it("migrates from v1 to v2 (adds the by_table index, preserves data)", async () => {
    // Open a v1 database directly (no by_table index).
    const v1 = await openLocalFirstDb("lf:user_a", 1);
    await new Promise<void>((resolve, reject) => {
      const tx = v1.transaction("canonical", "readwrite");
      tx.objectStore("canonical").put({ _table: "todos", _id: "t1", text: "from-v1", _version: 1, _deleted: false });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    expect(v1.version).toBe(1);
    v1.close();

    // Reopen through the store, which upgrades to the current schema version.
    const store = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    const db = await store._database();
    expect(db.version).toBe(INDEXED_DB_SCHEMA_VERSION);
    expect(db.transaction("canonical", "readonly").objectStore("canonical").indexNames.contains("by_table")).toBe(true);

    // Data written under v1 survives and is now queryable via the v2 index.
    const rows = await store.getCanonicalRows("todos");
    expect(rows[0]?.text).toBe("from-v1");
  });

  it("reports a blocked upgrade when another connection holds the db open", async () => {
    // Hold a v1 connection open WITHOUT a versionchange handler, so it blocks.
    const blocker = await openLocalFirstDb("lf:user_a", 1);

    let blocked = false;
    const upgraded = openLocalFirstDb("lf:user_a", INDEXED_DB_SCHEMA_VERSION, {
      onBlocked: () => {
        blocked = true;
      }
    });

    // Wait (deterministically) for the blocked event to fire, then release.
    for (let i = 0; i < 100 && !blocked; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(blocked).toBe(true);

    blocker.close();
    const db = await upgraded;
    expect(db.version).toBe(INDEXED_DB_SCHEMA_VERSION);
    db.close();
  });

  it("rolls back an aborted transaction (no partial writes persist)", async () => {
    const store = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    const db = await store._database();

    // Write inside a transaction, then abort it.
    await new Promise<void>((resolve) => {
      const tx = db.transaction("canonical", "readwrite");
      tx.objectStore("canonical").put({ _table: "todos", _id: "rollback", text: "should-not-persist", _version: 1 });
      tx.onabort = () => resolve();
      tx.abort();
    });

    expect((await store.getCanonicalRows("todos")).length).toBe(0);
  });
});

describe("applyServerChanges (batched apply)", () => {
  it("MemoryLocalStore: one notify for the whole batch, all changes applied", async () => {
    const store = new MemoryLocalStore();
    let notifies = 0;
    store.subscribe(() => notifies++);
    await store.applyServerChanges([
      insertChange("a", 1, { listId: "inbox", text: "A" }),
      insertChange("b", 1, { listId: "inbox", text: "B" }),
      insertChange("c", 1, { listId: "inbox", text: "C" })
    ]);
    expect(notifies).toBe(1); // NOT 3 — the whole point (cold pulls stay O(rows), not O(N×rows))
    expect((await store.getCanonicalRows("todos")).length).toBe(3);
  });

  it("MemoryLocalStore: chains repeated changes to the same row in order", async () => {
    const store = new MemoryLocalStore();
    await store.applyServerChanges([
      insertChange("t1", 1, { listId: "inbox", text: "v1" }),
      insertChange("t1", 2, { listId: "inbox", text: "v2" }),
      insertChange("t1", 1, { listId: "inbox", text: "stale" }) // older version is ignored (I5)
    ]);
    const rows = await store.getCanonicalRows("todos");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("v2");
  });

  it("IndexedDbStore: one notify, all applied, repeated-row chaining in one tx", async () => {
    const store = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    let notifies = 0;
    store.subscribe(() => notifies++);
    await store.applyServerChanges([
      insertChange("a", 1, { listId: "inbox", text: "A" }),
      insertChange("b", 1, { listId: "inbox", text: "B" }),
      insertChange("a", 2, { listId: "inbox", text: "A2" }) // same row, newer version wins
    ]);
    expect(notifies).toBe(1);
    const rows = await store.getCanonicalRows("todos");
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r._id === "a")?.text).toBe("A2");
  });

  // I5: the live view derives from canonical, so a regressed canonical row is a
  // silent data-loss bug. Reactive watches + mounted hooks make concurrent pulls
  // of the same scope common; applyServerChanges must serialize its read-compare-
  // write so an older version cannot overwrite a newer one read from the same base.
  it("IndexedDbStore: concurrent applies converge to the newest version (no stale regression)", async () => {
    const store = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    await store.applyServerChanges([insertChange("t1", 1, { listId: "inbox", text: "v1" })]);
    // Both pulls start from the v1 read; the older (v2) must not clobber the newer (v3).
    await Promise.all([
      store.applyServerChanges([insertChange("t1", 3, { listId: "inbox", text: "v3" })]),
      store.applyServerChanges([insertChange("t1", 2, { listId: "inbox", text: "v2" })])
    ]);
    const rows = await store.getCanonicalRows("todos");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("v3");
  });

  // The in-process lock only serializes ONE instance. Two tabs = two IndexedDbStore
  // instances over the SAME database, so cross-tab safety must come from the atomic
  // readwrite tx itself (IndexedDB serializes overlapping readwrite txns across
  // connections). Without it, tab B could read v1 and write a stale v2 after tab A's v3.
  it("IndexedDbStore: two stores over the same DB converge to the newest version (cross-tab)", async () => {
    const tabA = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    const tabB = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    await tabA.applyServerChanges([insertChange("t1", 1, { listId: "inbox", text: "v1" })]);
    // Concurrent applies from two SEPARATE store instances (two tabs) over the same DB.
    await Promise.all([
      tabA.applyServerChanges([insertChange("t1", 3, { listId: "inbox", text: "v3" })]),
      tabB.applyServerChanges([insertChange("t1", 2, { listId: "inbox", text: "v2" })])
    ]);
    // Re-read through a fresh store to bypass any per-instance caching.
    const reader = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    const rows = await reader.getCanonicalRows("todos");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("v3"); // newest version wins; no stale regression
  });

  // I9/logout: a clear() must not land between an in-flight apply's read and write
  // and resurrect the just-cleared rows. clear() is serialized through the same
  // write queue, so an apply started before it always completes first and is then wiped.
  it("IndexedDbStore: a logout clear() does not interleave with an in-flight apply (no resurrection)", async () => {
    const store = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    await store.applyServerChanges([insertChange("t0", 1, { listId: "inbox", text: "old" })]);
    // Start an apply, then immediately log out — both queued; clear must win.
    const applying = store.applyServerChanges([insertChange("t1", 1, { listId: "inbox", text: "new" })]);
    const clearing = store.clear();
    await Promise.all([applying, clearing]);
    expect(await store.getCanonicalRows("todos")).toHaveLength(0); // nothing resurrected
    expect(await store.getPendingOperations()).toHaveLength(0);
  });

  // I9 cross-tab: the in-tab writeChain only serializes ONE instance. Two tabs are two
  // instances over the same DB, so a clear() in tab A must still block tab B's later
  // apply — enforced by the durable epoch read inside B's atomic apply tx.
  it("IndexedDbStore: another tab's later apply cannot resurrect a logged-out namespace (epoch guard)", async () => {
    const a = new IndexedDbStore({ databaseName: "lf_epoch", namespace: "user_a" });
    const b = new IndexedDbStore({ databaseName: "lf_epoch", namespace: "user_a" });
    await a.applyServerChanges([insertChange("t0", 1, { listId: "inbox", text: "secret" })]);
    await b.getCanonicalRows("todos"); // b opens + captures the pre-logout epoch
    await a.clear(); // tab A logs out: wipes + bumps the durable epoch
    // tab B, unaware, applies an in-flight server change that arrived after the clear.
    await b.applyServerChanges([insertChange("t1", 1, { listId: "inbox", text: "leak" })]);
    expect(await b.getCanonicalRows("todos")).toHaveLength(0); // not resurrected
    expect(await a.getCanonicalRows("todos")).toHaveLength(0);
  });

  it("applyServerChanges([]) is a no-op (no notify)", async () => {
    const store = new MemoryLocalStore();
    let notifies = 0;
    store.subscribe(() => notifies++);
    await store.applyServerChanges([]);
    expect(notifies).toBe(0);
  });
});

// I5: cursors only advance. Concurrent same-scope pulls (mounted hooks + the reactive
// watch) can resolve out of order; a backward setCursor must be ignored or the client
// re-delivers already-applied changes and the reactive resubscribe window thrashes.
describe("setCursor monotonicity", () => {
  it("MemoryLocalStore: a backward cursor write is ignored", async () => {
    const store = new MemoryLocalStore();
    await store.setCursor("s", "000000000005");
    await store.setCursor("s", "000000000002"); // stale pull resolves late
    expect(await store.getCursor("s")).toBe("000000000005");
    await store.setCursor("s", "000000000009"); // a real advance still applies
    expect(await store.getCursor("s")).toBe("000000000009");
  });

  it("IndexedDbStore: a backward cursor write is ignored (atomic read-compare-write)", async () => {
    const store = new IndexedDbStore({ databaseName: "lf", namespace: "user_a" });
    await store.setCursor("s", "000000000005");
    await store.setCursor("s", "000000000002");
    expect(await store.getCursor("s")).toBe("000000000005");
    // Concurrent writes (both started before either resolved) still converge to the max.
    await Promise.all([store.setCursor("s", "000000000004"), store.setCursor("s", "000000000007")]);
    expect(await store.getCursor("s")).toBe("000000000007");
  });
});
