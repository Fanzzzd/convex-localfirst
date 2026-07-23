import { describe, expect, it } from "vitest";
import { byUser, byWorkspace } from "../../src/core/index.js";
import {
  handlePush,
  type LedgerEntry,
  type PushOp,
  type ServerOperation,
  type ServerStore,
  type StoredChange,
  type SyncConfig,
} from "../../src/server/serverSync";

// Minimal in-memory authoritative server (same contract the Convex component implements).
class MemoryServerStore implements ServerStore {
  rows = new Map<string, Map<string, Record<string, unknown>>>();
  ledger = new Map<string, LedgerEntry>();
  idmap = new Map<string, string>();
  changes: StoredChange[] = [];
  members = new Set<string>();
  rowVersions = new Map<
    string,
    { table: string; localId: string; rowKey: string; scopeKey: string; version: number }
  >();
  private seq = 0;
  private serverIdSeq = 0;
  /** Denylist of `${table}:${localId}` an access.write hook rejects (for authz tests). */
  denyWrite = new Set<string>();

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
    this.table(table).set(serverId, { ...this.table(table).get(serverId), ...patch });
  }
  async deleteRow(table: string, serverId: string) {
    this.table(table).delete(serverId);
  }
  async getLedger(userId: string, opId: string) {
    return this.ledger.get(`${userId}:${opId}`) ?? null;
  }
  async commitOp(
    userId: string,
    operation: ServerOperation,
    entry: Omit<LedgerEntry, "schemaVersion" | "changes">,
    change?: Omit<StoredChange, "changeId">,
  ) {
    if (this.ledger.has(`${userId}:${operation.opId}`))
      throw new Error(`ops: duplicate commit for ${operation.opId}`);
    let stored: StoredChange | null = null;
    if (change) {
      const changeId = await this.appendChange(change);
      stored = { ...change, changeId };
    }
    this.ledger.set(`${userId}:${operation.opId}`, {
      ...entry,
      schemaVersion: operation.schemaVersion,
      changes: stored ? [stored] : undefined,
    });
    return stored;
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
    this.rowVersions.set(`${change.table}:${change.localId}`, {
      table: change.table,
      localId: change.localId,
      rowKey: `${change.table}:${change.localId}`,
      scopeKey: change.scopeKey,
      version: change.version,
    });
    return changeId;
  }
  async changesAfter() {
    return [];
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
}

const config: SyncConfig = {
  schemaVersion: 1,
  now: () => 1,
  tables: {
    todos: {
      scope: byUser("ownerId"),
      idField: "localId",
      mutations: {
        "todos:create": {
          kind: "insert",
          fields: ["ownerId", "localId", "listId", "text", "done"],
        },
        "todos:toggle": { kind: "patch", fields: ["done", "text"] },
        "todos:remove": { kind: "delete", fields: [] },
      },
    },
    docs: {
      scope: byWorkspace({ workspaceIdField: "wsId", membershipTable: "ws_members" }),
      idField: "localId",
      mutations: {
        "docs:create": { kind: "insert", fields: ["wsId", "localId", "title"] },
        "docs:update": { kind: "patch", fields: ["title"] },
        "docs:remove": { kind: "delete", fields: [] },
      },
    },
  },
  access: {
    member: ({ userId, scopeValue, membershipTable }, store) =>
      (store as MemoryServerStore).members.has(`${userId}:${scopeValue}:${membershipTable}`)
        ? "member"
        : null,
    // Deny any write to a row on the store's denylist (for the mid-group authz test).
    write: ({ table, before, proposed }, ...rest) => {
      // The bound signature passes the store as the runtime second arg via serverSync's
      // configFor; here we read the denylist off a module-level ref set per test.
      void rest;
      const localId = (proposed?.localId ?? before?.localId) as string | undefined;
      return !(localId !== undefined && denyRef.has(`${table}:${localId}`));
    },
  },
};

// The access.write hook above has no store handle in serverSync's bound form, so tests
// point this module ref at the active store's denylist before pushing.
let denyRef = new Set<string>();

