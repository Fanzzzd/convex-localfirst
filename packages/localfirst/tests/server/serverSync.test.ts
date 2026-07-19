import { describe, expect, it } from "vitest";
import { convexToJson, jsonToConvex } from "convex/values";
import { byUser, byWorkspace } from "../../src/core/index.js";
import {
  applyServerWrite,
  handlePull,
  handlePush,
  scopeKeyForUser,
  type LedgerEntry,
  type PushInput,
  type PushOp,
  type ServerOperation,
  type ServerStore,
  type StoredChange,
  type SyncConfig
} from "../../src/server/serverSync";

class MemoryServerStore implements ServerStore {
  rows = new Map<string, Map<string, Record<string, unknown>>>();
  ledger = new Map<string, LedgerEntry>();
  idmap = new Map<string, string>();
  changes: StoredChange[] = []; // append-only
  members = new Set<string>();
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
    // Store exactly what serverSync inserts — no synthetic _version column (the
    // real Convex backend's schema would reject unknown fields).
    this.table(table).set(serverId, { ...data });
    return serverId;
  }
  async patchRow(table: string, serverId: string, patch: Record<string, unknown>) {
    const current = this.table(table).get(serverId) ?? {};
    this.table(table).set(serverId, { ...current, ...patch });
  }
  async deleteRow(table: string, serverId: string) {
    this.table(table).delete(serverId);
  }

  async getLedger(userId: string, opId: string) {
    // Keyed by (userId, opId) only — opId is globally unique, so a replay under a
    // different envelope clientId (reload/new tab) still dedups.
    return this.ledger.get(`${userId}:${opId}`) ?? null;
  }
  async putLedger(userId: string, _clientId: string, op: ServerOperation, entry: LedgerEntry) {
    this.ledger.set(`${userId}:${op.opId}`, entry);
  }

  async getServerId(table: string, localId: string) {
    // Keyed by (table, localId) only — any authorized member resolves the row,
    // not just its creator.
    return this.idmap.get(`${table}:${localId}`) ?? null;
  }
  async putIdMap(_userId: string, table: string, localId: string, serverId: string) {
    this.idmap.set(`${table}:${localId}`, serverId);
  }

  rowVersions = new Map<string, { table: string; localId: string; rowKey: string; scopeKey: string; version: number }>();

  async appendChange(change: Omit<StoredChange, "changeId">) {
    const changeId = String(++this.seq).padStart(12, "0"); // lexicographically monotonic
    this.changes.push({ ...change, changeId });
    this.rowVersions.set(`${change.table}:${change.localId}`, {
      table: change.table,
      localId: change.localId,
      rowKey: `${change.table}:${change.localId}`,
      scopeKey: change.scopeKey,
      version: change.version
    });
    return changeId;
  }

  /** Test helper simulating the component's opportunistic GC: prune this scope's
   *  oldest changes, always keeping the newest `keepLast`. */
  gc(scopeKey: string, keepLast = 1) {
    const rel = this.changes.filter((c) => c.scopeKey === scopeKey);
    const cut = new Set(rel.slice(0, Math.max(0, rel.length - keepLast)));
    this.changes = this.changes.filter((c) => !cut.has(c));
  }

  async firstChangeId(scopeKey: string) {
    const rel = this.changes.filter((c) => c.scopeKey === scopeKey);
    return rel.length ? rel[0]!.changeId : null;
  }
  async lastChangeId(scopeKey: string) {
    const rel = this.changes.filter((c) => c.scopeKey === scopeKey);
    return rel.length ? rel[rel.length - 1]!.changeId : null;
  }
  async rowVersionsByScope(scopeKey: string, afterRowKey: string | null, limit: number) {
    return [...this.rowVersions.values()]
      .filter((r) => r.scopeKey === scopeKey && r.rowKey > (afterRowKey ?? ""))
      .sort((a, b) => (a.rowKey < b.rowKey ? -1 : 1))
      .slice(0, limit);
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
    // Newest change for (table, localId), mirroring the component's by_table_local desc.
    const rows = this.changes.filter((c) => c.table === table && c.localId === localId);
    return rows.length ? rows[rows.length - 1]!.scopeKey : null;
  }

  async isMember(userId: string, scopeValue: string, membershipTable: string) {
    // Key on the membership table too, so a read/write that checks the WRONG
    // table (a real bug) is caught here instead of silently passing.
    return this.members.has(`${userId}:${scopeValue}:${membershipTable}`);
  }
}

const config: SyncConfig = {
  schemaVersion: 1,
  now: () => 1,
  tables: {
    todos: { scope: byUser("ownerId"), idField: "localId" },
    docs: {
      scope: byWorkspace({ workspaceIdField: "wsId", membershipTable: "ws_members" }),
      idField: "localId",
    },
  }
};

const insert = (localId: string, value: Record<string, unknown>, opId = `op_${localId}`): PushOp => ({
  opId,
  clientId: "c1",
  schemaVersion: 1,
  functionName: "todos:create",
  table: "todos",
  kind: "insert",
  localId,
  value
});

