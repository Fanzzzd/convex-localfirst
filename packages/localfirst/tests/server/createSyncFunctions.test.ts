import { describe, expect, it } from "vitest";
import { createSyncFunctions } from "../../src/server/createSyncFunctions.js";

// An in-memory stand-in for the mounted component + ctx.db, mirroring the
// component's public semantics. Lets us exercise the whole adapter (row writes,
// ledger dedupe, id map, change-log append, cursor, JSON round-trip, pull,
// membership) without a Convex backend.
function makeCtx() {
  const ops = new Map<string, unknown>();
  const idMaps = new Map<string, string>();
  const changes: any[] = [];
  const rowVersions = new Map<string, { table: string; localId: string; rowKey: string; scopeKey: string; version: number }>();
  let changeSeq = 0;
  let rowSeq = 0;
  const rows = new Map<string, any>();

  const lf = {
    ops: { getByOpId: "ops.getByOpId" },
    idMaps: { get: "idMaps.get", put: "idMaps.put" },
    changes: {
      append: "changes.append",
      commitOp: "changes.commitOp",
      listAfter: "changes.listAfter",
      latestVersion: "changes.latestVersion",
      scopeForLocal: "changes.scopeForLocal",
      firstId: "changes.firstId",
      lastId: "changes.lastId",
      listVersions: "changes.listVersions",
      gc: "changes.gc"
    }
  };

  const runQuery = async (fn: string, a: any) => {
    switch (fn) {
      case "ops.getByOpId":
        // Mirrors the component's by_user_op index (R4): keyed by (userId, opId)
        // only, so a replay under a DIFFERENT clientId still dedupes.
        return ops.get(`${a.userId}:${a.opId}`) ?? null;
      case "idMaps.get":
        return idMaps.get(`${a.table}:${a.localId}`) ?? null;
      case "changes.scopeForLocal":
        return rowVersions.get(`${a.table}:${a.localId}`)?.scopeKey ?? null;
      case "changes.listAfter": {
        const after = a.cursor ?? "";
        return changes.filter((c) => c.scopeKey === a.scopeKey && c.changeId > after).slice(0, a.limit);
      }
      case "changes.latestVersion":
        return rowVersions.get(`${a.table}:${a.localId}`)?.version ?? 0;
      case "changes.firstId": {
        const rel = changes.filter((c) => c.scopeKey === a.scopeKey);
        return rel.length ? rel[0].changeId : null;
      }
      case "changes.lastId": {
        const rel = changes.filter((c) => c.scopeKey === a.scopeKey);
        return rel.length ? rel[rel.length - 1].changeId : null;
      }
      case "changes.listVersions": {
        const after = a.afterRowKey ?? "";
        return [...rowVersions.values()]
          .filter((r) => r.scopeKey === a.scopeKey && r.rowKey > after)
          .sort((x, y) => (x.rowKey < y.rowKey ? -1 : 1))
          .slice(0, a.limit);
      }
      default:
        throw new Error(`unexpected runQuery ${fn}`);
    }
  };

  const runMutation = async (fn: string, a: any) => {
    switch (fn) {
      case "changes.commitOp": {
        let change = null;
        let changesJson: string | undefined;
        if (a.change) {
          const changeId = String(++changeSeq).padStart(12, "0");
          change = { changeId, ...a.change };
          changes.push(change);
          rowVersions.set(`${a.change.table}:${a.change.localId}`, {
            table: a.change.table,
            localId: a.change.localId,
            rowKey: `${a.change.table}:${a.change.localId}`,
            scopeKey: a.change.scopeKey,
            version: a.change.version
          });
          changesJson = JSON.stringify([
            {
              changeId,
              scopeKey: a.change.scopeKey,
              table: a.change.table,
              localId: a.change.localId,
              kind: a.change.kind,
              ...(a.change.dataJson ? { data: JSON.parse(a.change.dataJson) } : {}),
              ...(a.change.patchJson ? { patch: JSON.parse(a.change.patchJson) } : {}),
              version: a.change.version,
              serverTime: a.change.serverTime,
              opId: a.change.opId
            }
          ]);
        }
        ops.set(`${a.userId}:${a.opId}`, {
          schemaVersion: a.schemaVersion,
          status: a.status,
          changesJson,
          error: a.error
        });
        return { change };
      }
      case "idMaps.put":
        idMaps.set(`${a.table}:${a.localId}`, a.serverId);
        return;
      case "changes.append": {
        const changeId = String(++changeSeq).padStart(12, "0");
        changes.push({ changeId, ...a });
        rowVersions.set(`${a.table}:${a.localId}`, {
          table: a.table,
          localId: a.localId,
          rowKey: `${a.table}:${a.localId}`,
          scopeKey: a.scopeKey,
          version: a.version
        });
        return changeId;
      }
      case "changes.gc":
        return { ops: 0, changes: 0, done: true };
      default:
        throw new Error(`unexpected runMutation ${fn}`);
    }
  };

  const db = {
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async insert(table: string, data: any) {
      const id = `srv_${++rowSeq}`;
      rows.set(id, { _id: id, ...data });
      return id;
    },
    async patch(id: string, patch: any) {
      rows.set(id, { ...rows.get(id), ...patch });
    },
    async delete(id: string) {
      rows.delete(id);
    }
  };

  const ctx = { db, runQuery, runMutation, auth: { getUserIdentity: async () => null } };
  return { ctx, lf, rows };
}

