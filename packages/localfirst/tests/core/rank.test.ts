import { describe, expect, it } from "vitest";
import { isValidRank, rankBetween, rankCompare, rebalance } from "../../src/core/rank";

describe("rankBetween basics", () => {
  it("rankBetween(null, null) is a valid rank", () => {
    const a = rankBetween(null, null);
    expect(isValidRank(a)).toBe(true);
  });

  it("basic ordering: head/tail/mid inserts stay ordered", () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    const c = rankBetween(null, a);

    expect(isValidRank(a)).toBe(true);
    expect(isValidRank(b)).toBe(true);
    expect(isValidRank(c)).toBe(true);
    expect(rankCompare(c, a)).toBeLessThan(0);
    expect(rankCompare(a, b)).toBeLessThan(0);
  });

  it("midpoint: a < rankBetween(a,b) < b for several pairs", () => {
    const pairs: Array<[string, string]> = [];

    const a0 = rankBetween(null, null);
    const b0 = rankBetween(a0, null);
    pairs.push([a0, b0]);

    const a1 = rankBetween(null, null);
    const b1 = rankBetween(a1, null);
    const c1 = rankBetween(a1, b1);
    pairs.push([a1, b1], [a1, c1], [c1, b1]);

    const a2 = "5";
    const b2 = "9";
    pairs.push([a2, b2]);

    for (const [lo, hi] of pairs) {
      const m = rankBetween(lo, hi);
      expect(isValidRank(m)).toBe(true);
      expect(rankCompare(lo, m)).toBeLessThan(0);
      expect(rankCompare(m, hi)).toBeLessThan(0);
    }
  });

  it("throws when a >= b", () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    expect(() => rankBetween(b, a)).toThrow("rankBetween: a must be strictly less than b");
    expect(() => rankBetween(a, a)).toThrow("rankBetween: a must be strictly less than b");
  });
});

describe("adversarial sequences", () => {
  it("repeated head inserts stay strictly decreasing and short", () => {
    let first = rankBetween(null, null);
    let prev = first;
    let maxLen = first.length;
    for (let i = 0; i < 500; i++) {
      first = rankBetween(null, first);
      expect(isValidRank(first)).toBe(true);
      expect(rankCompare(first, prev)).toBeLessThan(0);
      prev = first;
      maxLen = Math.max(maxLen, first.length);
    }
    expect(first.length).toBeLessThan(500);
    console.log("[rank.test] head-insert max length:", maxLen);
  });

  it("repeated tail inserts stay strictly increasing and short", () => {
    let last = rankBetween(null, null);
    let prev = last;
    let maxLen = last.length;
    for (let i = 0; i < 500; i++) {
      last = rankBetween(last, null);
      expect(isValidRank(last)).toBe(true);
      expect(rankCompare(last, prev)).toBeGreaterThan(0);
      prev = last;
      maxLen = Math.max(maxLen, last.length);
    }
    // NOTE: the mandated `between` algorithm treats an open upper bound as
    // "one past max" and converges to it via repeated halving. Once a digit
    // position saturates at the max char it must be re-copied on every
    // subsequent call, so length grows roughly linearly (~1 char per 5
    // inserts) for a long run of pure tail appends — this is precisely the
    // scenario `rebalance` exists to fix. Empirically this settles at
    // ~100-105 chars for 500 iterations; 200 is a generous bound that still
    // catches genuinely pathological (e.g. exponential) growth.
    expect(last.length).toBeLessThan(200);
    console.log("[rank.test] tail-insert max length:", maxLen);
  });

  it("repeated mid inserts (converging toward lo) stay ordered and grow slowly", () => {
    const lo = rankBetween(null, null);
    let hi = rankBetween(lo, null);
    const list: string[] = [lo, hi];
    let maxLen = Math.max(lo.length, hi.length);

    for (let i = 0; i < 200; i++) {
      const prevHi = hi;
      const mid = rankBetween(lo, hi);
      expect(isValidRank(mid)).toBe(true);
      expect(rankCompare(lo, mid)).toBeLessThan(0);
      expect(rankCompare(mid, prevHi)).toBeLessThan(0);
      hi = mid;
      list.push(mid);
      maxLen = Math.max(maxLen, mid.length);
    }

    expect(hi.length).toBeLessThan(400);

    // Full ordering check: lo < ... < each successive mid inserted, in
    // reverse insertion order (each new mid is smaller than the previous hi).
    // list = [lo, hi0, mid1, mid2, ...] where each mid_i < mid_{i-1}.
    for (let i = 2; i < list.length; i++) {
      expect(rankCompare(list[i], list[i - 1])).toBeLessThan(0);
    }
    expect(rankCompare(lo, list[list.length - 1])).toBeLessThan(0);

    console.log("[rank.test] mid-insert max length:", maxLen);
  });

  it("concurrent rankBetween(a,b) calls diverge via jitter", () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);

    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = rankBetween(a, b);
      expect(isValidRank(r)).toBe(true);
      expect(rankCompare(a, r)).toBeLessThan(0);
      expect(rankCompare(r, b)).toBeLessThan(0);
      results.add(r);
    }
    expect(results.size).toBeGreaterThanOrEqual(95);
  });
});

describe("rebalance", () => {
  it.each([0, 1, 2, 5, 50])("produces %d strictly ascending, valid, short ranks", (n) => {
    const input = Array.from({ length: n }, (_, i) => `dummy-${i}`);
    const result = rebalance(input);
    expect(result.length).toBe(n);

    for (const r of result) {
      expect(isValidRank(r)).toBe(true);
      expect(r.length).toBeLessThan(12);
    }

    for (let i = 1; i < result.length; i++) {
      expect(rankCompare(result[i - 1], result[i])).toBeLessThan(0);
    }
  });

  it("returns [] for empty input", () => {
    expect(rebalance([])).toEqual([]);
  });
});

describe("isValidRank", () => {
  it("rejects invalid values", () => {
    expect(isValidRank("")).toBe(false);
    expect(isValidRank(null)).toBe(false);
    expect(isValidRank(undefined)).toBe(false);
    expect(isValidRank(123)).toBe(false);
    expect(isValidRank({})).toBe(false);
    expect(isValidRank([])).toBe(false);
    expect(isValidRank(true)).toBe(false);
    expect(isValidRank("a-b")).toBe(false);
    expect(isValidRank("a!")).toBe(false);
    expect(isValidRank("A0")).toBe(false);
    expect(isValidRank("0")).toBe(false);
  });

  it("accepts rankBetween outputs", () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    const c = rankBetween(null, a);
    const d = rankBetween(a, b);
    const e = rankBetween(null, b);

    for (const r of [a, b, c, d, e]) {
      expect(isValidRank(r)).toBe(true);
    }
  });
});
