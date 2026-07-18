import { describe, expect, it } from "vitest";
import { v } from "convex/values";
import { collectManifest } from "@convex-localfirst/core";
import { createLocalFirst } from "../src/index";

// G7: the deployed function for a local-first table must NOT return
// fabricated success. Reads/writes go through the client + sync.push/pull, so the
// server handler must refuse loudly if invoked directly.

const lf = createLocalFirst();

const todos = lf.table("todos", { shape: {}, scope: lf.byUser("ownerId") });

/** Convex's registered query/mutation keeps the handler on `_handler`. */
function handlerOf(fn: unknown): (ctx: unknown, args: unknown) => Promise<unknown> {
  const h = (fn as Record<string, unknown>)._handler;
  if (typeof h !== "function") {
    throw new Error("could not reach the registered handler");
  }
  return h as (ctx: unknown, args: unknown) => Promise<unknown>;
}

describe("lf.table(...).table() — the derived Convex table definition", () => {
  it("adds the id field + declared indexes to the shape (schema has ONE source)", () => {
    const issues = lf.table("issues", {
      shape: { workspaceId: v.string(), title: v.string(), createdAt: v.number() },
      scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "members" }),
      indexes: { byWorkspace: ["workspaceId", "createdAt"] }
    });
    const exported = (
      issues.table({ extra: { serverNote: v.optional(v.string()) } }) as unknown as {
        export(): {
          indexes: Array<{ indexDescriptor: string; fields: string[] }>;
          documentType: { value: Record<string, unknown> };
        };
      }
    ).export();
    expect(exported.indexes).toEqual([{ indexDescriptor: "byWorkspace", fields: ["workspaceId", "createdAt"] }]);
    expect(Object.keys(exported.documentType.value).sort()).toEqual([
      "createdAt",
      "localId",
      "serverNote",
      "title",
      "workspaceId"
    ]);
  });
});

describe("local-first DSL handlers", () => {
  it("attach introspectable metadata (kind, table, scope)", () => {
    const q = todos.query({ args: {}, index: "by", key: () => [], order: "asc" });
    const meta = (q as { __convexLocalFirst?: Record<string, unknown> }).__convexLocalFirst;
    expect(meta?.kind).toBe("query");
    expect(meta?.tableName).toBe("todos");
    expect(meta?.scope).toEqual({ kind: "byUser", field: "ownerId" });
  });

  it("writes refuse direct invocation instead of returning fabricated success", async () => {
    const ins = todos.insert({ args: {}, value: () => ({}) });
    const pat = todos.patch({ args: {}, id: () => "x", patch: () => ({}) });
    const rem = todos.remove({ args: {}, id: () => "x" });
    for (const [name, fn] of [
      ["insert", ins],
      ["patch", pat],
      ["remove", rem]
    ] as const) {
      await expect(handlerOf(fn)({}, {}), name).rejects.toThrow(/not directly callable/);
    }
  });
});

describe("derived specs + auto timestamps", () => {
  const todos = lf.table("todos", {
    shape: { ownerId: v.string(), text: v.string(), done: v.boolean() },
    scope: lf.byUser("ownerId"),
    timestamps: true,
    indexes: { byOwner: ["ownerId", "createdAt"] }
  });
  const create = todos.insert();
  const update = todos.patch();
  const del = todos.remove();
  const mutationCtx = (now: number) => ({ now, clientId: "c1", userId: "u1", localId: () => "t1" });

  it("table() adds the timestamp columns (true → createdAt/updatedAt; tuple → named)", () => {
    const exported = (todos.table() as unknown as { export(): { documentType: { value: Record<string, unknown> } } }).export();
    expect(Object.keys(exported.documentType.value).sort()).toEqual(["createdAt", "done", "localId", "ownerId", "text", "updatedAt"]);

    const snake = lf.table("snake", {
      shape: { ownerId: v.string() },
      scope: lf.byUser("ownerId"),
      timestamps: ["created_at", "updated_at"]
    });
    const snakeExport = (snake.table() as unknown as { export(): { documentType: { value: Record<string, unknown> } } }).export();
    expect(Object.keys(snakeExport.documentType.value).sort()).toEqual(["created_at", "localId", "ownerId", "updated_at"]);
  });

  it("derived insert args = shape minus owner + timestamps; derived patch args = id + optionalized shape", () => {
    const insertArgs = (create as { __convexLocalFirst?: { spec: { args: Record<string, unknown> } } }).__convexLocalFirst!.spec.args;
    expect(Object.keys(insertArgs).sort()).toEqual(["done", "text"]);
    const patchArgs = (update as { __convexLocalFirst?: { spec: { args: Record<string, { isOptional: string }> } } }).__convexLocalFirst!.spec.args;
    expect(Object.keys(patchArgs).sort()).toEqual(["done", "id", "text"]);
    expect(patchArgs.text!.isOptional).toBe("optional"); // shape fields optionalized
    expect(patchArgs.id!.isOptional).toBe("required"); // the id itself stays required
  });

  it("derived insert stamps owner + timestamps; derived patch forwards present args + stamps updatedAt", () => {
    const manifest = collectManifest({ todos: { todos, create, update, del } });
    const insertPlan = manifest.mutations["todos:create"]!.plan({ text: "hi", done: false }, mutationCtx(111));
    expect(insertPlan).toEqual({
      kind: "insert",
      table: "todos",
      id: "t1",
      value: { text: "hi", done: false, ownerId: "u1", createdAt: 111, updatedAt: 111 }
    });
    const patchPlan = manifest.mutations["todos:update"]!.plan({ id: "t1", text: "yo" }, mutationCtx(222));
    expect(patchPlan).toEqual({ kind: "patch", table: "todos", id: "t1", patch: { text: "yo", updatedAt: 222 } });
    const removePlan = manifest.mutations["todos:del"]!.plan({ id: "t1" }, mutationCtx(333));
    expect(removePlan).toEqual({ kind: "delete", table: "todos", id: "t1" });
  });
});

