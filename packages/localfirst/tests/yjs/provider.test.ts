import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createCollaborativeDoc,
  type DocPersistence,
  type DocUpdateRow,
} from "../../src/yjs/provider.js";
import { base64ToBytes, bytesToBase64 } from "../../src/yjs/yjsSync.js";

// A fake "doc_updates" table that mimics a local-first backend: append inserts an
// insert-only row (optimistic = local durable), prune deletes one, and subscribe pushes
// the row set. Every knob a scenario needs is a plain flag, so the tests read as stories.
function makeTable(docId = "d1") {
  const rows: DocUpdateRow[] = [];
  const listeners = new Set<(rows: readonly DocUpdateRow[]) => void>();
  const appends: string[] = [];
  const prunes: string[] = [];
  let seq = 0;
  const emit = () => {
    const snapshot = rows.slice();
    for (const listener of listeners) listener(snapshot);
  };

  const control = {
    /** Fail the LOCAL stage of the next N appends (e.g. IndexedDB quota). */
    failLocalTimes: 0,
    /** Reject the SERVER stage of every append (used to reject snapshots). */
    rejectServer: false,
    /** Hold the SERVER stage open until `releaseServer()` is called. */
    deferServer: false,
    releaseServer: null as null | (() => void),
  };

  const persistence: DocPersistence = {
    subscribe(onRows) {
      listeners.add(onRows);
      onRows(rows.slice());
      return () => listeners.delete(onRows);
    },
    append(update) {
      appends.push(update);
      if (control.failLocalTimes > 0) {
        control.failLocalTimes--;
        const rejected = Promise.reject(new Error("quota exceeded"));
        rejected.catch(() => {});
        return { local: rejected, server: rejected };
      }
      // A server-rejected write never becomes a durable row (optimistic insert rolled
      // back on rejection) — so the §E2 test asserts on the surviving history directly.
      if (control.rejectServer) {
        const server = Promise.reject(new Error("server rejected snapshot"));
        server.catch(() => {});
        return { local: Promise.resolve({ ok: true }), server };
      }
      const row: DocUpdateRow = { id: `row${seq++}`, doc: docId, update };
      rows.push(row);
      emit();
      const server: Promise<unknown> = control.deferServer
        ? new Promise<void>((resolve) => {
            control.releaseServer = resolve;
          })
        : Promise.resolve({ ok: true });
      return { local: Promise.resolve({ ok: true }), server };
    },
    prune(id) {
      prunes.push(id);
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) {
        rows.splice(index, 1);
        emit();
      }
      return { local: Promise.resolve(), server: Promise.resolve() };
    },
  };

  const seed = (seedRows: readonly DocUpdateRow[]) => {
    for (const row of seedRows) rows.push(row);
    emit();
  };

  return { rows, appends, prunes, persistence, control, docId, seed };
}

const text = (doc: Y.Doc) => doc.getText("t").toString();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A remote update row that inserts `value` into text "t" of a fresh doc. */
function remoteRow(id: string, doc: string, value: string): DocUpdateRow {
  const d = new Y.Doc();
  d.getText("t").insert(0, value);
  return { id, doc, update: bytesToBase64(Y.encodeStateAsUpdate(d)) };
}

describe("createCollaborativeDoc — durability", () => {
  it("persists a local edit through append (base64 update) and reports synced", async () => {
    const table = makeTable();
    const provider = createCollaborativeDoc(table.persistence, { docId: "d1", compaction: false });
    provider.ydoc.getText("t").insert(0, "X");
    expect(provider.status().pendingUpdates).toBeGreaterThan(0);
    await provider.flush();
    expect(table.appends).toHaveLength(1);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, base64ToBytes(table.appends[0]!));
    expect(fresh.getText("t").toString()).toBe("X");
    expect(provider.status()).toMatchObject({ synced: true, pendingUpdates: 0, lastError: null });
    provider.destroy();
  });

  it("retries a failed append and surfaces then clears the error (quota, unmount mid-persist)", async () => {
    const table = makeTable();
    table.control.failLocalTimes = 2;
    const provider = createCollaborativeDoc(table.persistence, { docId: "d1", compaction: false });
    provider.ydoc.getText("t").insert(0, "hello");

    await provider.flush(); // attempt 1 — fails
    expect(provider.status().lastError).toBeInstanceOf(Error);
    expect(provider.status().pendingUpdates).toBeGreaterThan(0);

    await provider.flush(); // attempt 2 — fails
    expect(table.rows).toHaveLength(0); // nothing durable yet

    await provider.flush(); // attempt 3 — succeeds, edit never dropped
    expect(table.appends).toHaveLength(3);
    expect(table.rows).toHaveLength(1);
    expect(provider.status()).toMatchObject({ synced: true, lastError: null });
    provider.destroy();
  });

  it("replays durable local edits on the next mount (interrupted session)", async () => {
    const table = makeTable();
    // Session 1: type, persist durably, then unmount WITHOUT compacting.
    const first = createCollaborativeDoc(table.persistence, { docId: "d1", compaction: false });
    first.ydoc.getText("t").insert(0, "recovered work");
    await first.flush();
    expect(table.rows).toHaveLength(1);
    first.destroy();

    // Session 2: a brand-new doc mounting against the same durable log converges.
    const second = createCollaborativeDoc(table.persistence, { docId: "d1", compaction: false });
    await tick();
    expect(text(second.ydoc)).toBe("recovered work");
    second.destroy();
  });
});