function op(input: {
  opId: string;
  fn: string;
  table: string;
  kind: ServerOperation["kind"];
  localId: string;
  value?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  group?: { groupId: string; groupSize: number; groupIndex: number };
}): PushOp {
  return {
    opId: input.opId,
    clientId: "c1",
    schemaVersion: 1,
    functionName: input.fn,
    table: input.table,
    kind: input.kind,
    localId: input.localId,
    value: input.value,
    patch: input.patch,
    ...input.group,
  };
}

const G = (groupId: string, size: number) => (index: number) => ({
  groupId,
  groupSize: size,
  groupIndex: index,
});

describe("server sync — atomic write groups (DX v4 §5)", () => {
  it("applies an all-pass group atomically: every op accepted, one change each", async () => {
    const store = new MemoryServerStore();
    denyRef = store.denyWrite;
    const g = G("grp1", 3);
    const res = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [
        op({
          opId: "o1",
          fn: "todos:create",
          table: "todos",
          kind: "insert",
          localId: "t1",
          value: { listId: "a", text: "one" },
          group: g(0),
        }),
        op({
          opId: "o2",
          fn: "todos:create",
          table: "todos",
          kind: "insert",
          localId: "t2",
          value: { listId: "a", text: "two" },
          group: g(1),
        }),
        op({
          opId: "o3",
          fn: "todos:toggle",
          table: "todos",
          kind: "patch",
          localId: "t1",
          patch: { done: true },
          group: g(2),
        }),
      ],
    });
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted.map((a) => a.opId).sort()).toEqual(["o1", "o2", "o3"]);
    expect(res.changes).toHaveLength(3);
    // Two rows exist; t1 is done.
    expect(store.rows.get("todos")?.size).toBe(2);
    const t1 = [...(store.rows.get("todos")?.values() ?? [])].find((r) => r.localId === "t1");
    expect(t1?.done).toBe(true);
    // Ledger records each op as accepted.
    expect(store.ledger.get("user_a:o1")?.status).toBe("accepted");
    expect(store.ledger.get("user_a:o3")?.status).toBe("accepted");
  });

  it("insert-then-patch-same-row: the later patch validates against the in-group insert (overlay)", async () => {
    const store = new MemoryServerStore();
    denyRef = store.denyWrite;
    const g = G("grp-ip", 2);
    const res = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [
        op({
          opId: "i1",
          fn: "todos:create",
          table: "todos",
          kind: "insert",
          localId: "t9",
          value: { listId: "a", text: "hi" },
          group: g(0),
        }),
        op({
          opId: "p1",
          fn: "todos:toggle",
          table: "todos",
          kind: "patch",
          localId: "t9",
          patch: { text: "edited", done: true },
          group: g(1),
        }),
      ],
    });
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted).toHaveLength(2);
    const t9 = [...(store.rows.get("todos")?.values() ?? [])].find((r) => r.localId === "t9");
    expect(t9).toMatchObject({ text: "edited", done: true });
  });

  it("mid-group authz failure rejects the WHOLE group with zero side effects", async () => {
    const store = new MemoryServerStore();
    denyRef = store.denyWrite;
    store.members.add("user_a:ws1:ws_members");
    // The second op (patch of d2) is denied by access.write.
    store.denyWrite.add("docs:d2");
    const g = G("grp-fail", 3);
    const res = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [
        op({
          opId: "a1",
          fn: "docs:create",
          table: "docs",
          kind: "insert",
          localId: "d1",
          value: { wsId: "ws1", title: "d1" },
          group: g(0),
        }),
        op({
          opId: "a2",
          fn: "docs:create",
          table: "docs",
          kind: "insert",
          localId: "d2",
          value: { wsId: "ws1", title: "d2" },
          group: g(1),
        }),
        op({
          opId: "a3",
          fn: "docs:update",
          table: "docs",
          kind: "patch",
          localId: "d2",
          patch: { title: "changed" },
          group: g(2),
        }),
      ],
    });
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected.map((r) => r.opId).sort()).toEqual(["a1", "a2", "a3"]);
    // Every rejection carries the group reason.
    for (const r of res.rejected) expect(r.message).toMatch(/^groupRejected: /);
    // ZERO side effects: no rows, no changes written for any member op.
    expect(store.rows.get("docs")?.size ?? 0).toBe(0);
    expect(store.changes).toHaveLength(0);
    // Ledger records each op rejected (so replay re-rejects).
    expect(store.ledger.get("user_a:a1")?.status).toBe("rejected");
    expect(store.ledger.get("user_a:a3")?.status).toBe("rejected");
  });

  it("replay idempotency: re-pushing an accepted group re-acks with stored changes (any subset)", async () => {
    const store = new MemoryServerStore();
    denyRef = store.denyWrite;
    const g = G("grp-replay", 2);
    const mutations = [
      op({
        opId: "r1",
        fn: "todos:create",
        table: "todos",
        kind: "insert",
        localId: "t1",
        value: { listId: "a", text: "one" },
        group: g(0),
      }),
      op({
        opId: "r2",
        fn: "todos:create",
        table: "todos",
        kind: "insert",
        localId: "t2",
        value: { listId: "a", text: "two" },
        group: g(1),
      }),
    ];
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations,
    });
    const rowsAfterFirst = store.rows.get("todos")?.size;
    // Full replay.
    const replay = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations,
    });
    expect(replay.accepted.map((a) => a.opId).sort()).toEqual(["r1", "r2"]);
    expect(replay.rejected).toHaveLength(0);
    // Re-delivers the confirming changes; no new rows.
    expect(replay.changes).toHaveLength(2);
    expect(store.rows.get("todos")?.size).toBe(rowsAfterFirst);
    // Subset replay (just one member) still re-acks that member from the ledger.
    const subset = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [mutations[0]!],
    });
    expect(subset.accepted.map((a) => a.opId)).toEqual(["r1"]);
    expect(subset.changes).toHaveLength(1);
  });

  it("replay idempotency: re-pushing a rejected group re-rejects", async () => {
    const store = new MemoryServerStore();
    denyRef = store.denyWrite;
    store.members.add("user_a:ws1:ws_members");
    store.denyWrite.add("docs:d2");
    const g = G("grp-rr", 2);
    const mutations = [
      op({
        opId: "x1",
        fn: "docs:create",
        table: "docs",
        kind: "insert",
        localId: "d1",
        value: { wsId: "ws1", title: "d1" },
        group: g(0),
      }),
      op({
        opId: "x2",
        fn: "docs:create",
        table: "docs",
        kind: "insert",
        localId: "d2",
        value: { wsId: "ws1", title: "d2" },
        group: g(1),
      }),
    ];
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations,
    });
    const replay = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations,
    });
    expect(replay.accepted).toHaveLength(0);
    expect(replay.rejected.map((r) => r.opId).sort()).toEqual(["x1", "x2"]);
  });

  it("interop: ungrouped ops in the same push are unaffected by a group's rejection", async () => {
    const store = new MemoryServerStore();
    denyRef = store.denyWrite;
    store.members.add("user_a:ws1:ws_members");
    store.denyWrite.add("docs:d2");
    const g = G("grp-mix", 2);
    const res = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [
        // A plain ungrouped op — no group fields, exactly the historical shape.
        op({
          opId: "u1",
          fn: "todos:create",
          table: "todos",
          kind: "insert",
          localId: "t1",
          value: { listId: "a", text: "solo" },
        }),
        // A group that fails on its second member.
        op({
          opId: "g1",
          fn: "docs:create",
          table: "docs",
          kind: "insert",
          localId: "d1",
          value: { wsId: "ws1", title: "d1" },
          group: g(0),
        }),
        op({
          opId: "g2",
          fn: "docs:update",
          table: "docs",
          kind: "patch",
          localId: "d2",
          patch: { title: "z" },
          group: g(1),
        }),
      ],
    });
    // The ungrouped op is accepted; the group is fully rejected.
    expect(res.accepted.map((a) => a.opId)).toEqual(["u1"]);
    expect(res.rejected.map((r) => r.opId).sort()).toEqual(["g1", "g2"]);
    expect(store.rows.get("todos")?.size).toBe(1);
    expect(store.rows.get("docs")?.size ?? 0).toBe(0);
  });
});