describe("server-side query execution (SSR / scripts)", () => {
  const owned = lf.table("notes", {
    shape: { ownerId: v.string(), listId: v.string(), text: v.string() },
    scope: lf.byUser("ownerId"),
    indexes: { byList: ["ownerId", "listId"] }
  });

  /** A minimal ctx: auth returns `subject`, db records the index walk and returns rows. */
  function fakeCtx(subject: string | undefined, rows: unknown[] = []) {
    const calls: { table?: string; index?: string; eqs: Array<[string, unknown]>; order?: string } = { eqs: [] };
    const range = {
      eq(field: string, value: unknown) {
        calls.eqs.push([field, value]);
        return range;
      }
    };
    const ctx = {
      auth: { getUserIdentity: async () => (subject ? { subject } : null) },
      db: {
        query(table: string) {
          calls.table = table;
          return {
            withIndex(index: string, build: (q: unknown) => unknown) {
              calls.index = index;
              build(range);
              return {
                order(o: string) {
                  calls.order = o;
                  return { collect: async () => rows };
                }
              };
            }
          };
        }
      }
    };
    return { ctx, calls };
  }

  it("a byUser query EXECUTES: identity from ctx.auth, the declared index walked with the key", async () => {
    const list = owned.query({
      args: { listId: v.string() },
      index: "byList",
      key: ({ auth, args }) => [auth.userId, args.listId],
      order: "desc",
      initial: []
    });
    const { ctx, calls } = fakeCtx("user-1", [{ text: "hi" }]);
    const result = await handlerOf(list)(ctx, { listId: "inbox" });
    expect(result).toEqual([{ text: "hi" }]);
    expect(calls).toMatchObject({
      table: "notes",
      index: "byList",
      order: "desc",
      eqs: [
        ["ownerId", "user-1"],
        ["listId", "inbox"]
      ]
    });
  });

  it("fails closed without an authenticated identity", async () => {
    const list = owned.query({ args: {}, index: "byList", key: ({ auth }) => [auth.userId], initial: [] });
    const { ctx } = fakeCtx(undefined);
    await expect(handlerOf(list)(ctx, {})).rejects.toThrow(/authenticated caller/);
  });

  it("fails closed when the key does not pin the walk to the caller", async () => {
    // A key that ignores auth.userId could read any owner's rows — refuse.
    const sloppy = owned.query({ args: { who: v.string() }, index: "byList", key: ({ args }) => [args.who], initial: [] });
    const { ctx } = fakeCtx("user-1", [{ text: "leak" }]);
    await expect(handlerOf(sloppy)(ctx, { who: "user-2" })).rejects.toThrow(/not directly callable/);
  });

  it("byWorkspace queries still refuse (membership lives in the sync config)", async () => {
    const issues = lf.table("issues", {
      shape: { workspaceId: v.string() },
      scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "members" }),
      indexes: { byWs: ["workspaceId"] }
    });
    const list = issues.query({ args: { workspaceId: v.string() }, index: "byWs", key: ({ args }) => [args.workspaceId], initial: [] });
    const { ctx } = fakeCtx("user-1", [{ leak: true }]);
    await expect(handlerOf(list)(ctx, { workspaceId: "w1" })).rejects.toThrow(/not directly callable/);
  });
});