describe("createSyncFunctions", () => {
  it("composes a push/pull that round-trips an insert and dedupes a re-push (byUser)", async () => {
    const { ctx, lf, rows } = makeCtx();
    const { push, pull } = createSyncFunctions({
      component: lf,
      mutation: (d) => d,
      query: (d) => d,
      tables: {
        todos: {
          scope: { kind: "byUser", field: "ownerId" },
          idField: "localId",
          mutations: { "todos:create": { kind: "insert", fields: ["ownerId", "localId", "text"] } }
        }
      },
      devUnsafeAllowClientUserId: true // local demo ctx has no auth identity
    }) as unknown as { push: any; pull: any };

    const op = {
      opId: "op1",
      clientId: "c1",
      schemaVersion: 1,
      functionName: "todos:create",
      table: "todos",
      kind: "insert" as const,
      localId: "l1",
      value: { ownerId: "u1", text: "hi" }
    };

    await push.handler(ctx, { clientId: "c1", userId: "u1", schemaVersion: 1, mutations: [op] });
    expect([...rows.values()]).toHaveLength(1);
    expect([...rows.values()][0]).toMatchObject({ ownerId: "u1", text: "hi" });

    const res = await pull.handler(ctx, { clientId: "c2", userId: "u1", schemaVersion: 1, scopes: [{ kind: "byUser" }], cursors: {} });
    expect(res.changes).toHaveLength(1);
    expect((res.changes[0].data as any).text).toBe("hi");

    // Re-pushing the same opId is idempotent — no duplicate row.
    await push.handler(ctx, { clientId: "c1", userId: "u1", schemaVersion: 1, mutations: [op] });
    expect([...rows.values()]).toHaveLength(1);

    // R4 through the adapter: the SAME opId replayed under a DIFFERENT envelope
    // clientId (reload/new-tab) still dedupes and is ACCEPTED (not rejected, not
    // duplicated) — the ledger keys on (userId, opId), not clientId.
    const replay = await push.handler(ctx, {
      clientId: "c2",
      userId: "u1",
      schemaVersion: 1,
      mutations: [{ ...op, clientId: "c2" }]
    });
    expect([...rows.values()]).toHaveLength(1);
    expect(replay.rejected).toEqual([]);
    expect(replay.accepted.map((a: any) => a.opId)).toEqual(["op1"]);
  });

  it("rejects a byWorkspace write when isMember returns false (server decides — I7)", async () => {
    const { ctx, lf, rows } = makeCtx();
    const { push } = createSyncFunctions({
      component: lf,
      mutation: (d) => d,
      query: (d) => d,
      tables: {
        issues: {
          scope: { kind: "byWorkspace", workspaceIdField: "workspaceId", membershipTable: "ws_members" },
          idField: "localId",
          mutations: { "issues:create": { kind: "insert", fields: ["workspaceId", "localId", "title"] } }
        }
      },
      access: { member: async () => null },
      devUnsafeAllowClientUserId: true
    }) as unknown as { push: any };

    const res = await push.handler(ctx, {
      clientId: "c1",
      userId: "u1",
      schemaVersion: 1,
      mutations: [
        {
          opId: "op1",
          clientId: "c1",
          schemaVersion: 1,
          functionName: "issues:create",
          table: "issues",
          kind: "insert" as const,
          localId: "l1",
          value: { workspaceId: "w1", title: "x" }
        }
      ]
    });

    expect(rows.size).toBe(0);
    expect(res.rejected).toHaveLength(1);
  });

  it("fails closed when there is no auth identity and the unsafe flag is off (I7)", async () => {
    const { ctx, lf } = makeCtx(); // ctx.auth.getUserIdentity -> null
    const { push } = createSyncFunctions({
      component: lf,
      mutation: (d) => d,
      query: (d) => d,
      tables: {
        todos: {
          scope: { kind: "byUser", field: "ownerId" },
          idField: "localId",
          mutations: { "todos:create": { kind: "insert", fields: ["ownerId", "localId", "text"] } }
        }
      }
    }) as unknown as { push: any };

    await expect(
      push.handler(ctx, { clientId: "c1", userId: "u1", schemaVersion: 1, mutations: [] })
    ).rejects.toThrow(/authenticated identity/);
  });

  it("derives userId from identity.tokenIdentifier, ignoring subject and the client value", async () => {
    const { ctx, lf, rows } = makeCtx();
    (ctx.auth as any).getUserIdentity = async () => ({ subject: "issuer-local", tokenIdentifier: "issuer|real-user" });
    const { push } = createSyncFunctions({
      component: lf,
      mutation: (d) => d,
      query: (d) => d,
      tables: {
        todos: {
          scope: { kind: "byUser", field: "ownerId" },
          idField: "localId",
          mutations: { "todos:create": { kind: "insert", fields: ["ownerId", "localId", "text"] } }
        }
      }
    }) as unknown as { push: any };

    await push.handler(ctx, {
      clientId: "c1",
      userId: "attacker", // client lies; must be ignored in favor of the auth identity
      schemaVersion: 1,
      mutations: [
        { opId: "op1", clientId: "c1", schemaVersion: 1, functionName: "todos:create", table: "todos", kind: "insert" as const, localId: "l1", value: { ownerId: "attacker", text: "x" } }
      ]
    });
    expect([...rows.values()][0]).toMatchObject({ ownerId: "issuer|real-user" });
  });

  it("lets getUserId override the default identity mapping", async () => {
    const { ctx, lf, rows } = makeCtx();
    const { push } = createSyncFunctions({
      component: lf,
      mutation: (d) => d,
      query: (d) => d,
      getUserId: async () => "mapped-user",
      tables: {
        todos: {
          scope: { kind: "byUser", field: "ownerId" },
          idField: "localId",
          mutations: { "todos:create": { kind: "insert", fields: ["ownerId", "localId", "text"] } }
        }
      }
    }) as unknown as { push: any };
    await push.handler(ctx, {
      clientId: "c1",
      userId: "attacker",
      schemaVersion: 1,
      mutations: [{
        opId: "op1", clientId: "c1", schemaVersion: 1, functionName: "todos:create",
        table: "todos", kind: "insert", localId: "l1", value: { text: "x" }
      }]
    });
    expect([...rows.values()][0]).toMatchObject({ ownerId: "mapped-user" });
  });
});
