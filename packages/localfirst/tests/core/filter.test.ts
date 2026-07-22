import { describe, expect, it } from "vitest";
import {
  collection,
  matchesFilter,
  parseFilter,
  serializeFilter,
  type FilterSpec
} from "../../src/core";

type TestRow = {
  n: number | null;
  text: string;
  flag: boolean;
  tags: string[];
};

function compare(left: unknown, right: unknown): number {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  return typeof left === "number" && typeof right === "number"
    ? left - right
    : String(left).localeCompare(String(right));
}

function referenceCondition(value: unknown, condition: unknown): boolean {
  if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
    return Object.is(value, condition);
  }
  for (const [operator, operand] of Object.entries(condition)) {
    const list = Array.isArray(operand) ? operand : [];
    const values = Array.isArray(value) ? value : value instanceof Set ? [...value] : [];
    if (operator === "eq" && !Object.is(value, operand)) return false;
    if (operator === "ne" && Object.is(value, operand)) return false;
    if (operator === "in" && !list.some((item) => Object.is(value, item))) return false;
    if (operator === "nin" && list.some((item) => Object.is(value, item))) return false;
    if (operator === "lt" && compare(value, operand) >= 0) return false;
    if (operator === "lte" && compare(value, operand) > 0) return false;
    if (operator === "gt" && compare(value, operand) <= 0) return false;
    if (operator === "gte" && compare(value, operand) < 0) return false;
    if (operator === "contains" && !values.some((item) => Object.is(item, operand))) return false;
    if (operator === "overlaps" && !list.some((needle) => values.some((item) => Object.is(item, needle)))) return false;
  }
  return true;
}

function reference(row: TestRow, filter: FilterSpec<TestRow>): boolean {
  for (const [field, condition] of Object.entries(filter)) {
    if (field === "OR") {
      if (!(condition as FilterSpec<TestRow>[]).some((child) => reference(row, child))) return false;
    } else if (field === "AND") {
      if (!(condition as FilterSpec<TestRow>[]).every((child) => reference(row, child))) return false;
    } else if (field === "NOT") {
      if (reference(row, condition as FilterSpec<TestRow>)) return false;
    } else if (!referenceCondition(row[field as keyof TestRow], condition)) return false;
  }
  return true;
}

function random(seed = 0x5eed): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("serializable filter AST", () => {
  it("supports contains/overlaps on array and Set fields", () => {
    expect(matchesFilter(
      { tags: new Set(["bug", "urgent"]) },
      { tags: { contains: "bug", overlaps: ["later", "urgent"] } }
    )).toBe(true);
  });

  it("matches an independent .where-style reference across random rows and filters", () => {
    const next = random();
    const pick = <Value>(values: readonly Value[]): Value => values[Math.floor(next() * values.length)]!;
    const texts = ["alpha", "beta", "urgent"] as const;
    const tags = ["bug", "ui", "p1"] as const;
    const rows: TestRow[] = Array.from({ length: 160 }, () => ({
      n: pick([null, -2, 0, 1, 5]),
      text: pick(texts),
      flag: next() < 0.5,
      tags: tags.filter(() => next() < 0.45)
    }));

    const leaf = (): FilterSpec<TestRow> => {
      const kind = Math.floor(next() * 4);
      if (kind === 0) {
        const value = pick([null, -2, 0, 1, 5]);
        const operator = pick(["eq", "ne", "lt", "lte", "gt", "gte"] as const);
        return { n: { [operator]: value } } as FilterSpec<TestRow>;
      }
      if (kind === 1) {
        const values = texts.filter(() => next() < 0.55);
        return next() < 0.5 ? { text: pick(texts) } : { text: { [pick(["in", "nin"] as const)]: values } };
      }
      if (kind === 2) return next() < 0.5 ? { flag: next() < 0.5 } : { flag: { ne: next() < 0.5 } };
      return next() < 0.5
        ? { tags: { contains: pick(tags) } }
        : { tags: { overlaps: tags.filter(() => next() < 0.5) } };
    };
    const makeFilter = (depth = 0): FilterSpec<TestRow> => {
      if (depth >= 2 || next() < 0.65) return leaf();
      if (next() < 0.25) return { NOT: makeFilter(depth + 1) };
      const operator = next() < 0.5 ? "OR" : "AND";
      return { [operator]: [makeFilter(depth + 1), makeFilter(depth + 1)] } as FilterSpec<TestRow>;
    };

    const filters = Array.from({ length: 160 }, () => makeFilter());
    const identified = rows.map((row, index) => ({ ...row, _id: String(index) }));
    for (const filter of filters) {
      const ast = collection<(typeof identified)[number]>("rows")
        .filter(filter)
        .run(identified as never)
        .map((row) => row._id);
      const closure = collection<(typeof identified)[number]>("rows")
        .where((row) => reference(row, filter))
        .run(identified as never)
        .map((row) => row._id);
      expect(ast).toEqual(closure);
      for (const row of rows) expect(matchesFilter(row, filter)).toBe(reference(row, filter));
    }
  });

  it("round-trips saved filters and preserves null ordering", () => {
    const filter: FilterSpec<TestRow> = {
      AND: [
        { n: { gt: null, lte: 5, ne: 0 } },
        { OR: [{ text: { in: ["alpha", "urgent"] } }, { tags: { contains: "bug" } }] },
        { NOT: { flag: true } }
      ]
    };
    const parsed = parseFilter<TestRow>(serializeFilter(filter));
    expect(parsed).toEqual({ ok: true, value: filter });
    if (parsed.ok) {
      expect(matchesFilter({ n: null, text: "alpha", flag: false, tags: [] }, parsed.value)).toBe(false);
      expect(matchesFilter({ n: 1, text: "alpha", flag: false, tags: [] }, parsed.value)).toBe(true);
    }
  });

  it.each([
    ["not JSON", "invalid_json"],
    ["[]", "invalid_filter"],
    ['{"status":{"wat":1}}', "invalid_operator"],
    ['{"status":{"in":"open"}}', "invalid_operand"],
    ['{"OR":{"status":"open"}}', "invalid_operand"],
    ['{"NOT":[]}', "invalid_filter"]
  ] as const)("rejects malformed input: %s", (json, code) => {
    const parsed = parseFilter(json);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe(code);
  });

  it("rejects non-JSON and circular values before serialization", () => {
    expect(() => serializeFilter({ status: { eq: undefined } } as never)).toThrow(TypeError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeFilter({ status: { eq: circular } } as never)).toThrow(TypeError);
  });
});
