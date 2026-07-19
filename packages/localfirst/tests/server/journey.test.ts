import { describe, expect, it } from "vitest";
import {
  MemoryLocalStore,
  byUser,
  createConvexTransport,
  defineLocalFirstManifest,
  localMutation,
  localQuery,
  localTable,
  type RowValue,
  type SyncTransport
} from "../../src/core/index.js";
import { LocalFirstEngine } from "../../src/core/internal.js";
import {
  handlePull,
  handlePush,
  type LedgerEntry,
  type ServerOperation,
  type ServerStore,
  type StoredChange,
  type SyncConfig
} from "../../src/server/serverSync";

// =============================================================================
// The DoD §2 end-to-end journey, as ONE automated test: two REAL LocalFirstEngine
// instances bridged through the REAL createConvexTransport <-> handlePush/handlePull,
// over an in-memory authoritative server. No mocked transport on either side.
// =============================================================================

/** Minimal in-memory authoritative server (same contract the Convex component implements). */
class MemoryServerStore implements ServerStore {
  rows = new Map<string, Map<string, Record<string, unknown>>>();
  ledger = new Map<string, LedgerEntry>();
  idmap = new Map<string, string>();
  changes: StoredChange[] = [];
  private seq = 0;
  private serverIdSeq = 0;

  private table(table: string) {
    let m = this.rows.get(table);
    if (!m) {
      m = new Map();
      this.rows.set(table, m);
    }
    return m;
  }
  async getRow(table: string, serverId: string) {
    return this.table(table).get(serverId) ?? null;
  }
  async insertRow(table: string, data: Record<string, unknown>) {
    const serverId = `srv_${++this.serverIdSeq}`;
    this.table(table).set(serverId, { ...data });
    return serverId;
  }
  async patchRow(table: string, serverId: string, patch: Record<string, unknown>) {
    this.table(table).set(serverId, { ...(this.table(table).get(serverId) ?? {}), ...patch });
  }
  async deleteRow(table: string, serverId: string) {
    this.table(table).delete(serverId);
  }
  async getLedger(userId: string, opId: string) {
    return this.ledger.get(`${userId}:${opId}`) ?? null;
  }
  async putLedger(userId: string, _clientId: string, op: ServerOperation, entry: LedgerEntry) {
    this.ledger.set(`${userId}:${op.opId}`, entry);
  }
  async getServerId(table: string, localId: string) {
    return this.idmap.get(`${table}:${localId}`) ?? null;
  }
  async putIdMap(_userId: string, table: string, localId: string, serverId: string) {
    this.idmap.set(`${table}:${localId}`, serverId);
  }
  async appendChange(change: Omit<StoredChange, "changeId">) {
    const changeId = String(++this.seq).padStart(12, "0");
    this.changes.push({ ...change, changeId });
    return changeId;
  }
  async changesAfter(scopeKey: string, cursor: string | null, limit: number) {
    const from = cursor ?? "";
    return this.changes.filter((c) => c.scopeKey === scopeKey && c.changeId > from).slice(0, limit);
  }
  async latestChangeVersion(table: string, localId: string) {
    return this.changes
      .filter((c) => c.table === table && c.localId === localId)
      .reduce((max, c) => Math.max(max, c.version), 0);
  }
  async scopeForLocalId(table: string, localId: string) {
    const rows = this.changes.filter((c) => c.table === table && c.localId === localId);
    return rows.length ? rows[rows.length - 1]!.scopeKey : null;
  }
  async isMember() {
    return true;
  }
}

// Server only knows about `todos`. `drafts` exists on the client (to force a real
// server rejection in the conflict step) but is intentionally absent here.
const config: SyncConfig = {
  schemaVersion: 1,
  now: () => 1,
  tables: { todos: { scope: byUser("ownerId"), idField: "localId" } }
};

type Todo = { localId: string; listId: string; text: string; done: boolean };

function manifest() {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      todos: localTable({ table: "todos", idField: "localId", scope: byUser("ownerId"), indexes: {} }),
      drafts: localTable({ table: "drafts", idField: "localId", scope: byUser("ownerId"), indexes: {} })
    },
    queries: {
      "todos:list": localQuery<{ listId: string }, readonly RowValue[]>({
        kind: "query",
        name: "todos:list",
        table: "todos",
        initial: [],
        run: (rows, args) => rows.filter((r) => r.listId === args.listId)
      })
    },
    mutations: {
      "todos:create": localMutation<Todo>({
        kind: "mutation",
        name: "todos:create",
        table: "todos",
        plan: (args) => ({ kind: "insert", table: "todos", id: args.localId, value: { ownerId: "u_j", ...args } })
      }),
      "todos:toggle": localMutation<{ localId: string; done: boolean }>({
        kind: "mutation",
        name: "todos:toggle",
        table: "todos",
        plan: (args) => ({ kind: "patch", table: "todos", id: args.localId, patch: { done: args.done } })
      }),
      "drafts:create": localMutation<{ localId: string; text: string }>({
        kind: "mutation",
        name: "drafts:create",
        table: "drafts",
        plan: (args) => ({ kind: "insert", table: "drafts", id: args.localId, value: { ownerId: "u_j", ...args } })
      })
    }
  });
}

const USER = "u_j";
const SCOPE = { kind: "byUser", key: `u:${USER}`, table: "todos" } as const;
const noSleep = async () => {};

