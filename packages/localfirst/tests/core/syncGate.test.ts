import { describe, expect, it } from "vitest";
import { MemoryLocalStore, type PushResponse, type SyncScope, type SyncTransport } from "../../src/core";
import { createHarness } from "./helpers";

/** A transport that counts push/pull and records the ops each push carried. */
function recordingTransport(): SyncTransport & {
  pushCount: number;
  pullCount: number;
  pushedOpIds: string[][];
} {
  const t = {
    pushCount: 0,
    pullCount: 0,
    pushedOpIds: [] as string[][],
    async push(request): Promise<PushResponse> {
      t.pushCount++;
      t.pushedOpIds.push(request.mutations.map((op) => op.opId));
      return {
        accepted: request.mutations.map((op) => ({ opId: op.opId, serverResult: { ok: true, id: op.id } })),
        rejected: [],
        idMaps: [],
        changes: [],
        serverTime: 1
      };
    },
    async pull() {
      t.pullCount++;
      return { changes: [], cursors: {}, serverTime: 1 };
    }
  };
  return t;
}

const userScope: SyncScope = { kind: "byUser", key: "u:user_a", table: "todos" };

/** Enqueue a pending op straight into the store (no engine push), so we can exercise the
 *  BACKGROUND push path (pushPendingOperations) in isolation from mutate's direct push. */
async function seedPending(store: MemoryLocalStore, opId: string): Promise<void> {
  await store.enqueueOperation({
    opId,
    clientId: "client_test",
    userId: "user_a",
    schemaVersion: 1,
    functionName: "todos:create",
    table: "todos",
    kind: "insert",
    id: `todos_${opId}`,
    args: {},
    value: { ownerId: "user_a", listId: "l1", text: "x", done: false, createdAt: 1, updatedAt: 1 },
    createdAt: 1,
    status: "pending"
  });
}

describe("LocalFirstEngine — multi-tab sync gate (setSyncEnabled)", () => {
  it("a FOLLOWER suppresses the background batch push but still pulls", async () => {
    const transport = recordingTransport();
    const store = new MemoryLocalStore();
    const { engine } = createHarness({ store, transport });
    await seedPending(store, "op_1");

    engine.setSyncEnabled(false);
    await engine.syncOnce([userScope]);

    expect(transport.pushCount).toBe(0); // gated: the leader pushes the shared outbox
    expect(transport.pullCount).toBeGreaterThanOrEqual(1); // pull stays per-tab (fresh data)
  });

  it("the LEADER (default) pushes the backlog on a background sync", async () => {
    const transport = recordingTransport();
    const store = new MemoryLocalStore();
    const { engine } = createHarness({ store, transport });
    await seedPending(store, "op_1");

    await engine.syncOnce([userScope]); // syncEnabled defaults true
    expect(transport.pushCount).toBe(1);
    expect(transport.pushedOpIds[0]).toContain("op_1");
  });

  it("re-enabling (regaining leadership) flushes the inherited backlog immediately", async () => {
    const transport = recordingTransport();
    const store = new MemoryLocalStore();
    const { engine } = createHarness({ store, transport });
    await seedPending(store, "op_1");

    engine.setSyncEnabled(false);
    await engine.syncOnce([userScope]);
    expect(transport.pushCount).toBe(0);

    engine.setSyncEnabled(true); // becomes leader → flushPending fires
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.pushCount).toBe(1);
    expect(transport.pushedOpIds[0]).toContain("op_1");
  });

  it("flushPending() bypasses the gate (reconnect flush / wake from a follower)", async () => {
    const transport = recordingTransport();
    const store = new MemoryLocalStore();
    const { engine } = createHarness({ store, transport });
    await seedPending(store, "op_1");

    engine.setSyncEnabled(false);
    engine.flushPending();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.pushCount).toBe(1); // explicit flush is never gated
  });

  it("an explicit mutation still pushes from a follower tab (pushSingleOperation is not gated)", async () => {
    const transport = recordingTransport();
    const store = new MemoryLocalStore();
    const { engine } = createHarness({ store, transport });

    engine.setSyncEnabled(false);
    await engine.mutate("todos:create", { listId: "l1", text: "hi" }).server;
    expect(transport.pushCount).toBe(1); // the acting tab always pushes the user's own action
  });

  it("pokeLocalChange() fires local data listeners (the cross-tab re-read)", () => {
    const { engine } = createHarness();
    let fired = 0;
    const unsubscribe = engine.subscribe(() => {
      fired++;
    });
    engine.pokeLocalChange();
    expect(fired).toBe(1);
    unsubscribe();
    engine.pokeLocalChange();
    expect(fired).toBe(1); // no longer subscribed
  });

  it("resolves call.server from the durable outcome when OUR push fails but the op completed elsewhere", async () => {
    // Multi-tab: the leader pushed this op from the shared outbox and pruned it while
    // our own push fails. call.server must resolve (the mutation DID succeed), not reject.
    const store = new MemoryLocalStore();
    const transport: SyncTransport = {
      async push(request): Promise<PushResponse> {
        // Simulate the leader having already pushed + pruned the op from the shared outbox.
        for (const op of request.mutations) {
          await store.dropOperation(op.opId);
        }
        throw new Error("network down");
      },
      async pull() {
        return { changes: [], cursors: {}, serverTime: 1 };
      }
    };
    const { engine } = createHarness({ store, transport });
    const call = engine.mutate("todos:create", { listId: "l1", text: "hi" });
    await expect(call.server).resolves.toMatchObject({ ok: true });
  });

  it("still rejects call.server when the op is genuinely unsynced (offline, not completed elsewhere)", async () => {
    const store = new MemoryLocalStore();
    const transport: SyncTransport = {
      async push(): Promise<PushResponse> {
        throw new Error("offline");
      },
      async pull() {
        return { changes: [], cursors: {}, serverTime: 1 };
      }
    };
    const { engine } = createHarness({ store, transport });
    const call = engine.mutate("todos:create", { listId: "l1", text: "hi" });
    await expect(call.server).rejects.toThrow("offline");
  });
});
