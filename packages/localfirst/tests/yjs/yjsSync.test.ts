import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  REMOTE_ORIGIN,
  applyUpdateSafe,
  base64ToBytes,
  bytesToBase64,
  makeSnapshot,
} from "../../src/yjs/yjsSync.js";

// Proves the whole premise of doc_updates: a Yjs CRDT carried as insert-only
// base64 rows converges no matter the delivery order, duplication, or concurrency
// — so our append-only log needs zero conflict handling for rich-text editing.

const text = (doc: Y.Doc) => doc.getText("t").toString();

// A client backed by the shared row list (our insert-only doc_updates), using the
// exact codec + REMOTE_ORIGIN echo-guard the real hook uses.
function makeClient(rows: string[]) {
  const doc = new Y.Doc();
  const applied = new Set<number>();
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return; // local edit -> a new row
    rows.push(bytesToBase64(u));
  });
  const sync = () => {
    rows.forEach((r, i) => {
      if (applied.has(i)) return;
      applied.add(i);
      Y.applyUpdate(doc, base64ToBytes(r), REMOTE_ORIGIN);
    });
  };
  return { doc, sync };
}

describe("Yjs over insert-only rows", () => {
  it("round-trips a binary update through the base64 codec", () => {
    const a = new Y.Doc();
    a.getText("t").insert(0, "héllo 🌍");
    const update = Y.encodeStateAsUpdate(a);
    const b = new Y.Doc();
    Y.applyUpdate(b, base64ToBytes(bytesToBase64(update)));
    expect(text(b)).toBe("héllo 🌍");
  });

  it("two clients merge each other's edits", () => {
    const rows: string[] = [];
    const A = makeClient(rows);
    const B = makeClient(rows);
    A.doc.getText("t").insert(0, "Hello ");
    B.sync();
    B.doc.getText("t").insert(text(B.doc).length, "World");
    A.sync();
    B.sync();
    expect(text(A.doc)).toBe("Hello World");
    expect(text(B.doc)).toBe(text(A.doc));
  });

  it("a fresh client converges under out-of-order + duplicate delivery", () => {
    const rows: string[] = [];
    const A = makeClient(rows);
    A.doc.getText("t").insert(0, "abc");
    A.doc.getText("t").insert(3, "def"); // rows = [insert abc, insert def]
    const C = new Y.Doc();
    for (const r of [rows[1]!, rows[0]!, rows[1]!, rows[0]!]) {
      Y.applyUpdate(C, base64ToBytes(r)); // shuffled + duplicated
    }
    expect(C.getText("t").toString()).toBe("abcdef");
  });

  it("merges concurrent edits with no overwrite (the LWW problem solved)", () => {
    const rows: string[] = [];
    const A = makeClient(rows);
    A.doc.getText("t").insert(0, "X");
    const B = makeClient(rows);
    B.sync(); // B now has "X"
    // Concurrent edits before either syncs:
    A.doc.getText("t").insert(1, "A");
    B.doc.getText("t").insert(0, "B");
    A.sync();
    B.sync();
    A.sync();
    expect(text(A.doc)).toBe(text(B.doc)); // converged + deterministic
    expect(text(A.doc).length).toBe(3); // both edits survive — no last-writer-wins loss
    expect(text(A.doc).split("").sort().join("")).toBe("ABX");
  });
});