describe("server sync — security", () => {
  it("byUser: a user cannot pull another user's rows", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t1", { listId: "inbox", text: "a-secret" })]
    });

    const pulled = await handlePull(store, config, {
      userId: "user_b",
      clientId: "cB",
      schemaVersion: 1,
      scopes: [{ kind: "byUser" }],
      cursors: {}
    });
    expect(pulled.changes).toHaveLength(0);

    const own = await handlePull(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      scopes: [{ kind: "byUser" }],
      cursors: {}
    });
    expect(own.changes).toHaveLength(1);
  });

  it("byUser: client-supplied owner id is ignored (forced to the authed user)", async () => {
    const store = new MemoryServerStore();
    const res = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t1", { ownerId: "user_b", listId: "inbox", text: "x" })] // lying client
    });
    expect(res.accepted).toHaveLength(1);
    expect(res.changes[0]?.data?.ownerId).toBe("user_a");
    expect(res.changes[0]?.scopeKey).toBe(scopeKeyForUser("user_a"));
  });

  it("byWorkspace: membership is required to write and read", async () => {
    const store = new MemoryServerStore();
    store.members.add("user_a:ws1:ws_members"); // a is a member of ws1 (via ws_members), c is not

    const docOp: PushOp = {
      opId: "d1",
      clientId: "c1",
      schemaVersion: 1,
      functionName: "docs:create",
      table: "docs",
      kind: "insert",
      localId: "d1",
      value: { wsId: "ws1", title: "hello" }
    };

    const member = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [docOp]
    });
    expect(member.accepted).toHaveLength(1);

    const nonMember = await handlePush(store, config, {
      userId: "user_c",
      clientId: "cC",
      schemaVersion: 1,
      mutations: [{ ...docOp, opId: "d2", localId: "d2" }]
    });
    expect(nonMember.rejected[0]?.message).toContain("member");

    // Member pull of ws1 sees the doc — read membership uses the SAME configured
    // table (ws_members) as write. (Regression guard for the pull/push table mismatch.)
    const memberPull = await handlePull(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      scopes: [{ kind: "byWorkspace", value: "ws1" }],
      cursors: {}
    });
    expect(memberPull.changes).toHaveLength(1);

    // Non-member pull of ws1 yields nothing.
    const pull = await handlePull(store, config, {
      userId: "user_c",
      clientId: "cC",
      schemaVersion: 1,
      scopes: [{ kind: "byWorkspace", value: "ws1" }],
      cursors: {}
    });
    expect(pull.changes).toHaveLength(0);
  });

  it("byWorkspace: a patch cannot move a row to another scope or rewrite its id (I7)", async () => {
    const store = new MemoryServerStore();
    store.members.add("user_a:ws1:ws_members"); // member of ws1 only
    const docOp: PushOp = {
      opId: "d1", clientId: "c1", schemaVersion: 1, functionName: "docs:create",
      table: "docs", kind: "insert", localId: "d1", value: { wsId: "ws1", title: "hello" }
    };
    await handlePush(store, config, { userId: "user_a", clientId: "c1", schemaVersion: 1, mutations: [docOp] });

    // Try to move the row into ws2 (not a member) via a patch on the scope field.
    const moveScope = await handlePush(store, config, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      mutations: [{ opId: "p1", clientId: "c1", schemaVersion: 1, functionName: "docs:update", table: "docs", kind: "patch", localId: "d1", patch: { wsId: "ws2" } }]
    });
    expect(moveScope.accepted).toHaveLength(0);
    expect(moveScope.rejected[0]?.message).toContain("scope field");
    // The row stays in ws1.
    const serverId = (await store.getServerId("docs", "d1")) as string;
    expect((await store.getRow("docs", serverId))?.wsId).toBe("ws1");

    // Rewriting the id field is also rejected.
    const moveId = await handlePush(store, config, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      mutations: [{ opId: "p2", clientId: "c1", schemaVersion: 1, functionName: "docs:update", table: "docs", kind: "patch", localId: "d1", patch: { localId: "evil" } }]
    });
    expect(moveId.rejected[0]?.message).toContain("id field");
  });

  it("byWorkspace: a different member can patch a row created by another (id map is not per-user)", async () => {
    const store = new MemoryServerStore();
    store.members.add("user_a:ws1:ws_members");
    store.members.add("user_b:ws1:ws_members"); // both are members of ws1
    await handlePush(store, config, {
      userId: "user_a", clientId: "cA", schemaVersion: 1,
      mutations: [{ opId: "d1", clientId: "cA", schemaVersion: 1, functionName: "docs:create", table: "docs", kind: "insert", localId: "d1", value: { wsId: "ws1", title: "hi" } }]
    });

    // user_b (NOT the creator) patches the same row — must resolve the serverId.
    const res = await handlePush(store, config, {
      userId: "user_b", clientId: "cB", schemaVersion: 1,
      mutations: [{ opId: "p1", clientId: "cB", schemaVersion: 1, functionName: "docs:update", table: "docs", kind: "patch", localId: "d1", patch: { title: "edited by b" } }]
    });
    expect(res.accepted).toHaveLength(1);
    const serverId = (await store.getServerId("docs", "d1")) as string;
    expect((await store.getRow("docs", serverId))?.title).toBe("edited by b");
  });

  it("byWorkspace: a patch cannot authorize via a forged op.value scope (scope comes from the row, I7)", async () => {
    const store = new MemoryServerStore();
    store.members.add("user_a:ws1:ws_members"); // a in ws1
    store.members.add("user_b:ws2:ws_members"); // b in ws2, NOT ws1
    await handlePush(store, config, {
      userId: "user_a", clientId: "cA", schemaVersion: 1,
      mutations: [{ opId: "d1", clientId: "cA", schemaVersion: 1, functionName: "docs:create", table: "docs", kind: "insert", localId: "d1", value: { wsId: "ws1", title: "secret" } }]
    });

    // b is a member of ws2 but the row is in ws1; claiming wsId: ws2 in op.value
    // must NOT authorize the write — scope is derived from the existing row (ws1).
    const res = await handlePush(store, config, {
      userId: "user_b", clientId: "cB", schemaVersion: 1,
      mutations: [{ opId: "p1", clientId: "cB", schemaVersion: 1, functionName: "docs:update", table: "docs", kind: "patch", localId: "d1", value: { wsId: "ws2" }, patch: { title: "hacked" } }]
    });
    expect(res.accepted).toHaveLength(0);
    // Generic patch rejection (no oracle); the security property is the untouched row below.
    expect(res.rejected[0]?.message).toContain("Cannot patch");
    const serverId = (await store.getServerId("docs", "d1")) as string;
    expect((await store.getRow("docs", serverId))?.title).toBe("secret"); // untouched
  });

  it("byUser: a user cannot patch or delete another user's row (id map is global, ownership is checked)", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a", clientId: "cA", schemaVersion: 1, mutations: [insert("t1", { text: "a-private" })]
    });

    const patch = await handlePush(store, config, {
      userId: "user_b", clientId: "cB", schemaVersion: 1,
      mutations: [{ opId: "p1", clientId: "cB", schemaVersion: 1, functionName: "todos:toggle", table: "todos", kind: "patch", localId: "t1", patch: { done: true } }]
    });
    // Patch uses one generic message for every denial (no existence/ownership oracle).
    expect(patch.rejected[0]?.message).toContain("Cannot patch");

    const del = await handlePush(store, config, {
      userId: "user_b", clientId: "cB", schemaVersion: 1,
      mutations: [{ opId: "del1", clientId: "cB", schemaVersion: 1, functionName: "todos:remove", table: "todos", kind: "delete", localId: "t1" }]
    });
    // Delete uses one generic message for every denial (no existence/ownership oracle).
    expect(del.rejected[0]?.message).toContain("Cannot delete");

    const serverId = (await store.getServerId("todos", "t1")) as string;
    expect(await store.getRow("todos", serverId)).toBeTruthy(); // intact
  });

  it("delete is idempotent for the AUTHORIZED owner: a second delete is an accepted no-op (no serverId leak)", async () => {
    const store = new MemoryServerStore();
    const del = (opId: string, localId: string, userId = "user_a", clientId = "c1"): PushOp => ({
      opId, clientId, schemaVersion: 1, functionName: "todos:remove", table: "todos", kind: "delete", localId
    });

    // Real delete then a SECOND delete by the same owner (concurrent-compaction /
    // replay shape): the first emits a delete change, the second is an accepted no-op
    // that emits no change and — crucially — does NOT echo the (now-gone) serverId.
    await handlePush(store, config, { userId: "user_a", clientId: "c1", schemaVersion: 1, mutations: [insert("t1", { text: "x" })] });
    const first = await handlePush(store, config, { userId: "user_a", clientId: "cA", schemaVersion: 1, mutations: [del("dA", "t1")] });
    expect(first.changes.some((c) => c.kind === "delete" && c.localId === "t1")).toBe(true);

    const second = await handlePush(store, config, { userId: "user_a", clientId: "cB", schemaVersion: 1, mutations: [del("dB", "t1")] });
    expect(second.rejected).toEqual([]); // no "No server row" error
    expect(second.accepted[0]?.opId).toBe("dB");
    expect(second.changes).toEqual([]); // nothing new to append — already gone
    expect((second.accepted[0]?.serverResult as { serverId?: string })?.serverId).toBeUndefined(); // no id leak
  });

  it("delete is NOT an existence/ownership oracle: same localId rejects identically whether never-seen, foreign-live, or foreign-gone", async () => {
    // The oracle test probes the SAME localId ("t1") across three parallel universes.
    // The rejection must be a pure function of (table, localId) — both attacker-known
    // — so it carries ZERO bits about the row's true state. Different localIds would
    // trivially differ; identical localId is what proves indistinguishability.
    const probe = (store: MemoryServerStore) =>
      handlePush(store, config, {
        userId: "user_b", clientId: "cB", schemaVersion: 1,
        mutations: [{ opId: "probe", clientId: "cB", schemaVersion: 1, functionName: "todos:remove", table: "todos", kind: "delete", localId: "t1" }]
      });
    const seed = (store: MemoryServerStore, mutations: PushInput["mutations"]) =>
      handlePush(store, config, { userId: "user_a", clientId: "cA", schemaVersion: 1, mutations });
    const remove = (localId: string) => ({ opId: `d_${localId}`, clientId: "cA", schemaVersion: 1, functionName: "todos:remove", table: "todos", kind: "delete" as const, localId });

    // U1: t1 never existed. U2: t1 is a foreign LIVE row. U3: t1 is foreign and GONE.
    const u1 = new MemoryServerStore();
    const u2 = new MemoryServerStore();
    await seed(u2, [insert("t1", { text: "x" })]);
    const u3 = new MemoryServerStore();
    await seed(u3, [insert("t1", { text: "x" })]);
    await seed(u3, [remove("t1")]);

    const [neverSeen, foreignLive, foreignGone] = await Promise.all([probe(u1), probe(u2), probe(u3)]);
    for (const r of [neverSeen, foreignLive, foreignGone]) {
      expect(r.accepted).toEqual([]);
      expect(r.rejected).toHaveLength(1);
    }
    const messages = new Set([neverSeen, foreignLive, foreignGone].map((r) => r.rejected[0]?.message));
    expect(messages.size).toBe(1); // identical rejection for every state — no oracle
    // The foreign LIVE row was NOT deleted by the rejected probe.
    expect(await u2.getRow("todos", u2.idmap.get("todos:t1") as string)).not.toBeNull();
  });

  it("patch is NOT an existence/ownership oracle: same localId rejects identically whether never-seen or foreign-live", async () => {
    // Same construction as the delete oracle test, for the patch path.
    const probe = (store: MemoryServerStore) =>
      handlePush(store, config, {
        userId: "user_b", clientId: "cB", schemaVersion: 1,
        mutations: [{ opId: "p", clientId: "cB", schemaVersion: 1, functionName: "todos:toggle", table: "todos", kind: "patch", localId: "t1", patch: { text: "hijack" } }]
      });

    const u1 = new MemoryServerStore(); // t1 never existed
    const u2 = new MemoryServerStore(); // t1 is a foreign LIVE row
    await handlePush(u2, config, { userId: "user_a", clientId: "cA", schemaVersion: 1, mutations: [insert("t1", { text: "x" })] });

    const [neverSeen, foreignLive] = await Promise.all([probe(u1), probe(u2)]);
    for (const r of [neverSeen, foreignLive]) {
      expect(r.accepted).toEqual([]);
      expect(r.rejected).toHaveLength(1);
    }
    expect(new Set([neverSeen, foreignLive].map((r) => r.rejected[0]?.message)).size).toBe(1);
    // The foreign LIVE row's value is untouched by the rejected patch.
    expect((await u2.getRow("todos", u2.idmap.get("todos:t1") as string))?.text).toBe("x");
  });

  it("rejects an insert that reuses an existing localId (localId is not a capability)", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a", clientId: "cA", schemaVersion: 1, mutations: [insert("t1", { text: "first" })]
    });
    const dup = await handlePush(store, config, {
      userId: "user_b", clientId: "cB", schemaVersion: 1, mutations: [insert("t1", { text: "second" }, "op_dup")]
    });
    expect(dup.accepted).toHaveLength(0);
    expect(dup.rejected[0]?.message).toContain("Duplicate");
  });

  it("rejects a pull when two tables of a scope kind use different membership tables (I7)", async () => {
    const store = new MemoryServerStore();
    const mixed: SyncConfig = {
      schemaVersion: 1,
      now: () => 1,
      tables: {
        docs: { scope: byWorkspace({ workspaceIdField: "wsId", membershipTable: "ws_members" }), idField: "localId" },
        secrets: { scope: byWorkspace({ workspaceIdField: "wsId", membershipTable: "secret_members" }), idField: "localId" }
      }
    };
    await expect(
      handlePull(store, mixed, { userId: "u", clientId: "c", schemaVersion: 1, scopes: [{ kind: "byWorkspace", value: "ws1" }], cursors: {} })
    ).rejects.toThrow(/membershipTable/);
  });

  it("blocks sync on schema mismatch", async () => {
    const store = new MemoryServerStore();
    const res = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 999,
      mutations: [insert("t1", { text: "x" })]
    });
    expect(res.schemaMismatch).toBe(true);
    expect(res.accepted).toHaveLength(0);
  });
});

