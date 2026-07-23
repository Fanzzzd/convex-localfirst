import { describe, expect, it } from "vitest";
import type { PushRequest, PushResponse, SyncTransport } from "../../src/core";
import { createHarness, offlineTransport } from "./helpers";

/** Accept-all push transport that records each request's mutations (client-side ops, so
 *  group fields are visible before transport serialization). */
function capturingTransport(): { transport: SyncTransport; pushes: PushRequest["mutations"][] } {
  const pushes: PushRequest["mutations"][] = [];
  const transport: SyncTransport = {
    async push(request): Promise<PushResponse> {
      pushes.push(request.mutations);
      return {
        accepted: request.mutations.map((op) => ({
          opId: op.opId,
          serverResult: { ok: true, id: op.id },
        })),
        rejected: [],
        idMaps: [],
        changes: [],
        serverTime: 1,
      };
    },
    async pull() {
      return { changes: [], cursors: {}, serverTime: 1 };
    },
  };
  return { transport, pushes };
}

/** Rejects every op with one group-rejection message (simulates a server group rejection). */
function groupRejectingTransport(reason: string): SyncTransport {
  return {
    async push(request): Promise<PushResponse> {
      return {
        accepted: [],
        rejected: request.mutations.map((op) => ({ opId: op.opId, message: reason })),
        idMaps: [],
        changes: [],
        serverTime: 1,
      };
    },
    async pull() {
      return { changes: [], cursors: {}, serverTime: 1 };
    },
  };
}

