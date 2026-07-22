import { describe, expect, it } from "vitest";
import {
  MemoryLocalStore,
  byUser,
  createConvexTransport,
  defineLocalFirstManifest,
  localMutation,
  localTable,
  type RowValue,
  type SyncTransport,
} from "../../src/core/index.js";
import { LocalFirstEngine } from "../../src/core/internal.js";
import { handlePush, handlePull, type PushOp, type SyncConfig } from "../../src/server/serverSync";
import { MemoryServerStore } from "../../src/testing/memoryServer";

// §0: undo-of-delete re-inserts the before-row under the SAME localId. The server must
// accept that as a RESURRECTION (the id-map entry points at a now-deleted row), while a
// re-insert over a LIVE row stays a duplicate. serverStamp fields are re-minted fresh and
// must be stripped by the client before the re-insert.

const USER = "u_r";

function serverConfig(): { config: SyncConfig; seq: () => number } {
  let seq = 0;
  const config: SyncConfig = {
    schemaVersion: 1,
    now: () => 1,
    tables: {
      notes: {
        scope: byUser("ownerId"),
        idField: "localId",
        syncedFields: ["ownerId", "localId", "text", "seq"],
        serverOnlyFields: ["seq"],
        serverStamp: () => ({ seq: ++seq }),
        mutations: {
          "notes:create": { kind: "insert", fields: ["ownerId", "localId", "text"] },
          "notes:remove": { kind: "delete", fields: [] },
        },
      },
    },
  };
  return { config, seq: () => seq };
}

const create = (localId: string, opId: string): PushOp => ({
  opId,
  clientId: "c1",
  schemaVersion: 1,
  functionName: "notes:create",
  table: "notes",
  kind: "insert",
  localId,
  value: { ownerId: USER, localId, text: "hello" },
});
const remove = (localId: string, opId: string): PushOp => ({
  opId,
  clientId: "c1",
  schemaVersion: 1,
  functionName: "notes:remove",
  table: "notes",
  kind: "delete",
  localId,
});
const push = (store: MemoryServerStore, config: SyncConfig, mutations: PushOp[]) =>
  handlePush(store, config, { userId: USER, clientId: "c1", schemaVersion: 1, mutations });

describe("§0 server resurrection (undo of delete re-inserts the same localId)", () => {
  it("accepts a re-insert whose id-map entry points at a DELETED row", async () => {
    const store = new MemoryServerStore();
    const { config } = serverConfig();

    expect((await push(store, config, [create("n1", "op1")])).rejected).toEqual([]);
    expect((await push(store, config, [remove("n1", "op2")])).rejected).toEqual([]);
    // Resurrect under the same localId (a fresh opId — the ledger short-circuits the same op).
    const res = await push(store, config, [create("n1", "op3")]);
    expect(res.rejected).toEqual([]);
    expect(res.accepted.map((a) => a.opId)).toEqual(["op3"]);

    // Exactly one LIVE server row for n1, and its id map points at it.
    const live = [...(store.rows.get("notes")?.values() ?? [])].filter((r) => r.localId === "n1");
    expect(live).toHaveLength(1);
  });

  it("still rejects a re-insert over a LIVE row as a duplicate", async () => {
    const store = new MemoryServerStore();
    const { config } = serverConfig();
    expect((await push(store, config, [create("n2", "op1")])).rejected).toEqual([]);
    // n2 is still live: a different op reusing its localId is a collision.
    const res = await push(store, config, [create("n2", "op2")]);
    expect(res.accepted).toEqual([]);
    expect(res.rejected[0]?.message).toMatch(/Duplicate localId/);
  });

  it("re-mints serverStamp fields fresh on resurrection (sequence_id changes)", async () => {
    const store = new MemoryServerStore();
    const { config } = serverConfig();
    await push(store, config, [create("n3", "op1")]);
    const before = [...(store.rows.get("notes")?.values() ?? [])].find((r) => r.localId === "n3");
    expect(before?.seq).toBe(1);

    await push(store, config, [remove("n3", "op2")]);
    await push(store, config, [create("n3", "op3")]);
    const after = [...(store.rows.get("notes")?.values() ?? [])].find((r) => r.localId === "n3");
    // A NEW row with a FRESH sequence number (documented behavior).
    expect(after?.seq).toBe(2);
  });

  it("rejects a client that re-sends the serverStamped field on the re-insert", async () => {
    const store = new MemoryServerStore();
    const { config } = serverConfig();
    await push(store, config, [create("n4", "op1")]);
    await push(store, config, [remove("n4", "op2")]);
    // A NON-stripping client would resend seq — must be rejected (serverOnlyField); the
    // real engine strips it (see the convergence test below).
    const forged: PushOp = {
      ...create("n4", "op3"),
      value: { ownerId: USER, localId: "n4", text: "hello", seq: 99 },
    };
    const res = await push(store, config, [forged]);
    expect(res.accepted).toEqual([]);
    expect(res.rejected[0]?.message).toBe("serverOnlyField");
  });
});