describe("server sync — component (ledger/changes/idmap)", () => {
  it("ledger dedupes by (user, opId) — a re-pushed op applies once", async () => {
    const store = new MemoryServerStore();
    const op = insert("t1", { listId: "inbox", text: "x" });
    const input = { userId: "user_a", clientId: "c1", schemaVersion: 1, mutations: [op] };

    const first = await handlePush(store, config, input);
    const second = await handlePush(store, config, input);

    expect(first.accepted).toHaveLength(1);
    expect(second.accepted).toHaveLength(1); // returns the prior result
    expect(store.changes).toHaveLength(1); // applied only once
    expect(store.table("todos").size).toBe(1); // one row inserted
  });

  it("dedupes a durable op replayed under a DIFFERENT clientId (reload / new tab)", async () => {
    // The reload bug: a pending op survives in IndexedDB and is re-pushed after a
    // reload, but the engine envelope now carries a fresh clientId. Keying the ledger
    // by (userId, opId) — opId is globally unique — must still dedup it, so the insert
    // is applied exactly once (not re-applied / rejected as a duplicate localId).
    const op = insert("t1", { listId: "inbox", text: "x" });
    const store = new MemoryServerStore();

    const first = await handlePush(store, config, { userId: "user_a", clientId: "mount-A", schemaVersion: 1, mutations: [op] });
    expect(first.accepted).toHaveLength(1);
    expect(first.rejected).toHaveLength(0);

    // Same op (same opId), replayed under a brand-new mount's clientId:
    const replay = await handlePush(store, config, { userId: "user_a", clientId: "mount-B", schemaVersion: 1, mutations: [op] });
    expect(replay.rejected).toHaveLength(0); // NOT a "Duplicate localId" rejection
    expect(replay.accepted).toHaveLength(1); // returns the prior result
    expect(store.changes).toHaveLength(1); // applied exactly once (log NOT re-appended)
    expect(store.table("todos").size).toBe(1);
    // Recovery: the replay RE-DELIVERS the confirming change so a client whose original
    // ack was lost can apply it and leave _pending (instead of replaying forever).
    expect(replay.changes).toHaveLength(1);
    expect(replay.changes[0]?.localId).toBe("t1");
    expect(replay.changes[0]?.changeId).toBe(first.changes[0]?.changeId); // same canonical change
  });

  it("a no-op (delete-of-already-gone) replay re-delivers nothing (no spurious change)", async () => {
    // The ledger only carries a change when the op produced one. A duplicate no-op
    // delete must dedup to accepted WITHOUT inventing a change.
    const store = new MemoryServerStore();
    await handlePush(store, config, { userId: "user_a", clientId: "c1", schemaVersion: 1, mutations: [insert("t1", { text: "x" })] });
    const del = { opId: "d1", clientId: "c1", schemaVersion: 1, functionName: "todos:remove", table: "todos", kind: "delete" as const, localId: "t1" };
    const first = await handlePush(store, config, { userId: "user_a", clientId: "c1", schemaVersion: 1, mutations: [del] });
    expect(first.changes).toHaveLength(1); // the real delete change
    const replay = await handlePush(store, config, { userId: "user_a", clientId: "c2", schemaVersion: 1, mutations: [del] });
    expect(replay.accepted).toHaveLength(1);
    expect(replay.changes[0]?.changeId).toBe(first.changes[0]?.changeId); // re-delivers the delete change
  });

  it("change log is append-only with monotonically increasing changeIds", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t1", { text: "a" }), insert("t2", { text: "b" }), insert("t3", { text: "c" })]
    });
    const ids = store.changes.map((c) => c.changeId);
    expect(ids).toHaveLength(3);
    expect([...ids].sort()).toEqual(ids); // already sorted = monotonic
  });

  it("cursor advances monotonically across pulls", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t1", { text: "a" })]
    });

    const scopeKey = scopeKeyForUser("user_a");
    const p1 = await handlePull(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      scopes: [{ kind: "byUser" }],
      cursors: {}
    });
    const c1 = p1.cursors[scopeKey];

    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t2", { text: "b" })]
    });

    const p2 = await handlePull(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      scopes: [{ kind: "byUser" }],
      cursors: { [scopeKey]: c1 }
    });
    expect(p2.changes).toHaveLength(1); // only the new change
    expect(p2.cursors[scopeKey] > c1).toBe(true); // cursor moved forward
  });

  it("id map resolves local id to server id (patch targets the inserted row)", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t1", { listId: "inbox", text: "x", done: false })]
    });
    const serverId = await store.getServerId("todos", "t1");
    expect(serverId).toBeTruthy();

    const patch = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [
        {
          opId: "p1",
          clientId: "c1",
          schemaVersion: 1,
          functionName: "todos:toggle",
          table: "todos",
          kind: "patch",
          localId: "t1",
          patch: { done: true }
        }
      ]
    });
    expect(patch.accepted).toHaveLength(1);
    const row = await store.getRow("todos", serverId as string);
    expect(row?.done).toBe(true);
    // Row version lives in the change log, NOT on the user row — writing `_version`
    // onto the row would break real Convex schema validation. (regression guard)
    expect(row && "_version" in row).toBe(false);
    // the change still carries a bumped version (advanced past the insert) — assert it
    // advanced, not the exact number, so the versioning scheme can change without churn.
    expect(patch.changes[0]?.version ?? 0).toBeGreaterThan(1);
  });

  it("a delete change is visible to a client behind the cursor, not past it", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t1", { text: "x" })]
    });
    const del = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [
        { opId: "del1", clientId: "c1", schemaVersion: 1, functionName: "todos:remove", table: "todos", kind: "delete", localId: "t1" }
      ]
    });
    const deleteChangeId = del.changes[0]?.changeId as string;
    const insertChangeId = String(Number(deleteChangeId) - 1).padStart(12, "0");

    // A client BEHIND the delete (cursor at the insert) sees it incrementally.
    const behind = await handlePull(store, config, {
      userId: "user_a",
      clientId: "c2",
      schemaVersion: 1,
      scopes: [{ kind: "byUser" }],
      cursors: { [scopeKeyForUser("user_a")]: insertChangeId }
    });
    expect(behind.changes.some((c) => c.kind === "delete" && c.localId === "t1")).toBe(true);

    // A COLD client bootstraps from current rows: the deleted row simply never
    // appears (no history replay, no delete change needed).
    const fresh = await handlePull(store, config, {
      userId: "user_a",
      clientId: "c3",
      schemaVersion: 1,
      scopes: [{ kind: "byUser" }],
      cursors: {}
    });
    expect(fresh.changes).toHaveLength(0);
    expect(fresh.snapshotScopes).toContain(scopeKeyForUser("user_a"));
    expect(fresh.cursors[scopeKeyForUser("user_a")]).toBe(deleteChangeId); // caught up

    // A client already past the delete does not see it again.
    const past = await handlePull(store, config, {
      userId: "user_a",
      clientId: "c2",
      schemaVersion: 1,
      scopes: [{ kind: "byUser" }],
      cursors: { [scopeKeyForUser("user_a")]: deleteChangeId }
    });
    expect(past.changes).toHaveLength(0);
  });
});

