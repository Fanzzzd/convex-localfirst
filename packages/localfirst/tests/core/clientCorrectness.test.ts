import { describe, expect, it, vi } from "vitest";
import {
  MemoryLocalStore,
  byWorkspace,
  collection,
  localTable,
  type LocalOperation,
  type PullResponse,
  type PushResponse,
  type ServerChange,
  type SyncTransport,
} from "../../src/core";
import { LocalFirstEngine } from "../../src/core/internal";
import { acceptAllTransport, createHarness, createTodoManifest, serverChange } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function pending(
  input: Partial<LocalOperation> & Pick<LocalOperation, "opId" | "kind" | "id">,
): LocalOperation {
  return {
    opId: input.opId,
    clientId: input.clientId ?? "c",
    userId: "user_a",
    schemaVersion: 1,
    functionName:
      input.functionName ??
      (input.kind === "insert"
        ? "todos:create"
        : input.kind === "patch"
          ? "todos:toggle"
          : "todos:remove"),
    table: "todos",
    kind: input.kind,
    id: input.id,
    args: {},
    value: input.value,
    patch: input.patch,
    createdAt: input.createdAt ?? 1,
    status: input.status ?? "pending",
  };
}

describe("client engine correctness regressions", () => {
  it("A1: discards a stale pull after a newer pull revokes the scope", async () => {
    const sk = "byWorkspace:w1";
    const first = deferred<PullResponse>();
    let pulls = 0;
    const transport: SyncTransport = {
      push: acceptAllTransport().push,
      pull: async () =>
        ++pulls === 1
          ? first.promise
          : { changes: [], cursors: {}, deniedScopes: [sk], hasMore: {}, serverTime: 2 },
    };
    const base = createTodoManifest();
    const manifest = {
      ...base,
      tables: {
        ...base.tables,
        issues: localTable({
          table: "issues",
          idField: "localId",
          scope: byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "members" }),
          indexes: {},
        }),
      },
    };
    const { engine, store } = createHarness({ transport, manifest });
    await store.applyServerChange(
      serverChange({
        table: "issues",
        scopeKey: sk,
        id: "old",
        kind: "insert",
        version: 1,
        value: { workspaceId: "w1" },
      }),
    );
    await store.setCursor(sk, "7");

    const stale = engine.syncOnce([{ kind: "byWorkspace", key: sk }]);
    // oxlint-disable-next-line no-unmodified-loop-condition -- flipped by an async transport callback via turn()
    while (pulls < 1) await turn();
    await engine.syncOnce([{ kind: "byWorkspace", key: sk }]);
    first.resolve({
      changes: [
        serverChange({
          table: "issues",
          scopeKey: sk,
          id: "resurrected",
          kind: "insert",
          version: 2,
          value: { workspaceId: "w1" },
        }),
      ],
      cursors: { [sk]: "8" },
      hasMore: { [sk]: false },
      serverTime: 1,
    });
    await stale;

    expect(await store.getRows("issues")).toEqual([]);
    expect(await store.getCursor(sk)).toBeNull();
  });

  it("A2: equal-version full-row pull repairs the exact missed-v2/push-v3 case", async () => {
    let pushedOpId = "";
    const transport: SyncTransport = {
      async push(request) {
        pushedOpId = request.mutations[0]!.opId;
        return {
          accepted: [{ opId: pushedOpId, serverResult: { ok: true } }],
          rejected: [],
          idMaps: [],
          changes: [
            serverChange({
              id: "t1",
              kind: "patch",
              version: 3,
              patch: { done: true },
              opId: pushedOpId,
            }),
          ],
          serverTime: 3,
        };
      },
      async pull() {
        return {
          // v2 changed text remotely; the server's current v3 full row carries BOTH edits.
          changes: [
            serverChange({
              id: "t1",
              kind: "insert",
              version: 3,
              value: { ownerId: "user_a", text: "remote-v2", done: true },
            }),
          ],
          cursors: { "u:user_a": "3" },
          hasMore: { "u:user_a": false },
          serverTime: 3,
        };
      },
    };
    const { engine, store } = createHarness({ transport });
    await store.applyServerChange(
      serverChange({
        id: "t1",
        kind: "insert",
        version: 1,
        value: { ownerId: "user_a", text: "v1", done: false },
      }),
    );

    await engine.mutate("todos:toggle", { id: "t1", done: true }).server;
    expect((await store.getCanonicalRows("todos"))[0]).toMatchObject({
      text: "v1",
      done: true,
      _version: 3,
    });
    await engine.syncOnce([{ kind: "byUser", key: "u:user_a" }]);
    expect((await store.getCanonicalRows("todos"))[0]).toMatchObject({
      text: "remote-v2",
      done: true,
      _version: 3,
    });
  });

  it("A4: a push response after clear rejects and never leaves status pushing", async () => {
    const pushed = deferred<PushResponse>();
    let pushing = false;
    const { engine, store } = createHarness({
      transport: {
        push: () => {
          pushing = true;
          return pushed.promise;
        },
        pull: acceptAllTransport().pull,
      },
      retry: { retries: 0, baseDelayMs: 1 },
    });
    const call = engine.mutate("todos:create", { localId: "t1", listId: "i", text: "x" });
    await call.local;
    // oxlint-disable-next-line no-unmodified-loop-condition -- flipped by an async transport callback via turn()
    while (!pushing) await turn();
    await store.clear();
    pushed.resolve({
      accepted: [{ opId: call.opId, serverResult: { ok: true } }],
      rejected: [],
      idMaps: [],
      changes: [],
      serverTime: 1,
    });
    await expect(call.server).rejects.toThrow(/cancelled/);
    expect(call.status().status).toBe("rejected");
  });

  it("A5: accepted no-op delete synthesizes a tombstone over stale canonical", async () => {
    const transport: SyncTransport = {
      async push(request) {
        return {
          accepted: request.mutations.map((op) => ({
            opId: op.opId,
            serverResult: { ok: true, noop: true },
          })),
          rejected: [],
          idMaps: [],
          changes: [],
          serverTime: 2,
        };
      },
      pull: acceptAllTransport().pull,
    };
    const { engine, store } = createHarness({ transport });
    await store.applyServerChange(
      serverChange({
        id: "t1",
        kind: "insert",
        version: 7,
        value: { ownerId: "user_a", text: "stale" },
      }),
    );
    await engine.mutate("todos:remove", { id: "t1" }).server;
    expect(await engine.tableRows("todos")).toEqual([]);
    expect((await store.getCanonicalRows("todos"))[0]).toMatchObject({
      _deleted: true,
      _version: 8,
    });
  });

  it("A6: ghost eviction commits before the bootstrap tail cursor", async () => {
    class CrashAtCursorStore extends MemoryLocalStore {
      override async setCursor(...args: Parameters<MemoryLocalStore["setCursor"]>): Promise<void> {
        throw new Error(`crash before cursor ${args[0]}`);
      }
    }
    const store = new CrashAtCursorStore();
    await store.applyServerChange(
      serverChange({
        id: "ghost",
        kind: "insert",
        version: 1,
        value: { ownerId: "user_a", text: "ghost" },
      }),
    );
    const { engine } = createHarness({
      store,
      transport: {
        push: acceptAllTransport().push,
        async pull() {
          return {
            changes: [],
            cursors: { "u:user_a": "9" },
            snapshotScopes: ["u:user_a"],
            hasMore: { "u:user_a": false },
            serverTime: 1,
          };
        },
      },
    });
    await expect(engine.syncOnce([{ kind: "byUser", key: "u:user_a" }])).rejects.toThrow(
      /crash before cursor/,
    );
    expect(await store.getRows("todos")).toEqual([]);
    expect(await store.getCursor("u:user_a")).toBeNull();
  });

  it("A7: explicit mutation push uses the transport timeout and returns to pending", async () => {
    const { engine, store } = createHarness({
      transport: {
        push: () => new Promise<PushResponse>(() => {}),
        pull: acceptAllTransport().pull,
      },
      retry: { retries: 0, baseDelayMs: 1 },
      syncTimeoutMs: 10,
    });
    const call = engine.mutate("todos:create", { localId: "t1", listId: "i", text: "x" });
    await expect(call.server).rejects.toThrow(/timed out/);
    expect(call.status().status).toBe("pending");
    expect((await store.getOperation(call.opId))?.status).toBe("pending");
  });

  it("A8: awaits durable timestamp seeding before assigning the first post-reload timestamp", async () => {
    const gate = deferred<void>();
    class SlowSeedStore extends MemoryLocalStore {
      paused = false;
      override async getAllOperations() {
        if (this.paused) await gate.promise;
        return super.getAllOperations();
      }
    }
    const store = new SlowSeedStore();
    await store.enqueueOperation(
      pending({ opId: "old", kind: "insert", id: "old", createdAt: 5000, value: { text: "old" } }),
    );
    store.paused = true;
    const { engine } = createHarness({
      store,
      clock: () => 1000,
      transport: { push: () => new Promise(() => {}), pull: acceptAllTransport().pull },
    });
    const call = engine.mutate("todos:create", { localId: "new", listId: "i", text: "new" });
    let committed = false;
    void call.local.then(() => (committed = true));
    await turn();
    expect(committed).toBe(false);
    gate.resolve();
    await call.local;
    expect((await store.getOperation(call.opId))!.createdAt).toBe(5001);
  });

  it("A9: MemoryLocalStore clear epoch discards an in-flight pull completely", async () => {
    const response = deferred<PullResponse>();
    let started = false;
    const { engine, store } = createHarness({
      transport: {
        push: acceptAllTransport().push,
        pull: () => {
          started = true;
          return response.promise;
        },
      },
    });
    const syncing = engine.syncOnce([{ kind: "byUser", key: "u:user_a" }]);
    // oxlint-disable-next-line no-unmodified-loop-condition -- flipped by an async transport callback via turn()
    while (!started) await turn();
    await store.clear();
    response.resolve({
      changes: [
        serverChange({ id: "secret", kind: "insert", version: 1, value: { ownerId: "user_a" } }),
      ],
      cursors: { "u:user_a": "1" },
      hasMore: { "u:user_a": false },
      serverTime: 1,
    });
    await syncing;
    expect(await store.getRows("todos")).toEqual([]);
    expect(await store.getCursor("u:user_a")).toBeNull();
  });

  it("A10: syncing remains true until every overlapping sync finishes", async () => {
    const a = deferred<PullResponse>();
    const b = deferred<PullResponse>();
    let pulls = 0;
    const { engine } = createHarness({
      transport: {
        push: acceptAllTransport().push,
        pull: () => (++pulls === 1 ? a.promise : b.promise),
      },
    });
    const one = engine.syncOnce([{ kind: "byUser", key: "a" }]);
    const two = engine.syncOnce([{ kind: "byUser", key: "b" }]);
    // oxlint-disable-next-line no-unmodified-loop-condition -- flipped by an async transport callback via turn()
    while (pulls < 2) await turn();
    a.resolve({ changes: [], cursors: { a: "1" }, hasMore: { a: false }, serverTime: 1 });
    await one;
    expect(engine.getStatus().syncing).toBe(true);
    b.resolve({ changes: [], cursors: { b: "1" }, hasMore: { b: false }, serverTime: 1 });
    await two;
    expect(engine.getStatus().syncing).toBe(false);
  });

  it("A10: partial remains true until every tracked scope completes", async () => {
    const store = new MemoryLocalStore();
    await store.setCursor("a", "0");
    let aComplete = false;
    const { engine } = createHarness({
      store,
      transport: {
        push: acceptAllTransport().push,
        async pull(request) {
          const key = request.scopes[0]!.key;
          if (key === "a" && !aComplete)
            return { changes: [], cursors: { a: "0" }, hasMore: { a: true }, serverTime: 1 };
          return { changes: [], cursors: { [key]: "1" }, hasMore: { [key]: false }, serverTime: 1 };
        },
      },
    });
    await engine.syncOnce([{ kind: "byUser", key: "a" }]);
    expect(engine.getStatus().partial).toBe(true);
    await engine.syncOnce([{ kind: "byUser", key: "b" }]);
    expect(engine.getStatus().partial).toBe(true);
    aComplete = true;
    await engine.syncOnce([{ kind: "byUser", key: "a" }]);
    expect(engine.getStatus().partial).toBe(false);
  });

  it("E: replays accepted insert, rejected same-row patch, then later accepted patch", async () => {
    const store = new MemoryLocalStore();
    await store.enqueueOperation(
      pending({
        opId: "o1",
        kind: "insert",
        id: "t1",
        createdAt: 1,
        value: { ownerId: "user_a", text: "new", done: false },
      }),
    );
    await store.enqueueOperation(
      pending({ opId: "o2", kind: "patch", id: "t1", createdAt: 2, patch: { done: true } }),
    );
    await store.enqueueOperation(
      pending({ opId: "o3", kind: "patch", id: "t1", createdAt: 3, patch: { text: "later" } }),
    );
    const { engine } = createHarness({
      store,
      transport: {
        async push() {
          return {
            accepted: [{ opId: "o1" }, { opId: "o3" }],
            rejected: [{ opId: "o2", message: "denied" }],
            idMaps: [],
            changes: [
              serverChange({
                id: "t1",
                kind: "insert",
                version: 1,
                value: { ownerId: "user_a", text: "new", done: false },
                opId: "o1",
              }),
              serverChange({
                id: "t1",
                kind: "patch",
                version: 2,
                patch: { text: "later" },
                opId: "o3",
              }),
            ],
            serverTime: 2,
          };
        },
        pull: acceptAllTransport().pull,
      },
    });
    await engine.syncOnce();
    expect((await store.getRows("todos"))[0]).toMatchObject({ text: "later", done: false });
    expect((await store.getOperation("o2"))?.status).toBe("rejected");
  });

  it("E: server commit followed by local apply failure recovers through ledger replay", async () => {
    class FailApplyOnceStore extends MemoryLocalStore {
      fail = true;
      override async applyServerChanges(changes: readonly ServerChange[], epoch?: number) {
        if (changes.length && this.fail) {
          this.fail = false;
          throw new Error("quota while applying ack");
        }
        return super.applyServerChanges(changes, epoch);
      }
    }
    const store = new FailApplyOnceStore();
    let pushes = 0;
    const transport: SyncTransport = {
      async push(request) {
        pushes++;
        const op = request.mutations[0]!;
        return {
          accepted: [{ opId: op.opId, serverResult: { ok: true } }],
          rejected: [],
          idMaps: [],
          changes: [
            serverChange({
              id: op.id,
              kind: "insert",
              version: 1,
              value: { ownerId: "user_a", text: "committed" },
              opId: op.opId,
            }),
          ],
          serverTime: 1,
        };
      },
      pull: acceptAllTransport().pull,
    };
    const { engine } = createHarness({ store, transport, retry: { retries: 0, baseDelayMs: 1 } });
    const call = engine.mutate("todos:create", { localId: "t1", listId: "i", text: "committed" });
    await expect(call.server).rejects.toThrow(/quota while applying/);
    expect((await store.getOperation(call.opId))?.status).toBe("pending");
    await engine.syncOnce();
    expect(pushes).toBe(2);
    expect((await store.getRows("todos"))[0]).toMatchObject({ _id: "t1", text: "committed" });
    expect(await store.getOperation(call.opId)).toBeNull();
  });

  it("E: quota failure on enqueue rejects locally without a phantom and the next write recovers", async () => {
    class QuotaOnceStore extends MemoryLocalStore {
      fail = true;
      override async enqueueOperation(operation: LocalOperation) {
        if (this.fail) {
          this.fail = false;
          throw new DOMException("quota", "QuotaExceededError");
        }
        return super.enqueueOperation(operation);
      }
    }
    const store = new QuotaOnceStore();
    const { engine } = createHarness({
      store,
      transport: { push: () => new Promise(() => {}), pull: acceptAllTransport().pull },
    });
    await expect(
      engine.mutate("todos:create", { localId: "bad", listId: "i", text: "bad" }).local,
    ).rejects.toThrow(/quota/);
    expect(await store.getRows("todos")).toEqual([]);
    expect(await store.getAllOperations()).toEqual([]);
    await engine.mutate("todos:create", { localId: "good", listId: "i", text: "good" }).local;
    expect((await store.getRows("todos")).map((row) => row._id)).toEqual(["good"]);
  });

  it("E: push schemaMismatch skips pull in that same syncOnce", async () => {
    const store = new MemoryLocalStore();
    await store.enqueueOperation(
      pending({ opId: "old", kind: "insert", id: "t1", value: { text: "x" } }),
    );
    const pull = vi.fn(async () => ({ changes: [], cursors: {}, serverTime: 1 }));
    const { engine } = createHarness({
      store,
      transport: {
        async push() {
          return {
            accepted: [],
            rejected: [],
            idMaps: [],
            changes: [],
            serverTime: 1,
            schemaMismatch: true,
          };
        },
        pull,
      },
    });
    await engine.syncOnce([{ kind: "byUser", key: "u:user_a" }]);
    expect(pull).not.toHaveBeenCalled();
    expect(engine.getStatus().blockedBySchemaMismatch).toBe(true);
  });

  it("E: a confirming pull racing the same push applies once, resolves, and advances cursor", async () => {
    const pushResult = deferred<PushResponse>();
    let doorbell: (() => void) | undefined;
    let opId = "";
    const transport: SyncTransport = {
      push: (request) => {
        opId = request.mutations[0]!.opId;
        return pushResult.promise;
      },
      async pull() {
        return {
          changes: [
            serverChange({
              id: "t1",
              kind: "insert",
              version: 1,
              value: { ownerId: "user_a", text: "x" },
              opId,
            }),
          ],
          cursors: { "u:user_a": "1" },
          hasMore: { "u:user_a": false },
          serverTime: 1,
        };
      },
      subscribe(_request, onChange) {
        doorbell = onChange;
        return () => {};
      },
    };
    const { engine, store } = createHarness({ transport });
    const unwatch = engine.watchPlan(collection("todos"));
    // oxlint-disable-next-line no-unmodified-loop-condition -- flipped by an async transport callback via turn()
    while (!doorbell) await turn();
    const call = engine.mutate("todos:create", { localId: "t1", listId: "i", text: "x" });
    await call.local;
    doorbell!();
    while ((await store.getCursor("u:user_a")) !== "1") await turn();
    pushResult.resolve({
      accepted: [{ opId: call.opId, serverResult: { ok: true } }],
      rejected: [],
      idMaps: [],
      changes: [
        serverChange({
          id: "t1",
          kind: "insert",
          version: 1,
          value: { ownerId: "user_a", text: "x" },
          opId: call.opId,
        }),
      ],
      serverTime: 1,
    });
    await expect(call.server).resolves.toEqual({ ok: true });
    expect(await store.getCursor("u:user_a")).toBe("1");
    expect(await store.getRows("todos")).toHaveLength(1);
    expect(await store.getOperation(call.opId)).toBeNull();
    unwatch?.();
  });

  it("E: rejected inserts remain observable through recovery status after reload", async () => {
    const store = new MemoryLocalStore();
    await store.enqueueOperation(
      pending({
        opId: "rejected",
        kind: "insert",
        id: "t1",
        value: { text: "lost" },
        status: "rejected",
      }),
    );
    await store.updateOperationStatus("rejected", "rejected", "denied offline insert");
    const engine = new LocalFirstEngine({
      manifest: createTodoManifest(),
      store,
      clientId: "reload",
      userId: "user_a",
      nameOf: String,
    });
    while (engine.getRecoveryStatus().rejectedOperations.length === 0) await turn();
    expect(engine.getRecoveryStatus().rejectedOperations[0]).toMatchObject({
      opId: "rejected",
      id: "t1",
      error: "denied offline insert",
    });
  });
});
