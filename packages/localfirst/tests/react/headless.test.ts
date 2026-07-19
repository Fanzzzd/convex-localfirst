import { describe, expect, it } from "vitest";
import { makeFunctionReference } from "convex/server";
import {
  MemoryLocalStore,
  byUser,
  defineLocalFirstManifest,
  localMutation,
  localQuery,
  localTable
} from "../../src/core/index.js";
import { convexFunctionName, createConvexLocalFirst } from "../../src/react";

// The headless factory's whole reason to exist: an imperative consumer (service
// layer, MobX, Node) gets the same wiring the React provider does — crucially the
// convex-aware name resolver, so REAL `api.*` function references resolve without
// the consumer remembering `nameOf: getFunctionName`.
function manifest() {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      todos: localTable({ table: "todos", idField: "localId", scope: byUser("ownerId") })
    },
    queries: {
      "todos:list": localQuery<{ listId: string }, readonly unknown[]>({
        kind: "query",
        name: "todos:list",
        table: "todos",
        initial: [],
        run: (rows, args) => rows.filter((r: any) => r.listId === args.listId)
      })
    },
    mutations: {
      "todos:create": localMutation<{ listId: string; text: string }>({
        kind: "mutation",
        name: "todos:create",
        table: "todos",
        plan: (args, ctx) => ({
          kind: "insert",
          table: "todos",
          id: ctx.localId("todos"),
          value: { ownerId: ctx.userId ?? "anon", listId: args.listId, text: args.text, createdAt: ctx.now }
        })
      })
    }
  });
}

// A non-reactive fake client: the local mutate/query path never needs it, and the
// background sync just gets empty acks (no unhandled rejections).
const fakeClient = {
  mutation: async (_ref: unknown, args: any) => ({
    accepted: (args?.mutations ?? []).map((m: any) => ({ opId: m.opId })),
    rejected: [],
    idMaps: [],
    changes: [],
    serverTime: 1
  }),
  query: async () => ({ changes: [], cursors: {}, serverTime: 1 })
};

describe("createConvexLocalFirst (headless factory)", () => {
  it("resolves real Convex function references with no nameOf footgun + roundtrips locally", async () => {
    expect(convexFunctionName(makeFunctionReference("todos:list"))).toBe("todos:list");

    const { engine, client } = createConvexLocalFirst({
      manifest: manifest(),
      client: fakeClient as never,
      store: new MemoryLocalStore(),
      userId: "u"
    });
    expect(client).toBe(fakeClient);

    // api-style refs (NOT strings) — these would throw "Unable to resolve Convex
    // function name" if the factory hadn't wired convexFunctionName.
    await engine.mutate(makeFunctionReference("todos:create"), { listId: "inbox", text: "hi" }).local;
    const rows = await engine.query<{ listId: string }, readonly { text?: string }[]>(
      makeFunctionReference("todos:list"),
      { listId: "inbox" }
    );
    expect(rows?.[0]?.text).toBe("hi");
    engine.dispose();
  });

  it("throws a clear error when neither client nor url is given", () => {
    expect(() => createConvexLocalFirst({ manifest: manifest() })).toThrow(/client.*url/i);
  });
});