describe("server sync — schema guard + value codec", () => {
  it("rejects a stale offline op whose per-op schemaVersion differs from the envelope (I8)", async () => {
    const store = new MemoryServerStore();
    const staleOp: PushOp = { ...insert("t1", { listId: "inbox", text: "x" }), schemaVersion: 2 };
    const res = await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [staleOp]
    });
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.message).toMatch(/schema v2/);
    // The stale op must NOT have been applied to the canonical log.
    const pulled = await handlePull(store, config, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, scopes: [{ kind: "byUser" }], cursors: {}
    });
    expect(pulled.changes).toHaveLength(0);
  });

  it("a multi-page bootstrap pages via bootstrapCursors and lands on the end cursor", async () => {
    const store = new MemoryServerStore();
    const cfg: SyncConfig = { ...config, pullLimit: 2 };
    await handlePush(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      mutations: [
        insert("t1", { listId: "i", text: "a" }),
        insert("t2", { listId: "i", text: "b" }),
        insert("t3", { listId: "i", text: "c" })
      ]
    });
    const sk = scopeKeyForUser("user_a");
    const first = await handlePull(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, scopes: [{ kind: "byUser" }], cursors: {}
    });
    expect(first.changes).toHaveLength(2);
    expect(first.hasMore[sk]).toBe(true);
    expect(first.snapshotScopes).toContain(sk); // first page resets
    expect(first.bootstrapCursors[sk]).toBeDefined();
    const second = await handlePull(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, scopes: [{ kind: "byUser" }],
      cursors: { [sk]: first.cursors[sk] || null },
      bootstrapCursors: first.bootstrapCursors
    });
    expect(second.changes).toHaveLength(1);
    expect(second.hasMore[sk]).toBe(false);
    expect(second.snapshotScopes).toContain(sk); // every page is marked a snapshot page
    expect(second.cursors[sk]).toBe("000000000003"); // caught up to the log
  });

  it("pull reports per-scope hasMore when an incremental page hits the pull limit", async () => {
    const store = new MemoryServerStore();
    const cfg: SyncConfig = { ...config, pullLimit: 2 };
    await handlePush(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      mutations: [
        insert("t1", { listId: "i", text: "a" }),
        insert("t2", { listId: "i", text: "b" }),
        insert("t3", { listId: "i", text: "c" })
      ]
    });
    const sk = scopeKeyForUser("user_a");
    // Warm client one change behind the head: cursor at the first insert.
    const first = await handlePull(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, scopes: [{ kind: "byUser" }],
      cursors: { [sk]: "000000000001" }
    });
    expect(first.changes).toHaveLength(2);
    expect(first.hasMore[sk]).toBe(true);
    const second = await handlePull(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, scopes: [{ kind: "byUser" }],
      cursors: { [sk]: first.cursors[sk] }
    });
    expect(second.changes).toHaveLength(0);
    expect(second.hasMore[sk]).toBe(false);
  });

  it("a cursor behind the GC horizon is reset and re-bootstrapped from current rows", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      mutations: [
        insert("t1", { text: "a" }),
        insert("t2", { text: "b" })
      ]
    });
    // Delete t1, then GC everything except the newest change: the delete is pruned.
    await handlePush(store, config, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      mutations: [
        { opId: "del1", clientId: "c1", schemaVersion: 1, functionName: "todos:remove", table: "todos", kind: "delete", localId: "t1" },
        insert("t3", { text: "c" })
      ]
    });
    const sk = scopeKeyForUser("user_a");
    store.gc(sk, 1); // only the newest change (t3's insert) survives

    // A client whose cursor predates the horizon (it saw only t1+t2) must NOT sync
    // incrementally — it would miss the pruned delete and keep t1 as a ghost.
    const res = await handlePull(store, config, {
      userId: "user_a", clientId: "c2", schemaVersion: 1, scopes: [{ kind: "byUser" }],
      cursors: { [sk]: "000000000002" }
    });
    expect(res.snapshotScopes).toContain(sk);
    const ids = res.changes.map((c) => c.localId).sort();
    expect(ids).toEqual(["t2", "t3"]); // t1 is gone; the reset evicts it client-side
    expect(res.cursors[sk]).toBe("000000000004");

    // A client exactly at the last retained change stays incremental (no reset).
    const warm = await handlePull(store, config, {
      userId: "user_a", clientId: "c3", schemaVersion: 1, scopes: [{ kind: "byUser" }],
      cursors: { [sk]: "000000000004" }
    });
    expect(warm.snapshotScopes).toHaveLength(0);
    expect(warm.changes).toHaveLength(0);
  });

  it("bootstrapping an empty scope completes with the zero cursor (no re-bootstrap loop)", async () => {
    const store = new MemoryServerStore();
    const sk = scopeKeyForUser("user_a");
    const first = await handlePull(store, config, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, scopes: [{ kind: "byUser" }], cursors: {}
    });
    expect(first.changes).toHaveLength(0);
    expect(first.cursors[sk]).toBe("000000000000");
    const second = await handlePull(store, config, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, scopes: [{ kind: "byUser" }],
      cursors: { [sk]: first.cursors[sk] }
    });
    expect(second.snapshotScopes).toHaveLength(0); // incremental from the zero cursor
    expect(second.changes).toHaveLength(0);
  });

  it("round-trips bigint/bytes row values losslessly via the injected Convex codec", async () => {
    const convexCodec: SyncConfig["valueCodec"] = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      encode: (val) => JSON.stringify(convexToJson((val === undefined ? null : val) as any)),
      decode: (s) => jsonToConvex(JSON.parse(s))
    };
    const store = new MemoryServerStore();
    const cfg: SyncConfig = { ...config, valueCodec: convexCodec };
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const value = { listId: "inbox", text: "x", amount: 10n, blob: bytes };

    const res = await handlePush(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, mutations: [insert("t1", value)]
    });
    expect(res.accepted).toHaveLength(1);
    expect(res.changes[0]?.data?.amount).toBe(10n); // bigint survives, no throw

    // A duplicate push reads the confirming change back through the codec (changesJson).
    const dup = await handlePush(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, mutations: [insert("t1", value)]
    });
    expect(dup.accepted).toHaveLength(1);
    expect(dup.changes[0]?.data?.amount).toBe(10n); // round-tripped through changesJson
  });
});

