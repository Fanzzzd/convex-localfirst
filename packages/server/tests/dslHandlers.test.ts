import { describe, expect, it } from "vitest";
import { createLocalFirst } from "../src/index";

// G7: the deployed function for a local-first table must NOT return
// fabricated success. Reads/writes go through the client + sync.push/pull, so the
// server handler must refuse loudly if invoked directly.

const lf = createLocalFirst({
  schema: {}
});

const todos = lf.table("todos", { scope: lf.byUser("ownerId") });

/** Convex's registered query/mutation keeps the handler on `_handler`. */
function handlerOf(fn: unknown): (ctx: unknown, args: unknown) => Promise<unknown> {
  const h = (fn as Record<string, unknown>)._handler;
  if (typeof h !== "function") {
    throw new Error("could not reach the registered handler");
  }
  return h as (ctx: unknown, args: unknown) => Promise<unknown>;
}

describe("local-first DSL handlers", () => {
  it("attach introspectable metadata (kind, table, scope)", () => {
    const q = todos.query({ args: {}, index: "by", key: () => [], order: "asc" });
    const meta = (q as { __convexLocalFirst?: Record<string, unknown> }).__convexLocalFirst;
    expect(meta?.kind).toBe("query");
    expect(meta?.tableName).toBe("todos");
    expect(meta?.scope).toEqual({ kind: "byUser", field: "ownerId" });
  });

  it("refuse direct invocation instead of returning fabricated success", async () => {
    const q = todos.query({ args: {}, index: "by", key: () => [], order: "asc" });
    const ins = todos.insert({ args: {}, value: () => ({}) });
    const pat = todos.patch({ args: {}, id: () => "x", patch: () => ({}) });
    const rem = todos.remove({ args: {}, id: () => "x" });
    for (const [name, fn] of [
      ["query", q],
      ["insert", ins],
      ["patch", pat],
      ["remove", rem]
    ] as const) {
      await expect(handlerOf(fn)({}, {}), name).rejects.toThrow(/not directly callable/);
    }
  });
});