describe("DoD §2 end-to-end journey (two real engines over the real transport)", () => {
  it("offline create → reload → online push → 2nd client pulls → idempotent → conflict → fallback → logout", async () => {
    const server = new MemoryServerStore();
    const net = { online: true };

    // A real Convex-style client routing the transport's calls to the real engine.
    const client = {
      mutation: async (_ref: unknown, args: Record<string, unknown>) =>
        handlePush(server, config, args as never),
      query: async (_ref: unknown, args: Record<string, unknown>) =>
        handlePull(server, config, { ...(args as never), cursors: (args.cursors as never) ?? {} })
    };
    const gate = (clientId: string): SyncTransport => {
      const real = createConvexTransport({ client, push: "PUSH", pull: "PULL", clientId, userId: USER });
      return {
        push: (r) => (net.online ? real.push(r) : Promise.reject(new Error("offline"))),
        pull: (r) => (net.online ? real.pull(r) : Promise.reject(new Error("offline")))
      };
    };

    const storeA = new MemoryLocalStore();
    const newEngineA = () =>
      new LocalFirstEngine({
        manifest: manifest(),
        store: storeA,
        clientId: "client_a",
        userId: USER,
        transport: gate("client_a"),
        nameOf: (r) => String(r),
        sleep: noSleep
      });
    let engineA = newEngineA();

    // --- Step 1: create a todo while OFFLINE → appears immediately. ---
    net.online = false;
    const call = engineA.mutate<Todo, { ok: boolean }>("todos:create", {
      localId: "t1",
      listId: "inbox",
      text: "Write the e2e test",
      done: false
    });
    await call.local; // local durable write resolves
    await expect(call.server).rejects.toThrow(/offline/); // server push fails while offline
    let rows = (await engineA.query<{ listId: string }, Todo[]>("todos:list", { listId: "inbox" })) ?? [];
    expect(rows.map((r) => r.text)).toEqual(["Write the e2e test"]);
    expect(engineA.getStatus().pendingMutations).toBe(1);

    // --- Step 2: "reload" → new engine on the SAME store → todo survives, still pending. ---
    engineA = newEngineA();
    rows = (await engineA.query<{ listId: string }, Todo[]>("todos:list", { listId: "inbox" })) ?? [];
    expect(rows).toHaveLength(1);
    // Ground truth: the durable outbox entry survived the reload (I3 durability).
    expect(await engineA.store.getPendingOperations()).toHaveLength(1);

    // --- Step 3: go ONLINE → pending op pushes → server owns the row. ---
    net.online = true;
    await engineA.syncOnce([SCOPE]);
    expect(engineA.getStatus().pendingMutations).toBe(0);
    expect(server.changes.filter((c) => c.table === "todos")).toHaveLength(1);

    // --- Step 4: a SECOND client (same user, new device) pulls the todo. ---
    const engineB = new LocalFirstEngine({
      manifest: manifest(),
      store: new MemoryLocalStore(),
      clientId: "client_b",
      userId: USER,
      transport: gate("client_b"),
      nameOf: (r) => String(r),
      sleep: noSleep
    });
    await engineB.syncOnce([SCOPE]);
    let bRows = (await engineB.query<{ listId: string }, Todo[]>("todos:list", { listId: "inbox" })) ?? [];
    expect(bRows.map((r) => r.text)).toEqual(["Write the e2e test"]);

    // --- Step 5: re-push the SAME op → idempotent (server ledger dedupes, no duplicate). ---
    await client.mutation("PUSH", {
      clientId: "client_a",
      userId: USER,
      schemaVersion: 1,
      mutations: [
        {
          opId: server.changes[0].opId,
          clientId: "client_a",
          schemaVersion: 1,
          functionName: "todos:create",
          table: "todos",
          kind: "insert",
          localId: "t1",
          value: { ownerId: USER, localId: "t1", listId: "inbox", text: "Write the e2e test", done: false }
        }
      ]
    });
    await engineB.syncOnce([SCOPE]);
    bRows = (await engineB.query<{ listId: string }, Todo[]>("todos:list", { listId: "inbox" })) ?? [];
    expect(bRows).toHaveLength(1); // still exactly one — no duplicate

    // --- Step 6: force a conflict → queryable rejected status, no crash, todos intact. ---
    const bad = engineA.mutate<{ localId: string; text: string }, unknown>("drafts:create", {
      localId: "d1",
      text: "into a table the server does not know"
    });
    await bad.local;
    await expect(bad.server).rejects.toThrow(/Unknown local-first table/);
    expect(bad.status().status).toBe("rejected");
    // The rest of the app is unaffected — todos still query cleanly.
    rows = (await engineA.query<{ listId: string }, Todo[]>("todos:list", { listId: "inbox" })) ?? [];
    expect(rows).toHaveLength(1);

    // --- Step 7: an ordinary (non-local-first) function is NOT local → React falls through to Convex. ---
    expect(engineA.hasLocalQuery("some:ordinaryConvexQuery")).toBe(false);
    expect(engineA.hasLocalMutation("some:ordinaryConvexMutation")).toBe(false);

    // --- Step 8: logout → local namespace cleared. ---
    await engineA.store.clear();
    rows = (await engineA.query<{ listId: string }, Todo[]>("todos:list", { listId: "inbox" })) ?? [];
    expect(rows).toHaveLength(0);
    expect(await engineA.store.getPendingOperations()).toHaveLength(0);
  });
});