describe("server sync — set-field merge", () => {
  it("materializes a SetDelta patch against the current row and merges concurrent adds (no clobber)", async () => {
    const store = new MemoryServerStore();
    // canonical todo with labels ["a"]
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t1", { listId: "inbox", text: "x", labels: ["a"] })]
    });

    // Client A adds "b" (delta vs its base ["a"]).
    const a = await handlePush(store, config, {
      userId: "user_a",
      clientId: "cA",
      schemaVersion: 1,
      mutations: [
        {
          opId: "pA",
          clientId: "cA",
          schemaVersion: 1,
          functionName: "todos:update",
          table: "todos",
          kind: "patch",
          localId: "t1",
          patch: { labels: { __lfSet: { add: ["b"], remove: [] } } }
        }
      ]
    });
    expect(a.rejected).toHaveLength(0);
    // The change log carries the MATERIALIZED array (pull stays delta-free).
    expect(a.changes[0]?.patch?.labels).toEqual(["a", "b"]);

    // Client B concurrently adds "c" (delta vs the SAME base ["a"]). Server materializes
    // against the CURRENT row (now ["a","b"]) → ["a","b","c"]: A's add is NOT clobbered.
    const b = await handlePush(store, config, {
      userId: "user_a",
      clientId: "cB",
      schemaVersion: 1,
      mutations: [
        {
          opId: "pB",
          clientId: "cB",
          schemaVersion: 1,
          functionName: "todos:update",
          table: "todos",
          kind: "patch",
          localId: "t1",
          patch: { labels: { __lfSet: { add: ["c"], remove: [] } } }
        }
      ]
    });
    expect(b.rejected).toHaveLength(0);
    expect(b.changes[0]?.patch?.labels).toEqual(["a", "b", "c"]);

    // Final stored row reflects BOTH concurrent adds.
    const serverId = await store.getServerId("todos", "t1");
    const row = serverId ? await store.getRow("todos", serverId) : null;
    expect((row?.labels as string[]).slice().sort()).toEqual(["a", "b", "c"]);
  });

  it("rejects a set delta over a non-array field (client bug/forge) instead of corrupting it", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t2", { listId: "inbox", text: "scalar" })]
    });
    const res = await handlePush(store, config, {
      userId: "user_a",
      clientId: "cA",
      schemaVersion: 1,
      mutations: [
        {
          opId: "pX",
          clientId: "cA",
          schemaVersion: 1,
          functionName: "todos:update",
          table: "todos",
          kind: "patch",
          localId: "t2",
          patch: { text: { __lfSet: { add: ["oops"], remove: [] } } } // "text" is a scalar
        }
      ]
    });
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.message).toMatch(/non-array field "text"/);
  });

  it("treats a set delta over an ABSENT (undefined) optional field as empty, not a forge (Plane's optional member_ids)", async () => {
    // A row inserted WITHOUT the set field (an optional array, e.g. modules.member_ids) —
    // current[field] is undefined, NOT a wrong-typed value. The first add must be ACCEPTED
    // and materialize to [el], not rejected as a non-array forge. Guards serverSync's
    // `current[field] !== undefined &&` clause: dropping it would silently break the first
    // member-add on any module created without member_ids.
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t4", { listId: "inbox", text: "no-labels-yet" })] // labels field absent
    });
    const res = await handlePush(store, config, {
      userId: "user_a",
      clientId: "cA",
      schemaVersion: 1,
      mutations: [
        {
          opId: "pY",
          clientId: "cA",
          schemaVersion: 1,
          functionName: "todos:update",
          table: "todos",
          kind: "patch",
          localId: "t4",
          patch: { labels: { __lfSet: { add: ["b"], remove: [] } } }
        }
      ]
    });
    expect(res.rejected).toHaveLength(0);
    expect(res.changes[0]?.patch?.labels).toEqual(["b"]); // materialized from empty
  });
});