// Compaction: replace many update rows with one snapshot row + prune the rest, so
// a doc's cold load stays bounded. Must preserve content AND stay convergent with
// updates that were concurrent with / arrive after the compaction.
describe("doc_updates compaction (snapshot + prune)", () => {
  type Row = { id: string; update: string };

  it("makeSnapshot reproduces the full doc on a fresh client", () => {
    const a = new Y.Doc();
    a.getText("t").insert(0, "the quick brown fox");
    const b = new Y.Doc();
    Y.applyUpdate(b, base64ToBytes(makeSnapshot(a)));
    expect(text(b)).toBe("the quick brown fox");
  });

  it("a snapshot subsumes the rows it folds in (cold load from snapshot alone)", () => {
    // One editor makes many small edits → many rows.
    const rows: Row[] = [];
    const A = new Y.Doc();
    let n = 0;
    A.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE_ORIGIN) rows.push({ id: "r" + n++, update: bytesToBase64(u) });
    });
    for (let i = 0; i < 12; i++) A.getText("t").insert(text(A).length, String(i % 10));
    expect(rows.length).toBeGreaterThan(1);

    // Compact: snapshot + drop every row it subsumed.
    const subsumed = new Set(rows.map((r) => r.id));
    const compacted: Row[] = [
      ...rows.filter((r) => !subsumed.has(r.id)),
      { id: "snap", update: makeSnapshot(A) },
    ];
    expect(compacted.length).toBe(1); // only the snapshot remains

    // A fresh device that ONLY ever sees the compacted rows gets identical content.
    const fresh = new Y.Doc();
    for (const r of compacted) Y.applyUpdate(fresh, base64ToBytes(r.update));
    expect(text(fresh)).toBe(text(A));
  });

  it("an update concurrent with compaction is not lost", () => {
    // A and B share some history.
    const rows: Row[] = [];
    let n = 0;
    const push = (u: Uint8Array) => rows.push({ id: "r" + n++, update: bytesToBase64(u) });
    const A = new Y.Doc();
    A.on("update", (u: Uint8Array, o: unknown) => o !== REMOTE_ORIGIN && push(u));
    A.getText("t").insert(0, "base ");
    const B = new Y.Doc();
    for (const r of rows) Y.applyUpdate(B, base64ToBytes(r.update), REMOTE_ORIGIN); // B caught up

    // CONCURRENTLY: B edits (offline-ish, not yet shared) while A compacts without
    // having seen B's edit.
    let bRow: Row | null = null;
    B.on("update", (u: Uint8Array, o: unknown) => {
      if (o !== REMOTE_ORIGIN) bRow = { id: "b0", update: bytesToBase64(u) };
    });
    B.getText("t").insert(text(B).length, "fromB");
    const snapshotRow: Row = { id: "snap", update: makeSnapshot(A) }; // A's snapshot lacks B's edit

    // Everyone converges from {snapshot} + {B's concurrent update}, any order.
    const merge = (rowsIn: Row[]) => {
      const d = new Y.Doc();
      for (const r of rowsIn) Y.applyUpdate(d, base64ToBytes(r.update));
      return text(d);
    };
    const withB = [snapshotRow, bRow!];
    expect(merge(withB)).toContain("base");
    expect(merge(withB)).toContain("fromB"); // B's concurrent edit survived compaction
    expect(merge([...withB].reverse())).toBe(merge(withB)); // order-independent
  });

  it("a corrupt update row is skipped, not fatal — good content still loads", () => {
    const a = new Y.Doc();
    a.getText("t").insert(0, "good content");
    const good = makeSnapshot(a);
    const b = new Y.Doc();
    // Bad base64 (invalid chars) and valid-base64-but-garbage-Yjs both return false
    // instead of throwing, so one bad row can't brick the document.
    expect(applyUpdateSafe(b, "!!! not base64 !!!", undefined)).toBe(false);
    expect(applyUpdateSafe(b, bytesToBase64(new Uint8Array([9, 9, 9, 9, 9, 9])), undefined)).toBe(
      false,
    );
    expect(applyUpdateSafe(b, good, undefined)).toBe(true);
    expect(b.getText("t").toString()).toBe("good content");
  });

  it("two clients compacting concurrently converge (overlapping snapshots are safe)", () => {
    const base: Row[] = [];
    let n = 0;
    const A = new Y.Doc();
    A.on(
      "update",
      (u: Uint8Array, o: unknown) =>
        o !== REMOTE_ORIGIN && base.push({ id: "a" + n++, update: bytesToBase64(u) }),
    );
    A.getText("t").insert(0, "shared ");

    // B catches up to A's history, then makes one concurrent edit A hasn't seen.
    const B = new Y.Doc();
    for (const r of base) Y.applyUpdate(B, base64ToBytes(r.update), REMOTE_ORIGIN);
    let bExtra: Row | null = null;
    B.on("update", (u: Uint8Array, o: unknown) => {
      if (o !== REMOTE_ORIGIN) bExtra = { id: "bx", update: bytesToBase64(u) };
    });
    B.getText("t").insert(text(B).length, "B-edit");

    // BOTH compact independently (each writes its own snapshot; both prune the
    // shared base rows — overlapping deletes are fine). A's snapshot lacks B-edit;
    // B's includes it. The surviving log is {snapA, snapB, bExtra}.
    const snapA: Row = { id: "snapA", update: makeSnapshot(A) };
    const snapB: Row = { id: "snapB", update: makeSnapshot(B) };
    const merge = (rowsIn: Row[]) => {
      const d = new Y.Doc();
      for (const r of rowsIn) Y.applyUpdate(d, base64ToBytes(r.update));
      return text(d);
    };
    const all = [snapA, snapB, bExtra!];
    const result = merge(all);
    expect(result).toContain("shared");
    expect(result).toContain("B-edit"); // nothing lost despite two concurrent compactions
    expect(merge([...all].reverse())).toBe(result); // deterministic regardless of order
  });
});
