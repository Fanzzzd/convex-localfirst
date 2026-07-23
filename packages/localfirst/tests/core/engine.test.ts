import { describe, expect, it, vi } from "vitest";
import {
  MemoryLocalStore,
  collection,
  defineLocalFirstManifest,
  localMutation,
  localQuery,
  localTable,
  byUser,
  type SyncTransport,
} from "../../src/core";
import { LocalFirstEngine } from "../../src/core/internal";

function createManifest() {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      todos: localTable({
        table: "todos",
        idField: "localId",
        scope: byUser("ownerId"),
        indexes: {
          byList: ["ownerId", "listId", "createdAt"],
        },
      }),
    },
    queries: {
      "todos:list": localQuery<{ listId: string }, readonly unknown[]>({
        kind: "query",
        name: "todos:list",
        table: "todos",
        initial: [],
        run(rows, args) {
          return rows.filter((row) => row.listId === args.listId);
        },
      }),
    },
    mutations: {
      "todos:create": localMutation<{ listId: string; text: string }>({
        kind: "mutation",
        name: "todos:create",
        table: "todos",
        plan(args, context) {
          return {
            kind: "insert",
            table: "todos",
            id: context.localId("todos"),
            value: {
              ownerId: context.userId ?? "anonymous",
              listId: args.listId,
              text: args.text,
              done: false,
              createdAt: context.now,
              updatedAt: context.now,
            },
          };
        },
      }),
      "todos:update": localMutation<{ id: string; text?: string; done?: boolean }>({
        kind: "mutation",
        name: "todos:update",
        table: "todos",
        plan(args) {
          return {
            kind: "patch",
            table: "todos",
            id: args.id,
            patch: { text: args.text, done: args.done },
          };
        },
      }),
    },
  });
}