describe("server sync — counter-field merge", () => {
  it("materializes a CounterDelta patch against the current row and accumulates concurrent increments", async () => {
    const store = new MemoryServerStore();
    // canonical todo with votes=3
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t1", { listId: "inbox", text: "x", votes: 3 })]
    });

    // Client A increments +2 (delta vs its base 3).
    const a = await handlePush(store, config, {
      userId: "user_a",
      clientId: "cA",
      schemaVersion: 1,
      mutations: [
        { opId: "pA", clientId: "cA", schemaVersion: 1, functionName: "todos:update", table: "todos", kind: "patch", localId: "t1", patch: { votes: { __lfCounter: 2 } } }
      ]
    });
    expect(a.rejected).toHaveLength(0);
    expect(a.changes[0]?.patch?.votes).toBe(5); // materialized number, not a delta (pull stays delta-free)

    // Client B concurrently increments +1 (delta vs the SAME base 3). Server materializes
    // against the CURRENT row (now 5) → 6: A's increment is NOT clobbered.
    const b = await handlePush(store, config, {
      userId: "user_a",
      clientId: "cB",
      schemaVersion: 1,
      mutations: [
        { opId: "pB", clientId: "cB", schemaVersion: 1, functionName: "todos:update", table: "todos", kind: "patch", localId: "t1", patch: { votes: { __lfCounter: 1 } } }
      ]
    });
    expect(b.rejected).toHaveLength(0);
    expect(b.changes[0]?.patch?.votes).toBe(6);

    const serverId = await store.getServerId("todos", "t1");
    const row = serverId ? await store.getRow("todos", serverId) : null;
    expect(row?.votes).toBe(6); // both concurrent increments accumulated
  });

  it("rejects a counter delta over a non-number field (client bug/forge) instead of corrupting it", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t2", { listId: "inbox", text: "scalar" })]
    });
    const res = await handlePush(store, config, {
      userId: "user_a",
      clientId: "cA",
      schemaVersion: 1,
      mutations: [
        { opId: "pX", clientId: "cA", schemaVersion: 1, functionName: "todos:update", table: "todos", kind: "patch", localId: "t2", patch: { text: { __lfCounter: 1 } } } // "text" is a string
      ]
    });
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.message).toMatch(/non-number field "text"/);
  });

  it("treats a counter delta over an ABSENT (undefined) field as 0, not a forge", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a",
      clientId: "c1",
      schemaVersion: 1,
      mutations: [insert("t3", { listId: "inbox", text: "no-votes-yet" })] // votes field absent
    });
    const res = await handlePush(store, config, {
      userId: "user_a",
      clientId: "cA",
      schemaVersion: 1,
      mutations: [
        { opId: "pY", clientId: "cA", schemaVersion: 1, functionName: "todos:update", table: "todos", kind: "patch", localId: "t3", patch: { votes: { __lfCounter: 2 } } }
      ]
    });
    expect(res.rejected).toHaveLength(0);
    expect(res.changes[0]?.patch?.votes).toBe(2); // materialized from 0
  });
});