describe("createCollaborativeDoc — docId scoping", () => {
  it("applies only rows for its own document", () => {
    const table = makeTable();
    const provider = createCollaborativeDoc(table.persistence, { docId: "d1", compaction: false });
    provider.ingestRows([
      remoteRow("a", "d1", "mine "),
      remoteRow("b", "d2", "theirs"),
      remoteRow("c", "d1", "too"),
    ]);
    // Order-independent CRDT, but only d1 rows are folded in.
    expect(text(provider.ydoc)).toContain("mine");
    expect(text(provider.ydoc)).toContain("too");
    expect(text(provider.ydoc)).not.toContain("theirs");
    provider.destroy();
  });
});

describe("createCollaborativeDoc — deterministic multi-client convergence", () => {
  it("two clients converge exchanging updates through one shared table", async () => {
    const table = makeTable("shared");
    const a = createCollaborativeDoc(table.persistence, {
      docId: "shared",
      compaction: false,
      flushDebounceMs: 0,
    });
    const b = createCollaborativeDoc(table.persistence, {
      docId: "shared",
      compaction: false,
      flushDebounceMs: 0,
    });

    a.ydoc.getText("t").insert(0, "Hello ");
    await a.flush(); // A's row lands in the shared table → B ingests via subscribe
    b.ydoc.getText("t").insert(text(b.ydoc).length, "World");
    await b.flush();
    // Let both providers see every row.
    await tick();

    expect(text(a.ydoc)).toBe("Hello World");
    expect(text(b.ydoc)).toBe(text(a.ydoc));
    a.destroy();
    b.destroy();
  });
});

describe("createCollaborativeDoc — compaction safety (REVIEW §E2)", () => {
  it("does NOT prune when the snapshot is rejected server-side (no history loss)", async () => {
    const table = makeTable();
    const provider = createCollaborativeDoc(table.persistence, {
      docId: "d1",
      compaction: { everyUpdates: 3, debounceMs: 0 },
    });
    // Three real update rows already in the log.
    table.seed([
      remoteRow("r1", "d1", "a"),
      remoteRow("r2", "d1", "b"),
      remoteRow("r3", "d1", "c"),
    ]);

    table.control.rejectServer = true; // the snapshot write will be rejected
    await provider.compactNow();

    expect(table.prunes).toEqual([]); // CRITICAL: nothing pruned
    expect(table.rows.map((r) => r.id)).toEqual(["r1", "r2", "r3"]); // history intact
    expect(provider.status().lastError).toBeInstanceOf(Error);

    // Recovery: once the snapshot is accepted, compaction completes and prunes.
    table.control.rejectServer = false;
    await provider.compactNow();
    expect(table.prunes.sort()).toEqual(["r1", "r2", "r3"]);
    expect(provider.status().lastError).toBeNull();
    provider.destroy();
  });

  it("prunes ONLY after the snapshot is confirmed server-side (crash-safe ordering)", async () => {
    const table = makeTable();
    const provider = createCollaborativeDoc(table.persistence, {
      docId: "d1",
      compaction: { everyUpdates: 2, debounceMs: 0 },
    });
    table.seed([remoteRow("r1", "d1", "x"), remoteRow("r2", "d1", "y")]);

    table.control.deferServer = true; // hold the snapshot's server confirmation open
    const compaction = provider.compactNow();
    await tick();

    // Snapshot row is written, but its server stage has NOT resolved → no prune yet.
    expect(table.appends).toHaveLength(1);
    expect(table.prunes).toEqual([]);
    expect(provider.status().compacting).toBe(true);

    table.control.releaseServer!(); // server confirms the snapshot
    await compaction;
    expect(table.prunes.sort()).toEqual(["r1", "r2"]); // NOW the subsumed rows are pruned
    provider.destroy();
  });

  it("compacts automatically once the row-count cadence is crossed", async () => {
    const table = makeTable();
    const provider = createCollaborativeDoc(table.persistence, {
      docId: "d1",
      compaction: { everyUpdates: 3, debounceMs: 0 },
    });
    table.seed([
      remoteRow("r1", "d1", "1"),
      remoteRow("r2", "d1", "2"),
      remoteRow("r3", "d1", "3"),
    ]);
    await tick(); // debounced auto-compaction fires

    expect(table.appends).toHaveLength(1); // one snapshot written
    expect(table.prunes.sort()).toEqual(["r1", "r2", "r3"]); // originals subsumed
    expect(table.rows).toHaveLength(1); // only the snapshot remains

    // The surviving snapshot reproduces the full document on a cold client.
    const cold = new Y.Doc();
    Y.applyUpdate(cold, base64ToBytes(table.rows[0]!.update));
    expect(cold.getText("t").toString().split("").sort().join("")).toBe("123");
    provider.destroy();
  });

  it("a concurrent edit arriving mid-compaction is not pruned or lost", async () => {
    const table = makeTable();
    const provider = createCollaborativeDoc(table.persistence, {
      docId: "d1",
      compaction: { everyUpdates: 2, debounceMs: 0 },
    });
    table.seed([remoteRow("r1", "d1", "base ")]);

    table.control.deferServer = true;
    const compaction = provider.compactNow();
    await tick();
    // A new row arrives AFTER the snapshot was captured (not in the subsumed set).
    table.seed([remoteRow("late", "d1", "late-edit")]);

    table.control.releaseServer!();
    await compaction;

    expect(table.prunes).toContain("r1");
    expect(table.prunes).not.toContain("late"); // the concurrent row survived
    provider.destroy();
  });
});
