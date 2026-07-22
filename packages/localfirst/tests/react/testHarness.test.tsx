import { describe, expect, it, afterEach } from "vitest";
import { anyApi } from "convex/server";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useLiveQuery, useMutation, useQuery, useSyncRecovery } from "../../src/react/index.js";
import { createTestHarness } from "../../src/testing/index.js";
import { docModules, todoModules } from "./harnessFixtures.js";

// Consumers reference functions the way a real app does — Convex refs (here `anyApi.*`,
// which resolve by convention to "module:export"), NOT the lf.table module stubs.
const api = anyApi as {
  todos: { list: never; create: never };
  docs: { rename: never };
};

afterEach(cleanup);

describe("createTestHarness (public API only)", () => {
  // The headline ~10-line consumer scenario: offline edit → server rejects → recovery.
  it("offline edit → conflict → recovery", async () => {
    const t = createTestHarness({
      modules: docModules,
      userId: "u1",
      access: {
        member: () => "member",
        // The server rejects any rename to "REJECT" — a deterministic conflict.
        write: ({ action, patch }) => !(action === "patch" && patch?.title === "REJECT")
      }
    });
    await t.server.seed("docs", [{ localId: "d1", wsId: "w1", title: "hello" }]);

    const { result } = renderHook(
      () => ({
        rows: useLiveQuery(t.db.docs.scope({ wsId: "w1" })),
        recovery: useSyncRecovery(),
        rename: useMutation(api.docs.rename)
      }),
      { wrapper: t.Provider }
    );

    await act(async () => { await t.settled(); });
    expect(result.current.rows?.[0]?.title).toBe("hello");

    t.goOffline();
    await act(async () => { await result.current.rename({ id: "d1", title: "REJECT" }).local; });
    expect(result.current.rows?.[0]?.title).toBe("REJECT"); // optimistic

    t.goOnline();
    await act(async () => { await t.settled(); });

    expect(result.current.recovery.rejectedOperations).toHaveLength(1); // conflict surfaced
    expect(result.current.rows?.[0]?.title).toBe("hello"); // reverted
    t.dispose();
  });

  it("goOffline / goOnline / settled push a durable offline edit", async () => {
    const t = createTestHarness({ modules: todoModules, userId: "u1" });
    const { result } = renderHook(
      () => ({ rows: useQuery(api.todos.list, {}), create: useMutation(api.todos.create) }),
      { wrapper: t.Provider }
    );
    await act(async () => { await t.settled(); });

    t.goOffline();
    await act(async () => { await result.current.create({ text: "offline note" }).local; });
    // Optimistic locally, nothing on the server yet.
    expect((result.current.rows ?? []).map((r) => r.text)).toContain("offline note");
    expect(t.server.rows("todos")).toHaveLength(0);

    t.goOnline();
    await act(async () => { await t.settled(); });
    expect(t.server.rows("todos").map((r) => r.text)).toContain("offline note");
    t.dispose();
  });

  it("clock is deterministic and controllable", async () => {
    const t = createTestHarness({ modules: todoModules, userId: "u1", now: 5_000 });
    expect(t.clock.now()).toBe(5_000);
    t.clock.advance(1_000);
    expect(t.clock.now()).toBe(6_000);
    t.dispose();
  });

  it("switches users onto isolated local data", async () => {
    const t = createTestHarness({ modules: todoModules, userId: "alice" });
    const { result } = renderHook(
      () => ({ rows: useQuery(api.todos.list, {}), create: useMutation(api.todos.create) }),
      { wrapper: t.Provider }
    );
    await act(async () => { await result.current.create({ text: "alice note" }).local; await t.settled(); });
    expect((result.current.rows ?? []).map((r) => r.text)).toContain("alice note");

    await act(async () => { t.setUser("bob"); });
    await act(async () => { await t.settled(); });
    // Bob's fresh local store has none of Alice's rows (I9 device isolation).
    expect((result.current.rows ?? [])).toHaveLength(0);
    expect(t.userId()).toBe("bob");
    t.dispose();
  });
});