describe("server sync — server-authored writes (applyServerWrite)", () => {
  const wsConfig: SyncConfig = {
    schemaVersion: 1,
    now: () => 42,
    tables: {
      activities: {
        scope: byWorkspace({ workspaceIdField: "wsId", membershipTable: "ws_members" }),
        idField: "localId",
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" }
      }
    }
  };
  let n = 0;
  const nextId = () => `sv_${++n}`;

  it("insert lands in rows + id map + change log with stamped id/timestamps", async () => {
    const store = new MemoryServerStore();
    const res = await applyServerWrite(
      store,
      wsConfig,
      { kind: "insert", table: "activities", value: { wsId: "w1", verb: "created" } },
      nextId
    );
    expect(res.serverId).toBeDefined();
    const row = await store.getRow("activities", res.serverId!);
    expect(row).toMatchObject({ wsId: "w1", verb: "created", localId: res.localId, created_at: 42, updated_at: 42 });
    expect(store.changes).toHaveLength(1);
    expect(store.changes[0]).toMatchObject({ scopeKey: "byWorkspace:w1", kind: "insert", localId: res.localId, version: 1 });
  });

  it("patch stamps updated_at, appends a v2 change, and refuses scope/id rewrites", async () => {
    const store = new MemoryServerStore();
    const { localId } = await applyServerWrite(
      store,
      wsConfig,
      { kind: "insert", table: "activities", value: { wsId: "w1", verb: "created" } },
      nextId
    );
    await applyServerWrite(store, wsConfig, { kind: "patch", table: "activities", localId, patch: { verb: "edited" } }, nextId);
    expect(store.changes[1]).toMatchObject({ kind: "patch", version: 2, patch: { verb: "edited", updated_at: 42 } });
    await expect(
      applyServerWrite(store, wsConfig, { kind: "patch", table: "activities", localId, patch: { wsId: "w2" } }, nextId)
    ).rejects.toThrow(/scope field/);
  });

  it("delete appends a delete change; deleting again is a commuting no-op", async () => {
    const store = new MemoryServerStore();
    const { localId } = await applyServerWrite(
      store,
      wsConfig,
      { kind: "insert", table: "activities", value: { wsId: "w1", verb: "created" } },
      nextId
    );
    await applyServerWrite(store, wsConfig, { kind: "delete", table: "activities", localId }, nextId);
    expect(store.changes[1]).toMatchObject({ kind: "delete", version: 2, localId });
    const again = await applyServerWrite(store, wsConfig, { kind: "delete", table: "activities", localId }, nextId);
    expect(again.serverId).toBeUndefined();
    expect(store.changes).toHaveLength(2); // no extra change appended
  });
});

describe("server sync — bootstrap hardening", () => {
  it("bootstrap projects rows to syncedFields — server-only extra columns never leak", async () => {
    const store = new MemoryServerStore();
    const cfg: SyncConfig = {
      ...config,
      tables: { todos: { scope: byUser("ownerId"), idField: "localId", syncedFields: ["ownerId", "text", "localId"] } }
    };
    await handlePush(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      mutations: [insert("t1", { text: "x" })]
    });
    // Simulate a server-only `extra` column written by ordinary Convex code.
    const serverId = await store.getServerId("todos", "t1");
    await store.patchRow("todos", serverId!, { internalFlag: "moderation-hold" });

    const res = await handlePull(store, cfg, {
      userId: "user_a", clientId: "c2", schemaVersion: 1, scopes: [{ kind: "byUser" }], cursors: {}
    });
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]!.data).toEqual({ ownerId: "user_a", text: "x", localId: "t1" });
    expect("internalFlag" in res.changes[0]!.data!).toBe(false);
  });

  it("the final bootstrap page reports hasMore when changes landed during the bootstrap", async () => {
    const store = new MemoryServerStore();
    const cfg: SyncConfig = { ...config, pullLimit: 1 };
    await handlePush(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      mutations: [insert("t1", { text: "a" }), insert("t2", { text: "b" })]
    });
    const sk = scopeKeyForUser("user_a");
    const first = await handlePull(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, scopes: [{ kind: "byUser" }], cursors: {}
    });
    expect(first.bootstrapCursors[sk]).toBeDefined();
    expect(sk in first.cursors).toBe(false); // no cursor persisted mid-bootstrap

    // A concurrent write lands while the bootstrap is paging.
    await handlePush(store, cfg, {
      userId: "user_a", clientId: "cX", schemaVersion: 1,
      mutations: [insert("t3", { text: "c" })]
    });

    // Drain the remaining bootstrap pages to completion.
    let boot = first.bootstrapCursors;
    let res = first;
    for (let i = 0; i < 5 && boot[sk]; i++) {
      res = await handlePull(store, cfg, {
        userId: "user_a", clientId: "c1", schemaVersion: 1, scopes: [{ kind: "byUser" }],
        cursors: {}, bootstrapCursors: boot
      });
      boot = res.bootstrapCursors;
    }
    // Final page: cursor lands on the bootstrap's END cursor (t2's change), and
    // hasMore says the mid-bootstrap append (t3) still owes an incremental pass.
    expect(res.cursors[sk]).toBe("000000000002");
    expect(res.hasMore[sk]).toBe(true);
    const incr = await handlePull(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, scopes: [{ kind: "byUser" }],
      cursors: { [sk]: res.cursors[sk] }
    });
    expect(incr.changes.map((c) => c.localId)).toEqual(["t3"]);
  });

  it("a doorbell pull never takes the bootstrap path (cheap reactive watch)", async () => {
    const store = new MemoryServerStore();
    await handlePush(store, config, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      mutations: [insert("t1", { text: "a" }), insert("t2", { text: "b" })]
    });
    const res = await handlePull(store, config, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, scopes: [{ kind: "byUser" }],
      cursors: {}, doorbell: true
    });
    expect(res.snapshotScopes).toHaveLength(0);
    expect(res.changes.length).toBeLessThanOrEqual(1); // one change per scope, max
  });
});

describe("server sync — membership revocation", () => {
  it("a denied scope is reported so the client evicts it", async () => {
    const store = new MemoryServerStore();
    store.members.add("user_a:ws1:ws_members");
    await handlePush(store, config, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      mutations: [{ opId: "d1", clientId: "c1", schemaVersion: 1, functionName: "docs:create", table: "docs", kind: "insert", localId: "d1", value: { wsId: "ws1", title: "hello" } }]
    });
    // Revoke and pull: no changes, and the scope is called out as denied.
    store.members.delete("user_a:ws1:ws_members");
    const res = await handlePull(store, config, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      scopes: [{ kind: "byWorkspace", value: "ws1" }], cursors: {}
    });
    expect(res.changes).toHaveLength(0);
    expect(res.deniedScopes).toEqual(["byWorkspace:ws1"]);
  });
});

