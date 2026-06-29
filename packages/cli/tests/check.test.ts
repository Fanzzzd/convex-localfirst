import { describe, expect, it } from "vitest";
import { collectLocalFirstTables, findDirectWrites, findIdBasedWrites, type SourceFile } from "../src/check";

const localfirst: SourceFile = {
  path: "convex/localfirst.ts",
  content: `const todos = lf.table("todos", { scope: lf.byUser("ownerId") });\nconst notes = lf.table("notes", {});`
};

describe("convex-localfirst check", () => {
  it("collects local-first table names from the DSL", () => {
    expect(collectLocalFirstTables([localfirst]).sort()).toEqual(["notes", "todos"]);
  });

  it("flags a direct ctx.db.insert into a local-first table", () => {
    const offender: SourceFile = {
      path: "convex/sneaky.ts",
      content: `export const hack = mutation({ handler: async (ctx) => {\n  await ctx.db.insert("todos", { text: "bypass" });\n} });`
    };
    const lfTables = collectLocalFirstTables([localfirst]);
    const violations = findDirectWrites([localfirst, offender], lfTables);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ table: "todos", method: "insert", line: 2 });
  });

  it("does not flag DSL-based writes or writes to non-local-first tables", () => {
    const clean: SourceFile = {
      path: "convex/ok.ts",
      content: `const created = todos.insert({ value: () => ({}) });\nexport const log = mutation({ handler: async (ctx) => {\n  await ctx.db.insert("auditLogs", { ok: true });\n} });`
    };
    const lfTables = collectLocalFirstTables([localfirst]);
    expect(findDirectWrites([localfirst, clean], lfTables)).toHaveLength(0);
  });

  it("detects a multiline insert call", () => {
    const offender: SourceFile = {
      path: "convex/multi.ts",
      content: `await ctx.db.insert(\n  "notes",\n  { body: "x" }\n);`
    };
    const violations = findDirectWrites([offender], ["notes"]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.table).toBe("notes");
  });
});

describe("convex-localfirst check — id-based writes (AST)", () => {
  const lf = ["todos", "notes"];

  it("flags ctx.db.delete on a v.id() handler arg", () => {
    const offender: SourceFile = {
      path: "convex/a.ts",
      content: `export const rm = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  }
});`
    };
    const v = findIdBasedWrites([offender], lf);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ table: "todos", method: "delete" });
  });

  it("flags ctx.db.patch on a destructured v.id() arg", () => {
    const offender: SourceFile = {
      path: "convex/b.ts",
      content: `export const edit = mutation({
  args: { id: v.id("notes"), body: v.string() },
  handler: async (ctx, { id, body }) => {
    await ctx.db.patch(id, { body });
  }
});`
    };
    const v = findIdBasedWrites([offender], lf);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ table: "notes", method: "patch" });
  });

  it("flags patch on a const doc from a local-first query", () => {
    const offender: SourceFile = {
      path: "convex/c.ts",
      content: `export const touch = mutation({
  handler: async (ctx) => {
    const doc = await ctx.db.query("todos").withIndex("by_owner").first();
    await ctx.db.patch(doc._id, { done: true });
  }
});`
    };
    const v = findIdBasedWrites([offender], lf);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ table: "todos", method: "patch" });
  });

  it("flags an inline query-then-delete", () => {
    const offender: SourceFile = {
      path: "convex/d.ts",
      content: `await ctx.db.delete((await ctx.db.query("notes").unique())._id);`
    };
    expect(findIdBasedWrites([offender], lf)).toHaveLength(1);
  });

  it("does NOT flag id-writes to a non-local-first table (no false positive)", () => {
    const clean: SourceFile = {
      path: "convex/e.ts",
      content: `export const rm = mutation({
  args: { id: v.id("auditLogs") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    const a = await ctx.db.query("auditLogs").first();
    await ctx.db.patch(a._id, { ok: true });
  }
});`
    };
    expect(findIdBasedWrites([clean], lf)).toHaveLength(0);
  });

  it("does NOT flag an untraceable id from ctx.db.get (sound: no guess)", () => {
    const clean: SourceFile = {
      path: "convex/f.ts",
      content: `export const rm = mutation({
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.someId);
    if (doc) await ctx.db.delete(doc._id);
  }
});`
    };
    expect(findIdBasedWrites([clean], lf)).toHaveLength(0);
  });

  it("does NOT flag the DSL wrappers themselves", () => {
    const clean: SourceFile = {
      path: "convex/g.ts",
      content: `const todos = lf.table("todos", {});
export const remove = todos.remove();
export const update = todos.patch();`
    };
    expect(findIdBasedWrites([clean], lf)).toHaveLength(0);
  });
});