describe("LocalFirstEngine", () => {
  it("updates local query before waiting for server ack", async () => {
    const store = new MemoryLocalStore();
    const transport: SyncTransport = {
      async push(request) {
        return {
          accepted: request.mutations.map((operation) => ({
            opId: operation.opId,
            serverResult: { ok: true },
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
    const engine = new LocalFirstEngine({
      manifest: createManifest(),
      store,
      clientId: "client_test",
      userId: "user_a",
      transport,
      nameOf(reference) {
        return String(reference);
      },
      idFactory(table) {
        return `${table}_local_1`;
      },
      clock() {
        return 100;
      },
    });

    const call = engine.mutate("todos:create", { listId: "inbox", text: "hello" });
    await call.local;
    const result = await engine.query<{ listId: string }, readonly { text?: unknown }[]>(
      "todos:list",
      { listId: "inbox" },
    );
    expect(result?.[0]?.text).toBe("hello");
    await expect(call.server).resolves.toEqual({ ok: true });
  });

  it("stamps the idField onto an optimistic row so row[idField] === _id with no server round-trip", async () => {
    // The insert plan's `value` deliberately omits the idField (localId). Before the fix,
    // an optimistic row had _id but row.localId === undefined, while a server-synced row
    // (createSyncFunctions sets value[idField]=localId) had it — an optimistic-vs-synced
    // inconsistency. The engine now stamps it locally too, so reads are uniform.
    const store = new MemoryLocalStore();
    // Pull transport never runs here; push is a no-op so the row stays purely optimistic.
    const transport: SyncTransport = {
      async push(request) {
        return {
          accepted: request.mutations.map((o) => ({ opId: o.opId })),
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
    const engine = new LocalFirstEngine({
      manifest: createManifest(),
      store,
      clientId: "client_test",
      userId: "user_a",
      transport,
      nameOf: (reference) => String(reference),
      idFactory: () => "todos_local_42",
      clock: () => 100,
    });

    const call = engine.mutate("todos:create", { listId: "inbox", text: "hi" });
    const commit = await call.local;
    expect(commit.id).toBe("todos_local_42"); // LocalCommit.id is the new row's id

    const rows = await engine.query<{ listId: string }, readonly Record<string, unknown>[]>(
      "todos:list",
      { listId: "inbox" },
    );
    const row = rows?.[0] as Record<string, unknown>;
    expect(row._id).toBe("todos_local_42");
    expect(row.localId).toBe("todos_local_42"); // the fix: idField present + equal to _id
  });

  it("returns the fully-formed optimistic row on LocalCommit.row (insert), so no readback is needed", async () => {
    // "create returns what you created": an INSERT's commit carries the optimistic row
    // (value + stamped idField) — identical to what a read returns immediately after — so
    // a caller can use it directly instead of a readback round-trip (which also forces a pull).
    const store = new MemoryLocalStore();
    const transport: SyncTransport = {
      async push(request) {
        return {
          accepted: request.mutations.map((o) => ({ opId: o.opId })),
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
    const engine = new LocalFirstEngine({
      manifest: createManifest(),
      store,
      clientId: "client_test",
      userId: "user_a",
      transport,
      nameOf: (reference) => String(reference),
      idFactory: () => "todos_local_7",
      clock: () => 100,
    });

    const commit = await engine.mutate("todos:create", { listId: "inbox", text: "hi" }).local;
    expect(commit.row).toBeDefined();
    expect(commit.row?.localId).toBe("todos_local_7"); // idField stamped == commit.id
    expect(commit.row?.text).toBe("hi");
    expect(commit.row?.listId).toBe("inbox");
    // matches a fresh read of the same row — the readback it replaces
    const rows = await engine.runLocalQuery(collection("todos"));
    expect((rows[0] as Record<string, unknown>).localId).toBe(commit.row?.localId);
  });

  it("returns the merged row on LocalCommit.row (patch), symmetric with insert — no readback", async () => {
    // A PATCH's commit carries the canonical-plus-pending merge AFTER the patch, identical
    // to getRow(table, id) right after — so an update site uses it directly instead of a
    // separate readback (completing the insert/patch symmetry).
    const store = new MemoryLocalStore();
    const transport: SyncTransport = {
      async push(request) {
        return {
          accepted: request.mutations.map((o) => ({ opId: o.opId })),
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
    const engine = new LocalFirstEngine({
      manifest: createManifest(),
      store,
      clientId: "client_patch",
      userId: "user_a",
      transport,
      nameOf: (r) => String(r),
      idFactory: () => "todos_local_p",
      clock: () => 100,
    });

    await engine.mutate("todos:create", { listId: "inbox", text: "before" }).local;
    const commit = await engine.mutate("todos:update", {
      id: "todos_local_p",
      text: "after",
      done: true,
    }).local;

    // the merged row reflects this patch over the prior insert (other fields preserved)
    expect(commit.row).toBeDefined();
    expect(commit.row?.localId).toBe("todos_local_p"); // == commit.id
    expect(commit.row?.text).toBe("after");
    expect(commit.row?.done).toBe(true);
    expect(commit.row?.listId).toBe("inbox"); // untouched insert field survives the merge
    // identical to the readback it replaces
    const readback = await engine.getRow<Record<string, unknown>>("todos", "todos_local_p");
    expect(commit.row).toEqual(readback);

    // patching a row that isn't local yet -> row is undefined (not invented)
    const cold = await engine.mutate("todos:update", { id: "todos_not_here", text: "x" }).local;
    expect(cold.row).toBeUndefined();
  });

  it("getRow(table, id) returns the live row by id (optimistic + canonical), undefined if absent", async () => {
    // The by-id readback primitive: scope-free, local-only (no pull), includes pending ops.
    const store = new MemoryLocalStore();
    const transport: SyncTransport = {
      async push(request) {
        return {
          accepted: request.mutations.map((o) => ({ opId: o.opId })),
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
    const engine = new LocalFirstEngine({
      manifest: createManifest(),
      store,
      clientId: "client_g",
      userId: "user_a",
      transport,
      nameOf: (r) => String(r),
      idFactory: () => "todos_local_g",
      clock: () => 100,
    });

    // optimistic insert -> getRow finds it with no scope + no pull
    await engine.mutate("todos:create", { listId: "inbox", text: "opt" }).local;
    const opt = await engine.getRow<Record<string, unknown>>("todos", "todos_local_g");
    expect(opt?.text).toBe("opt");
    expect(opt?.localId).toBe("todos_local_g");

    // canonical (server-pulled) row -> also found by id
    await store.applyServerChange({
      changeId: "c1",
      scopeKey: "byUser:user_a",
      table: "todos",
      id: "todos_srv_1",
      kind: "insert",
      value: {
        localId: "todos_srv_1",
        ownerId: "user_a",
        listId: "inbox",
        text: "srv",
        done: false,
        createdAt: 1,
        updatedAt: 1,
      },
      version: 1,
      serverTime: 1,
    });
    const srv = await engine.getRow<Record<string, unknown>>("todos", "todos_srv_1");
    expect(srv?.text).toBe("srv");

    // absent -> undefined
    expect(await engine.getRow("todos", "nope")).toBeUndefined();
  });

  it("read(plan) refreshes then returns local rows, and never throws when the transport is down (offline-first)", async () => {
    // The canonical one-call imperative read: refresh-if-online + serve local. A failing
    // transport (offline / backend down) must NOT make a read throw — it serves local.
    const store = new MemoryLocalStore();
    let pushed = 0;
    let pulled = 0;
    const transport: SyncTransport = {
      async push() {
        pushed += 1;
        throw new Error("backend down");
      },
      async pull() {
        pulled += 1;
        throw new Error("backend down");
      },
    };
    const engine = new LocalFirstEngine({
      manifest: createManifest(),
      store,
      clientId: "client_r",
      userId: "user_a",
      transport,
      nameOf: (r) => String(r),
      idFactory: () => "todos_local_r",
      clock: () => 100,
    });

    await engine.mutate("todos:create", { listId: "inbox", text: "offline-row" }).local;

    // read() must refresh (attempt the sync) AND still return the local optimistic row,
    // without throwing — even though the transport rejects.
    const rows = await engine.read<Record<string, unknown>, unknown>(
      collection("todos").scope({ ownerId: "user_a" }),
    );
    expect(rows.map((r) => r.text)).toEqual(["offline-row"]);
    expect(pushed + pulled).toBeGreaterThan(0); // it actually attempted a refresh

    // Contract: ignoring .server (the optimistic pattern above) must NOT raise an
    // unhandled rejection when offline — but a caller who OPTS IN via .server still
    // observes the failure (the floating catch marks the push handled, not resolved).
    const call = engine.mutate("todos:create", { listId: "inbox", text: "opt-in" });
    await call.local; // optimistic part succeeds
    await expect(call.server).rejects.toThrow("backend down");
  });

  it("surfaces row[idField] === _id on a SERVER-PULLED row via the headless runLocalQuery path", async () => {
    // The other half of the idField guarantee: a row this client did NOT create,
    // arriving from the server (createSyncFunctions stamps value[idField]=localId;
    // the transport keys it by localId). A headless consumer reading via
    // collection().scope() must see row[idField] populated and equal to _id with no
    // `?? _id` workaround — exactly what the Plane service layer relies on after sync.
    const store = new MemoryLocalStore();
    const transport: SyncTransport = {
      async push(request) {
        return {
          accepted: request.mutations.map((o) => ({ opId: o.opId })),
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
    const engine = new LocalFirstEngine({
      manifest: createManifest(),
      store,
      clientId: "client_b",
      userId: "user_a",
      transport,
      nameOf: (reference) => String(reference),
      idFactory: () => "todos_local_unused",
      clock: () => 100,
    });

    // Shaped exactly as transport.toClientChange delivers a pulled insert: id is the
    // localId, value carries the server-stamped idField (here "localId").
    await store.applyServerChange({
      changeId: "chg_1",
      scopeKey: "byUser:user_a",
      table: "todos",
      id: "todos_srv_7",
      kind: "insert",
      value: {
        localId: "todos_srv_7",
        ownerId: "user_a",
        listId: "inbox",
        text: "from server",
        done: false,
        createdAt: 1,
        updatedAt: 1,
      },
      version: 1,
      serverTime: 1,
    });

    const rows = await engine.runLocalQuery(collection("todos").scope({ ownerId: "user_a" }));
    const row = rows[0] as Record<string, unknown>;
    expect(row._id).toBe("todos_srv_7");
    expect(row.localId).toBe("todos_srv_7"); // idField present on the synced row, equal to _id
    expect(row.text).toBe("from server");
  });

  it("offline (navigator.onLine === false): sync is a no-op so reads/writes never hang", async () => {
    // Regression for the offline-first hang: when the OS is offline, syncOnce must NOT
    // await the transport (a buffering client never resolves). Without the guard this
    // test would hang on the never-resolving transport and time out.
    vi.stubGlobal("navigator", { onLine: false });
    try {
      const store = new MemoryLocalStore();
      const hang: SyncTransport = {
        push: () => new Promise(() => {}),
        pull: () => new Promise(() => {}),
      };
      const engine = new LocalFirstEngine({
        manifest: createManifest(),
        store,
        clientId: "client_off",
        userId: "user_a",
        transport: hang,
        nameOf: (r) => String(r),
        idFactory: () => "todos_local_off",
        clock: () => 100,
      });

      // Create while offline: commits locally, stays pending (the background push hangs — ignored).
      const call = engine.mutate("todos:create", { listId: "inbox", text: "made offline" });
      await call.local;
      void call.server.catch(() => {});

      // The read path pulls-then-reads; the offline guard makes the pull a fast no-op
      // instead of awaiting the hanging transport.
      await engine.syncOnce([{ kind: "byUser", key: "u:user_a", table: "todos" }]);

      const rows = await engine.runLocalQuery(collection("todos"));
      expect(rows.length).toBe(1);
      expect((rows[0] as Record<string, unknown>).text).toBe("made offline");
      // Still owed to the server — it will flush on reconnect, not silently dropped.
      expect((await store.getPendingOperations()).length).toBe(1);
      engine.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("server unreachable (online, no response): sync fails fast via timeout instead of hanging", async () => {
    // navigator is online (no offline guard), but the backend never responds (e.g. it
    // died while the OS stayed online). Without a bounded timeout, syncOnce — and any
    // awaited read — would hang forever. With it, the call rejects quickly and the engine
    // is marked offline so the UI can degrade to local data.
    const store = new MemoryLocalStore();
    const hang: SyncTransport = {
      push: () => new Promise(() => {}),
      pull: () => new Promise(() => {}),
    };
    const engine = new LocalFirstEngine({
      manifest: createManifest(),
      store,
      clientId: "client_unreachable",
      userId: "user_a",
      transport: hang,
      nameOf: (r) => String(r),
      clock: () => 100,
      retry: { retries: 0, baseDelayMs: 1 },
      syncTimeoutMs: 80,
    });

    await expect(
      engine.syncOnce([{ kind: "byUser", key: "u:user_a", table: "todos" }]),
    ).rejects.toThrow(/timed out/i);
    expect(engine.getStatus().online).toBe(false);
    engine.dispose();
  });
});
