import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { useCollaborativeDoc, type CollaborativeDocRow } from "../../src/yjs/useCollaborativeDoc.js";
import { base64ToBytes, bytesToBase64 } from "../../src/yjs/yjsSync.js";

// The codec/convergence is proven in yjsSync.test.ts. These tests cover the HOOK's
// backend-agnostic parameterization: it applies the rows you pass, appends local
// edits through your callback, and compacts via your prune callback.

const remoteRow = (id: string, text: string): CollaborativeDocRow => {
  const d = new Y.Doc();
  d.getText("t").insert(0, text);
  return { _id: id, update: bytesToBase64(Y.encodeStateAsUpdate(d)) };
};

describe("useCollaborativeDoc (backend-agnostic wiring)", () => {
  it("hydrates the Y.Doc from the rows you pass (any source)", () => {
    const append = vi.fn();
    const { result, rerender } = renderHook((props) => useCollaborativeDoc(props), {
      initialProps: { docId: "d1", updates: [] as CollaborativeDocRow[], append }
    });
    expect(result.current.getText("t").toString()).toBe("");
    act(() => rerender({ docId: "d1", updates: [remoteRow("r1", "hello")], append }));
    expect(result.current.getText("t").toString()).toBe("hello");
    // Applying a remote row must NOT echo back as a new append (REMOTE_ORIGIN guard).
    expect(append).not.toHaveBeenCalled();
  });

  it("persists a local edit through `append` (as a base64 update), not echoing remote ones", () => {
    const append = vi.fn();
    const { result } = renderHook(() => useCollaborativeDoc({ docId: "d2", updates: [], append }));
    act(() => {
      result.current.getText("t").insert(0, "X");
    });
    expect(append).toHaveBeenCalledTimes(1);
    const arg = append.mock.calls[0]![0] as string;
    expect(typeof arg).toBe("string");
    // The appended update is a real Yjs update (reproduces the edit on a fresh doc).
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, base64ToBytes(arg));
    expect(fresh.getText("t").toString()).toBe("X");
  });

  it("compacts once the row count crosses the threshold: snapshot appended + subsumed rows pruned", async () => {
    const append = vi.fn(async () => {});
    const prune = vi.fn(async () => {});
    const rows = [remoteRow("r1", "a"), remoteRow("r2", "b"), remoteRow("r3", "c")];
    renderHook(() =>
      useCollaborativeDoc({ docId: "d3", updates: rows, append, prune, compactThreshold: 2 })
    );
    await waitFor(() => expect(append).toHaveBeenCalledTimes(1)); // the snapshot row
    expect(prune).toHaveBeenCalledTimes(3); // every subsumed row removed
    expect(new Set(prune.mock.calls.map((c) => c[0]))).toEqual(new Set(["r1", "r2", "r3"]));
  });

  it("does not compact without a prune callback (log grows unbounded by choice)", async () => {
    const append = vi.fn(async () => {});
    const rows = [remoteRow("r1", "a"), remoteRow("r2", "b"), remoteRow("r3", "c")];
    renderHook(() => useCollaborativeDoc({ docId: "d4", updates: rows, append, compactThreshold: 2 }));
    // Give any stray effect a tick; append must stay at 0 (no snapshot written).
    await new Promise((r) => setTimeout(r, 20));
    expect(append).not.toHaveBeenCalled();
  });
});
