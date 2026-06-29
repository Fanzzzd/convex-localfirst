import { describe, expect, it } from "vitest";
import { MemoryLocalStore, type LocalOperation } from "../src";
import {
  acceptAllTransport,
  createHarness,
  offlineTransport,
  rejectingTransport,
  serverChange
} from "./helpers";

const seededTodo = (id: string, extra: Record<string, unknown> = {}) =>
  serverChange({
    id,
    kind: "insert",
    version: 1,
    value: { ownerId: "user_a", listId: "inbox", text: "x", done: false, ...extra }
  });

describe("core runtime", () => {
  it("insert updates the local query before server ack", async () => {
    const { engine } = createHarness({ transport: offlineTransport() });
    const call = engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "hi" });
    await call.local;
    const rows = await engine.query<{ listId: string }, readonly { text?: string }[]>("todos:list", { listId: "inbox" });
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.text).toBe("hi");
  });

  it("patch updates the local query before server ack", async () => {
    const { engine, store } = createHarness({ transport: offlineTransport() });
    await store.applyServerChange(seededTodo("t1"));
    const call = engine.mutate("todos:toggle", { id: "t1", done: true });
    await call.local;
    const rows = await engine.query<{ listId: string }, readonly { done?: boolean }[]>("todos:list", { listId: "inbox" });
    expect(rows?.[0]?.done).toBe(true);
  });

  it("delete creates a tombstone", async () => {
    const { engine, store } = createHarness({ transport: offlineTransport() });
    await store.applyServerChange(seededTodo("t1"));
    const call = engine.mutate("todos:remove", { id: "t1" });
    await call.local;
    const visible = await engine.query<{ listId: string }, readonly unknown[]>("todos:list", { listId: "inbox" });
    expect(visible).toHaveLength(0);
    const raw = await store.getRows("todos");
    expect(raw.find((row) => row._id === "t1")?._deleted).toBe(true);
  });

  it("duplicate op id is idempotent", async () => {
    const store = new MemoryLocalStore();
    const op: LocalOperation = {
      opId: "op_dup",
      clientId: "c",
      userId: "u",
      schemaVersion: 1,
      functionName: "todos:create",
      table: "todos",
      kind: "insert",
      id: "t1",
      args: {},
      value: { listId: "inbox" },
      createdAt: 1,
      status: "pending"
    };
    await store.enqueueOperation(op);
    await store.enqueueOperation(op);
    expect((await store.getPendingOperations()).length).toBe(1);
  });

  it("pending operations survive a reload", async () => {
    const store = new MemoryLocalStore();
    const first = createHarness({ store, transport: offlineTransport() });
    await first.engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "persist" }).local;

    // Reload = a fresh engine over the same durable store.
    const second = createHarness({ store, transport: offlineTransport() });
    const rows = await second.engine.query<{ listId: string }, readonly { text?: string }[]>("todos:list", {
      listId: "inbox"
    });
    expect(rows?.[0]?.text).toBe("persist");
    expect((await store.getPendingOperations()).length).toBe(1);
  });

  it("server rejection marks the op AND the row as conflicted", async () => {
    const { engine, store } = createHarness({ transport: rejectingTransport("not allowed") });
    await store.applyServerChange(seededTodo("t1"));
    const call = engine.mutate("todos:toggle", { id: "t1", done: true });
    await call.local;
    await expect(call.server).rejects.toThrow("not allowed");
    expect(call.status().status).toBe("rejected");

    const row = (await store.getRows("todos")).find((candidate) => candidate._id === "t1");
    expect(row?._conflict?.kind).toBe("serverRejected");
    expect(row?.done).toBe(false); // optimistic change reverted to canonical
  });

  it("pull applies canonical changes", async () => {
    const { engine } = createHarness({
      transport: {
        ...acceptAllTransport(),
        async pull() {
          return {
            changes: [seededTodo("t2", { text: "pulled" })],
            cursors: { "user:user_a": "c1" },
            serverTime: 1
          };
        }
      }
    });
    await engine.syncOnce([{ kind: "byUser", key: "user:user_a" }]);
    const rows = await engine.query<{ listId: string }, readonly { text?: string }[]>("todos:list", { listId: "inbox" });
    expect(rows?.some((row) => row.text === "pulled")).toBe(true);
  });

  it("pull applies tombstones", async () => {
    const { engine, store } = createHarness({
      transport: {
        ...acceptAllTransport(),
        async pull() {
          return {
            changes: [serverChange({ id: "t1", kind: "delete", version: 2 })],
            cursors: { "user:user_a": "c1" },
            serverTime: 1
          };
        }
      }
    });
    await store.applyServerChange(seededTodo("t1"));
    await engine.syncOnce([{ kind: "byUser", key: "user:user_a" }]);
    const visible = await engine.query<{ listId: string }, readonly unknown[]>("todos:list", { listId: "inbox" });
    expect(visible).toHaveLength(0);
    expect((await store.getRows("todos")).find((row) => row._id === "t1")?._deleted).toBe(true);
  });

  it("rebase: pull applies server changes THEN replays pending local ops (I1)", async () => {
    const { engine, store } = createHarness({ transport: offlineTransport() });
    await store.applyServerChange(seededTodo("t1", { text: "orig", title: "a" }));

    // Local offline edit (pending): toggle done -> true.
    await engine.mutate("todos:toggle", { id: "t1", done: true }).local;

    // A server change for the SAME row arrives on a different field, higher version.
    await store.applyServerChange(serverChange({ id: "t1", kind: "patch", version: 2, patch: { title: "server-edit" } }));

    const row = (await engine.query<{ listId: string }, readonly Record<string, unknown>[]>("todos:list", {
      listId: "inbox"
    }))?.[0];
    expect(row?.title).toBe("server-edit"); // canonical server change applied
    expect(row?.done).toBe(true); // pending local op replayed on top — NOT clobbered
  });

  it("out-of-order server responses do not corrupt state", async () => {
    const store = new MemoryLocalStore();
    await store.applyServerChange(seededTodo("t1", { text: "v1" }));
    await store.applyServerChange(serverChange({ id: "t1", kind: "patch", version: 3, patch: { text: "v3" } }));
    // Stale change (v2) arrives after v3 — must be ignored.
    await store.applyServerChange(serverChange({ id: "t1", kind: "patch", version: 2, patch: { text: "v2-stale" } }));
    expect((await store.getRows("todos")).find((row) => row._id === "t1")?.text).toBe("v3");
  });

  it("a server-only / non-local-first mutation is not local and never enters the outbox", async () => {
    const { engine, store } = createHarness({ transport: offlineTransport() });
    expect(engine.hasLocalMutation("server:doDangerousThing")).toBe(false);
    // The engine refuses to run a non-manifest function locally; React routes it
    // to the official Convex client instead, so nothing is ever enqueued.
    expect(() => engine.mutate("server:doDangerousThing", {})).toThrow();
    expect((await store.getPendingOperations()).length).toBe(0);
  });

  it("a confirming server change (matching opId) prunes the pending op without duplicating the row", async () => {
    const { engine, store } = createHarness({ transport: offlineTransport() });
    const call = engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "x" });
    await call.local;
    expect((await store.getPendingOperations()).length).toBe(1);

    await store.applyServerChange(
      serverChange({ id: "t1", kind: "insert", version: 1, opId: call.opId, value: { ownerId: "user_a", listId: "inbox", text: "x", done: false } })
    );

    expect((await store.getPendingOperations()).length).toBe(0);
    const rows = await engine.query<{ listId: string }, readonly unknown[]>("todos:list", { listId: "inbox" });
    expect(rows).toHaveLength(1); // single row, now canonical (no duplicate)
  });
});