describe("atomic write groups — client (engine.batch)", () => {
  it("tags every op with a shared groupId/size/index and pushes them contiguously in ONE request", async () => {
    const { transport, pushes } = capturingTransport();
    const { engine } = createHarness({ transport });

    const call = engine.batch(() => {
      engine.mutate("todos:create", { localId: "t1", listId: "a", text: "one" });
      engine.mutate("todos:create", { localId: "t2", listId: "a", text: "two" });
      engine.mutate("todos:toggle", { id: "t1", done: true });
    });
    await call.local;
    await call.server;

    expect(pushes).toHaveLength(1);
    const ops = pushes[0]!;
    expect(ops).toHaveLength(3);
    const gid = ops[0]!.groupId;
    expect(gid).toBeDefined();
    expect(ops.every((op) => op.groupId === gid)).toBe(true);
    expect(ops.every((op) => op.groupSize === 3)).toBe(true);
    expect(ops.map((op) => op.groupIndex)).toEqual([0, 1, 2]);
  });

  it("exposes a fresh insert's id synchronously so insert-then-patch-same-row works in one batch", async () => {
    const { transport } = capturingTransport();
    const { engine, store } = createHarness({ transport });

    let insertedId: string | undefined;
    const call = engine.batch(() => {
      const created = engine.mutate("todos:create", { listId: "a", text: "hi" }); // auto id
      insertedId = created.id; // synchronous, before any await
      engine.mutate("todos:toggle", { id: created.id, done: true });
    });
    await call.local;

    expect(insertedId).toBeTruthy();
    const rows = (await store.getRows("todos")).filter((r) => !r._deleted);
    const row = rows.find((r) => r._id === insertedId);
    expect(row).toMatchObject({ text: "hi", done: true });
  });

  it("throws a clear error if a batched call's .server is awaited inside fn", async () => {
    const { engine } = createHarness({ transport: capturingTransport().transport });
    await expect(
      engine.batch(async () => {
        const call = engine.mutate("todos:create", { localId: "t1", listId: "a", text: "x" });
        await call.server; // not allowed inside fn — the group has not been dispatched
      }),
    ).rejects.toThrow(/do not await a batched mutation/i);
  });

  it("interop: an ordinary (ungrouped) mutation carries NO group fields and still acks", async () => {
    const { transport, pushes } = capturingTransport();
    const { engine } = createHarness({ transport });
    const call = engine.mutate("todos:create", { localId: "t1", listId: "a", text: "solo" });
    await call.server;
    expect(pushes).toHaveLength(1);
    const op = pushes[0]![0]!;
    expect(op.groupId).toBeUndefined();
    expect(op.groupSize).toBeUndefined();
    expect(op.groupIndex).toBeUndefined();
    expect(call.status().status).toBe("acked");
  });

  it("a group larger than the push cap still ships whole (never split across requests)", async () => {
    const { transport, pushes } = capturingTransport();
    const { engine } = createHarness({ transport, maxPushBatch: 2 });
    const call = engine.batch(() => {
      engine.mutate("todos:create", { localId: "t1", listId: "a", text: "1" });
      engine.mutate("todos:create", { localId: "t2", listId: "a", text: "2" });
      engine.mutate("todos:create", { localId: "t3", listId: "a", text: "3" });
    });
    await call.server;
    // One request carrying all three — the cap is a soft limit; a group is never split.
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toHaveLength(3);
  });

  it("flushes pending ops BEFORE a group rather than splitting the group", async () => {
    const { transport, pushes } = capturingTransport();
    const { engine, store } = createHarness({ transport, maxPushBatch: 2 });
    // Seed the outbox directly: one ungrouped op, then a two-op group (contiguous block).
    const base = {
      clientId: "client_test",
      userId: "user_a",
      schemaVersion: 1,
      functionName: "todos:create",
      table: "todos",
      kind: "insert" as const,
      args: {},
      status: "pending" as const,
    };
    await store.enqueueOperation({
      ...base,
      opId: "solo",
      id: "s0",
      value: { listId: "a", text: "solo" },
      createdAt: 1,
    });
    await store.enqueueOperation({
      ...base,
      opId: "g0",
      id: "g0",
      value: { listId: "a", text: "g0" },
      createdAt: 2,
      groupId: "G",
      groupSize: 2,
      groupIndex: 0,
    });
    await store.enqueueOperation({
      ...base,
      opId: "g1",
      id: "g1",
      value: { listId: "a", text: "g1" },
      createdAt: 3,
      groupId: "G",
      groupSize: 2,
      groupIndex: 1,
    });

    await engine.syncOnce();

    // Cap of 2 would split [solo, g0, g1] mid-group; instead it flushes [solo] first, then
    // ships the whole group [g0, g1] in the next request.
    expect(pushes).toHaveLength(2);
    expect(pushes[0]!.map((op) => op.opId)).toEqual(["solo"]);
    expect(pushes[1]!.map((op) => op.opId)).toEqual(["g0", "g1"]);
  });

  it("offline batch → reload → the group pushes together as a group", async () => {
    // Engine 1 is effectively offline (push never settles): the ops commit locally and
    // durably enqueue with their group tag, but no push completes.
    const { engine: offline, store } = createHarness({ transport: offlineTransport() });
    const call = offline.batch(() => {
      offline.mutate("todos:create", { localId: "t1", listId: "a", text: "one" });
      offline.mutate("todos:create", { localId: "t2", listId: "a", text: "two" });
    });
    await call.local;
    expect((await store.getRows("todos")).filter((r) => !r._deleted)).toHaveLength(2);

    // Reload: a NEW engine over the SAME store drains the outbox. The group is pushed
    // contiguously, in order, in one request — crash safety via the durable group tag.
    const { transport, pushes } = capturingTransport();
    const { engine: reloaded } = createHarness({ store, transport });
    await reloaded.syncOnce();

    expect(pushes).toHaveLength(1);
    const ops = pushes[0]!;
    expect(ops).toHaveLength(2);
    expect(ops.every((op) => op.groupId === ops[0]!.groupId && op.groupId !== undefined)).toBe(
      true,
    );
    expect(ops.map((op) => op.groupIndex)).toEqual([0, 1]);
  });

  it("a rejected group reverts ALL its ops as one unit and surfaces ONE recovery entry; .server rejects", async () => {
    const { engine, store } = createHarness({
      transport: groupRejectingTransport("groupRejected: not a member"),
    });
    const call = engine.batch(() => {
      engine.mutate("todos:create", { localId: "t1", listId: "a", text: "one" });
      engine.mutate("todos:create", { localId: "t2", listId: "a", text: "two" });
    });
    await call.local;
    // Optimistic rows are present after local commit.
    expect((await store.getRows("todos")).filter((r) => !r._deleted)).toHaveLength(2);

    await expect(call.server).rejects.toThrow(/groupRejected/);

    // The whole group reverted — both optimistic rows are gone.
    expect((await store.getRows("todos")).filter((r) => !r._deleted)).toHaveLength(0);
    // ONE failed-group recovery entry (not two per-op rejections); rejectedOperations stays empty.
    const recovery = engine.getRecoveryStatus();
    expect(recovery.rejectedOperations).toHaveLength(0);
    expect(recovery.failedGroups).toHaveLength(1);
    expect(recovery.failedGroups[0]!.opIds).toHaveLength(2);
    expect(recovery.failedGroups[0]!.error).toMatch(/groupRejected/);
  });

  it("multi-tab follower: a batch settles from the leader's per-op outcome broadcasts", async () => {
    // Follower: coordinated + not the writer, so it never pushes; the leader drains the
    // shared outbox and broadcasts each op's outcome.
    const { engine } = createHarness({ transport: capturingTransport().transport });
    engine.setMultiTabEnabled(true);
    engine.setSyncEnabled(false);

    let c1!: { opId: string };
    let c2!: { opId: string };
    const call = engine.batch(() => {
      c1 = engine.mutate("todos:create", { localId: "t1", listId: "a", text: "1" });
      c2 = engine.mutate("todos:create", { localId: "t2", listId: "a", text: "2" });
    });
    await call.local;

    // Simulate the leader's broadcasts.
    engine.observeOperationOutcome({ opId: c1.opId, status: "acked", result: { ok: 1 } });
    engine.observeOperationOutcome({ opId: c2.opId, status: "acked", result: { ok: 2 } });

    await expect(call.server).resolves.toEqual([{ ok: 1 }, { ok: 2 }]);
  });
});
