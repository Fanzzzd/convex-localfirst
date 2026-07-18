import { describe, expect, it } from "vitest";
import {
  applyCounterDelta,
  applySetDelta,
  computeCounterDelta,
  computeSetDelta,
  isCounterDelta,
  isSetDelta,
  mergePatch
} from "../src/setMerge.js";

describe("set-field merge primitives", () => {
  it("computeSetDelta diffs new vs current as a set (adds + removes, order-insensitive)", () => {
    expect(computeSetDelta(["a", "b"], ["b", "a", "c"])).toEqual({ add: ["c"], remove: [] });
    expect(computeSetDelta(["a", "b"], ["a"])).toEqual({ add: [], remove: ["b"] });
    expect(computeSetDelta(["a", "b"], ["b", "c"])).toEqual({ add: ["c"], remove: ["a"] });
    expect(computeSetDelta(undefined, ["x"])).toEqual({ add: ["x"], remove: [] }); // first set on an absent field
    expect(computeSetDelta(["a"], ["a"])).toEqual({ add: [], remove: [] }); // no-op
  });

  it("applySetDelta keeps order, drops removes, appends new adds, idempotent", () => {
    expect(applySetDelta(["a", "b"], { add: ["c"], remove: [] })).toEqual(["a", "b", "c"]);
    expect(applySetDelta(["a", "b"], { add: [], remove: ["a"] })).toEqual(["b"]);
    expect(applySetDelta(["a", "b"], { add: ["b"], remove: [] })).toEqual(["a", "b"]); // add already-present = no dupe
    expect(applySetDelta(undefined, { add: ["x"], remove: [] })).toEqual(["x"]);
    // idempotent: applying the same delta twice == once (at-least-once delivery safe)
    const once = applySetDelta(["a"], { add: ["b"], remove: [] });
    expect(applySetDelta(once, { add: ["b"], remove: [] })).toEqual(once);
  });

  it("CONVERGES on concurrent adds to different elements (the data-loss case it fixes)", () => {
    // Both clients start from ["x"]; A adds "a", B adds "b" (deltas vs their shared base).
    const base = ["x"];
    const deltaA = computeSetDelta(base, ["x", "a"]);
    const deltaB = computeSetDelta(base, ["x", "b"]);
    // Server canonical ["x"] applies A then B (push order) — both survive, no clobber.
    const afterA = applySetDelta(base, deltaA);
    const afterAB = applySetDelta(afterA, deltaB);
    expect(afterAB.sort()).toEqual(["a", "b", "x"]);
    // Order-independent: B then A converges to the same set.
    const afterBA = applySetDelta(applySetDelta(base, deltaB), deltaA);
    expect(afterBA.sort()).toEqual(["a", "b", "x"]);
  });

  it("isSetDelta only matches the wrapper shape", () => {
    expect(isSetDelta({ __lfSet: { add: [], remove: [] } })).toBe(true);
    expect(isSetDelta(["a"])).toBe(false);
    expect(isSetDelta(null)).toBe(false);
    expect(isSetDelta("x")).toBe(false);
    expect(isSetDelta({ add: [], remove: [] })).toBe(false);
  });

  it("mergePatch set-merges SetDelta fields and LWW-overwrites the rest", () => {
    const row = { _id: "1", title: "old", label_ids: ["a", "b"] };
    const patched = mergePatch(row, {
      title: "new", // plain field → overwrite
      label_ids: { __lfSet: { add: ["c"], remove: ["a"] } } // set field → merge
    });
    expect(patched).toEqual({ _id: "1", title: "new", label_ids: ["b", "c"] });
  });
});

describe("counter-field merge primitives", () => {
  it("computeCounterDelta diffs new vs current as a numeric delta (absent/non-number = 0)", () => {
    expect(computeCounterDelta(3, 5)).toBe(2);
    expect(computeCounterDelta(5, 4)).toBe(-1);
    expect(computeCounterDelta(undefined, 7)).toBe(7); // first set on an absent field
    expect(computeCounterDelta(null, 2)).toBe(2);
    expect(computeCounterDelta(3, 3)).toBe(0); // no-op
  });

  it("applyCounterDelta adds the delta (absent/non-number current = 0), commutative + associative", () => {
    expect(applyCounterDelta(3, 2)).toBe(5);
    expect(applyCounterDelta(5, -1)).toBe(4);
    expect(applyCounterDelta(undefined, 7)).toBe(7);
    // order-independent: (base +a) +b == (base +b) +a
    expect(applyCounterDelta(applyCounterDelta(3, 2), 1)).toBe(applyCounterDelta(applyCounterDelta(3, 1), 2));
  });

  it("CONVERGES on concurrent increments (the data-loss case it fixes)", () => {
    // Both clients start from 3; A sets 5 (intent +2), B sets 4 (intent +1) — deltas vs base.
    const base = 3;
    const deltaA = computeCounterDelta(base, 5); // +2
    const deltaB = computeCounterDelta(base, 4); // +1
    // Server canonical 3 applies A then B (push order) — both increments accumulate → 6.
    expect(applyCounterDelta(applyCounterDelta(base, deltaA), deltaB)).toBe(6);
    // Order-independent: B then A converges to the same total. With LWW it'd be 4 or 5 (one lost).
    expect(applyCounterDelta(applyCounterDelta(base, deltaB), deltaA)).toBe(6);
  });

  it("isCounterDelta only matches the wrapper shape", () => {
    expect(isCounterDelta({ __lfCounter: 1 })).toBe(true);
    expect(isCounterDelta({ __lfCounter: -3 })).toBe(true);
    expect(isCounterDelta(5)).toBe(false);
    expect(isCounterDelta(null)).toBe(false);
    expect(isCounterDelta({ __lfCounter: "1" })).toBe(false); // non-number payload
    expect(isCounterDelta({ __lfSet: { add: [], remove: [] } })).toBe(false);
  });

  it("mergePatch counter-merges CounterDelta fields and LWW-overwrites the rest", () => {
    const row = { _id: "1", title: "old", votes: 3 };
    const patched = mergePatch(row, {
      title: "new", // plain field → overwrite
      votes: { __lfCounter: 2 } // counter field → add
    });
    expect(patched).toEqual({ _id: "1", title: "new", votes: 5 });
  });
});
