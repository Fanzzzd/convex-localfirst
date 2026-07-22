import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { useCollaborativeDoc } from "../../src/yjs/useCollaborativeDoc.js";
import { base64ToBytes, bytesToBase64 } from "../../src/yjs/yjsSync.js";

// The provider's guarantees are proven headless in provider.test.ts. These cover the
// HOOK wiring: it maps raw rows via field accessors, filters to one docId, appends local
// edits through your callback, compacts via prune, and surfaces `status`.

type Row = { _id: string; doc: string; update: string };

const remoteRow = (id: string, doc: string, text: string): Row => {
  const d = new Y.Doc();
  d.getText("t").insert(0, text);
  return { _id: id, doc, update: bytesToBase64(Y.encodeStateAsUpdate(d)) };
};

describe("useCollaborativeDoc (React wiring)", () => {
  it("hydrates the Y.Doc from rows scoped to its docId, ignoring other docs", () => {
    const append = vi.fn();
    const { result, rerender } = renderHook((props) => useCollaborativeDoc(props), {
      initialProps: { docId: "d1", updates: [] as Row[], append },
    });
    expect(result.current.doc.getText("t").toString()).toBe("");
    act(() =>
      rerender({
        docId: "d1",
        updates: [remoteRow("r1", "d1", "hello"), remoteRow("r2", "d2", "OTHER")],
        append,
      }),
    );
    expect(result.current.doc.getText("t").toString()).toBe("hello"); // d2 row filtered out
    // Applying remote rows must NOT echo back as appends (REMOTE_ORIGIN guard).
    expect(append).not.toHaveBeenCalled();
  });

  it("persists a local edit through `append` as a real base64 update", async () => {
    const append = vi.fn(async () => ({ ok: true }));
    const { result } = renderHook(() =>
      useCollaborativeDoc({ docId: "d2", updates: [] as Row[], append }),
    );
    act(() => {
      result.current.doc.getText("t").insert(0, "X");
    });
    await waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    const arg = append.mock.calls[0]![0] as string;
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, base64ToBytes(arg));
    expect(fresh.getText("t").toString()).toBe("X");
    await waitFor(() => expect(result.current.status.synced).toBe(true));
  });

  it("surfaces append failures through status.lastError, then clears on success", async () => {
    let fail = true;
    const append = vi.fn(() =>
      fail ? Promise.reject(new Error("quota")) : Promise.resolve({ ok: true }),
    );
    const { result } = renderHook(() =>
      useCollaborativeDoc({ docId: "d5", updates: [] as Row[], append, backoffMs: () => 5 }),
    );
    act(() => {
      result.current.doc.getText("t").insert(0, "Y");
    });
    await waitFor(() => expect(result.current.status.lastError).toBeInstanceOf(Error));
    fail = false;
    await waitFor(() => expect(result.current.status.lastError).toBeNull());
    await waitFor(() => expect(result.current.status.synced).toBe(true));
  });

  it("compacts once the threshold is crossed: snapshot appended + subsumed rows pruned", async () => {
    const append = vi.fn(async () => ({ ok: true }));
    const prune = vi.fn(async () => ({ ok: true }));
    const rows = [
      remoteRow("r1", "d3", "a"),
      remoteRow("r2", "d3", "b"),
      remoteRow("r3", "d3", "c"),
    ];
    renderHook(() =>
      useCollaborativeDoc({
        docId: "d3",
        updates: rows,
        append,
        prune,
        compaction: { everyUpdates: 2, debounceMs: 0 },
      }),
    );
    await waitFor(() => expect(append).toHaveBeenCalledTimes(1)); // the snapshot row
    await waitFor(() => expect(prune).toHaveBeenCalledTimes(3)); // every subsumed row removed
    expect(new Set(prune.mock.calls.map((c) => c[0]))).toEqual(new Set(["r1", "r2", "r3"]));
  });

  it("does not compact without a prune callback (log grows unbounded by choice)", async () => {
    const append = vi.fn(async () => ({ ok: true }));
    const rows = [
      remoteRow("r1", "d4", "a"),
      remoteRow("r2", "d4", "b"),
      remoteRow("r3", "d4", "c"),
    ];
    renderHook(() =>
      useCollaborativeDoc({
        docId: "d4",
        updates: rows,
        append,
        compaction: { everyUpdates: 2, debounceMs: 0 },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(append).not.toHaveBeenCalled();
  });
});