describe("server sync — row-level visibility", () => {
  // Plane-style guest rule: within an authorized workspace, "guest" only sees docs
  // they created. The membership check still gates the SCOPE; visibility filters ROWS.
  const guestConfig = (): SyncConfig => ({
    ...config,
    tables: {
      ...config.tables,
      docs: {
        ...config.tables.docs!,
        visibility: ({ userId, row }) => userId === "member" || row.createdBy === userId
      }
    }
  });
  const doc = (opId: string, localId: string, createdBy: string, title = "t"): ServerOperation => ({
    opId, clientId: "c1", schemaVersion: 1, functionName: "docs:create", table: "docs",
    kind: "insert", localId, value: { wsId: "ws1", title, createdBy }
  });
  function seededStore() {
    const store = new MemoryServerStore();
    for (const u of ["member", "guest"]) store.members.add(`${u}:ws1:ws_members`);
    return store;
  }

  it("bootstrap: a guest gets only rows the predicate admits", async () => {
    const store = seededStore();
    await handlePush(store, guestConfig(), {
      userId: "member", clientId: "c1", schemaVersion: 1,
      mutations: [doc("o1", "d1", "member"), doc("o2", "d2", "guest")]
    });
    const res = await handlePull(store, guestConfig(), {
      userId: "guest", clientId: "cg", schemaVersion: 1,
      scopes: [{ kind: "byWorkspace", value: "ws1" }], cursors: {}
    });
    expect(res.changes.map((c) => c.localId)).toEqual(["d2"]);
    const memberRes = await handlePull(store, guestConfig(), {
      userId: "member", clientId: "cm", schemaVersion: 1,
      scopes: [{ kind: "byWorkspace", value: "ws1" }], cursors: {}
    });
    expect(memberRes.changes.map((c) => c.localId).sort()).toEqual(["d1", "d2"]);
  });

  it("incremental: invisible inserts are withheld; a row entering visibility arrives as a full-row upsert", async () => {
    const store = seededStore();
    // Guest is warm at cursor 0-equivalent: bootstrap an empty scope first.
    const cold = await handlePull(store, guestConfig(), {
      userId: "guest", clientId: "cg", schemaVersion: 1,
      scopes: [{ kind: "byWorkspace", value: "ws1" }], cursors: {}
    });
    const sk = "byWorkspace:ws1";
    const cursor = cold.cursors[sk]!;
    await handlePush(store, guestConfig(), {
      userId: "member", clientId: "c1", schemaVersion: 1, mutations: [doc("o1", "d1", "member")]
    });
    const hidden = await handlePull(store, guestConfig(), {
      userId: "guest", clientId: "cg", schemaVersion: 1,
      scopes: [{ kind: "byWorkspace", value: "ws1" }], cursors: { [sk]: cursor }
    });
    expect(hidden.changes).toHaveLength(0); // withheld, but the cursor still advances
    expect(Number(hidden.cursors[sk])).toBeGreaterThan(Number(cursor));

    // The member reassigns the doc to the guest — the guest lacks the base row, so
    // the patch must arrive as a FULL-ROW upsert.
    await handlePush(store, guestConfig(), {
      userId: "member", clientId: "c1", schemaVersion: 1,
      mutations: [{ opId: "o2", clientId: "c1", schemaVersion: 1, functionName: "docs:update", table: "docs", kind: "patch", localId: "d1", patch: { createdBy: "guest" } }]
    });
    const entered = await handlePull(store, guestConfig(), {
      userId: "guest", clientId: "cg", schemaVersion: 1,
      scopes: [{ kind: "byWorkspace", value: "ws1" }], cursors: { [sk]: hidden.cursors[sk]! }
    });
    expect(entered.changes).toHaveLength(1);
    expect(entered.changes[0]!.kind).toBe("insert");
    expect(entered.changes[0]!.data).toMatchObject({ title: "t", createdBy: "guest" });
  });

  it("incremental: a row leaving visibility arrives as a delete", async () => {
    const store = seededStore();
    await handlePush(store, guestConfig(), {
      userId: "guest", clientId: "cg", schemaVersion: 1, mutations: [doc("o1", "d1", "guest")]
    });
    const sk = "byWorkspace:ws1";
    const warm = await handlePull(store, guestConfig(), {
      userId: "guest", clientId: "cg", schemaVersion: 1,
      scopes: [{ kind: "byWorkspace", value: "ws1" }], cursors: {}
    });
    // The member takes the doc over; for the guest it leaves visibility.
    await handlePush(store, guestConfig(), {
      userId: "member", clientId: "cm", schemaVersion: 1,
      mutations: [{ opId: "o2", clientId: "cm", schemaVersion: 1, functionName: "docs:update", table: "docs", kind: "patch", localId: "d1", patch: { createdBy: "member" } }]
    });
    const res = await handlePull(store, guestConfig(), {
      userId: "guest", clientId: "cg", schemaVersion: 1,
      scopes: [{ kind: "byWorkspace", value: "ws1" }], cursors: { [sk]: warm.cursors[sk]! }
    });
    expect(res.changes.map((c) => c.kind)).toEqual(["delete"]);
  });

  it("write side: can't see → can't touch (patch and delete of an invisible row reject)", async () => {
    const store = seededStore();
    await handlePush(store, guestConfig(), {
      userId: "member", clientId: "cm", schemaVersion: 1, mutations: [doc("o1", "d1", "member")]
    });
    const res = await handlePush(store, guestConfig(), {
      userId: "guest", clientId: "cg", schemaVersion: 1,
      mutations: [
        { opId: "o2", clientId: "cg", schemaVersion: 1, functionName: "docs:update", table: "docs", kind: "patch", localId: "d1", patch: { title: "hacked" } },
        { opId: "o3", clientId: "cg", schemaVersion: 1, functionName: "docs:remove", table: "docs", kind: "delete", localId: "d1" }
      ]
    });
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected.map((r) => r.message)).toEqual(["Cannot patch docs:d1", "Cannot delete docs:d1"]);
    const row = await store.getRow("docs", (await store.getServerId("docs", "d1"))!);
    expect(row).toMatchObject({ title: "t" });
  });
});

describe("server sync — serverStamp", () => {
  it("push inserts get server-minted fields (sequence numbers) atomically", async () => {
    const store = new MemoryServerStore();
    let seq = 0;
    const cfg: SyncConfig = {
      ...config,
      tables: { todos: { ...config.tables.todos!, serverStamp: () => ({ sequenceId: ++seq }) } }
    };
    const res = await handlePush(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1,
      mutations: [insert("t1", { text: "a" }), insert("t2", { text: "b" })]
    });
    expect(res.changes.map((c) => c.data?.sequenceId)).toEqual([1, 2]);
    const row = await store.getRow("todos", (await store.getServerId("todos", "t1"))!);
    expect(row!.sequenceId).toBe(1); // stamped on the stored row, not just the change
  });

  it("a stamp may not rewrite the scope or id field", async () => {
    const store = new MemoryServerStore();
    const cfg: SyncConfig = {
      ...config,
      tables: { todos: { ...config.tables.todos!, serverStamp: () => ({ ownerId: "someone_else" }) } }
    };
    const res = await handlePush(store, cfg, {
      userId: "user_a", clientId: "c1", schemaVersion: 1, mutations: [insert("t1", { text: "a" })]
    });
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]!.message).toMatch(/serverStamp must not set the scope field/);
  });
});
