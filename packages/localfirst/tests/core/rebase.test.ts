import { describe, expect, it } from "vitest";
import type { LocalOperation, RowValue, ServerChange } from "../../src/core";
import { compareOperations, rebaseAndReplay } from "../../src/core/internal";

const op = (
  over: Partial<LocalOperation> & Pick<LocalOperation, "opId" | "kind">,
): LocalOperation => ({
  clientId: "c",
  userId: "u",
  schemaVersion: 1,
  functionName: "fn",
  table: "todos",
  id: "t1",
  args: {},
  createdAt: 0,
  status: "pending",
  ...over,
});

describe("rebaseAndReplay", () => {
  it("applies server changes then replays pending local ops on top", () => {
    const canonical: RowValue[] = [
      { _id: "t1", _table: "todos", text: "orig", title: "a", done: false, _version: 1 },
    ];
    const serverChanges: ServerChange[] = [
      {
        changeId: "c1",
        scopeKey: "s",
        table: "todos",
        id: "t1",
        kind: "patch",
        patch: { title: "server" },
        version: 2,
        serverTime: 2,
      },
    ];
    const pending = [op({ opId: "o1", kind: "patch", patch: { done: true } })];

    const { rows, conflicts } = rebaseAndReplay({
      canonicalRows: canonical,
      serverChanges,
      pendingOperations: pending,
    });
    const row = rows.find((candidate) => candidate._id === "t1");

    expect(conflicts).toHaveLength(0);
    expect(row?.title).toBe("server"); // server change folded in
    expect(row?.done).toBe(true); // local op replayed after, wins on its field
  });

  it("reports a conflict when a pending patch targets a missing row", () => {
    const pending = [op({ opId: "o1", kind: "patch", id: "ghost", patch: { done: true } })];
    const { conflicts } = rebaseAndReplay({
      canonicalRows: [],
      serverChanges: [],
      pendingOperations: pending,
    });
    expect(conflicts).toEqual([{ opId: "o1", message: expect.stringContaining("missing row") }]);
  });
});

describe("compareOperations", () => {
  it("orders by createdAt then opId, deterministically across shuffles", () => {
    const a = op({ opId: "a", kind: "patch", createdAt: 1 });
    const b = op({ opId: "b", kind: "patch", createdAt: 1 });
    const c = op({ opId: "c", kind: "patch", createdAt: 2 });

    const order1 = [c, a, b]
      .slice()
      .sort(compareOperations)
      .map((entry) => entry.opId);
    const order2 = [b, c, a]
      .slice()
      .sort(compareOperations)
      .map((entry) => entry.opId);

    expect(order1).toEqual(["a", "b", "c"]);
    expect(order2).toEqual(["a", "b", "c"]);
  });
});