// ---- End-to-end: engine.undo of a delete, over the REAL transport, converges ----------

function manifest() {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      // The client declares `serverFields` so undo-of-delete strips server-minted fields.
      notes: localTable({
        table: "notes",
        idField: "localId",
        scope: byUser("ownerId"),
        indexes: {},
        serverFields: ["seq"],
      }),
    },
    queries: {
      "notes:list": {
        kind: "query",
        name: "notes:list",
        table: "notes",
        initial: [] as readonly RowValue[],
        run: (rows: readonly RowValue[]) => rows,
      },
    },
    mutations: {
      "notes:create": localMutation<{ localId: string; text: string }>({
        kind: "mutation",
        name: "notes:create",
        table: "notes",
        operationKind: "insert",
        plan: (args) => ({
          kind: "insert",
          table: "notes",
          id: args.localId,
          value: { ownerId: USER, text: args.text },
        }),
      }),
      "notes:remove": localMutation<{ localId: string }>({
        kind: "mutation",
        name: "notes:remove",
        table: "notes",
        operationKind: "delete",
        plan: (args) => ({ kind: "delete", table: "notes", id: args.localId }),
      }),
    },
  });
}

describe("§0 end-to-end: undo-of-delete resurrects and a 2nd client converges", () => {
  it("engine.undo strips server fields, the server resurrects, engineB pulls the row", async () => {
    const server = new MemoryServerStore();
    const { config } = serverConfig();
    const SCOPE = { kind: "byUser", key: `u:${USER}`, table: "notes" } as const;
    const client = {
      mutation: async (_r: unknown, args: Record<string, unknown>) =>
        handlePush(server, config, args as never),
      query: async (_r: unknown, args: Record<string, unknown>) =>
        handlePull(server, config, { ...(args as never), cursors: (args.cursors as never) ?? {} }),
    };
    const transport = (clientId: string): SyncTransport =>
      createConvexTransport({ client, push: "PUSH", pull: "PULL", clientId, userId: USER });

    const engineA = new LocalFirstEngine({
      manifest: manifest(),
      store: new MemoryLocalStore(),
      clientId: "a",
      userId: USER,
      transport: transport("a"),
      nameOf: (r) => String(r),
      sleep: async () => {},
    });

    // Create → sync → delete → sync.
    await engineA.mutate("notes:create", { localId: "x1", text: "hello" }).local;
    await engineA.syncOnce([SCOPE]);
    await engineA.mutate("notes:remove", { localId: "x1" }).local;
    await engineA.syncOnce([SCOPE]);
    expect(
      [...(server.rows.get("notes")?.values() ?? [])].filter((r) => r.localId === "x1"),
    ).toHaveLength(0);

    // Undo the delete → re-inserts the stripped before-row → sync → server resurrects.
    // Global undo (byUser stacks key on the user scope, which has no scope-arg form).
    await engineA.undo();
    await engineA.syncOnce([SCOPE]);
    const resurrected = [...(server.rows.get("notes")?.values() ?? [])].filter(
      (r) => r.localId === "x1",
    );
    expect(resurrected).toHaveLength(1);
    expect(resurrected[0]?.text).toBe("hello");
    expect(resurrected[0]?.seq).toBe(2); // re-minted fresh (was 1 before the delete)

    // A second client converges on the resurrected row.
    const engineB = new LocalFirstEngine({
      manifest: manifest(),
      store: new MemoryLocalStore(),
      clientId: "b",
      userId: USER,
      transport: transport("b"),
      nameOf: (r) => String(r),
      sleep: async () => {},
    });
    await engineB.syncOnce([SCOPE]);
    const bRows = (await engineB.query<unknown, RowValue[]>("notes:list", {})) ?? [];
    expect(bRows.filter((r) => r.localId === "x1")).toHaveLength(1);
  });
});
