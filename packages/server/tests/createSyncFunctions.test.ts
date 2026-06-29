import { describe, expect, it } from "vitest";
import { createSyncFunctions } from "../src/createSyncFunctions.js";

// An in-memory stand-in for the mounted component + ctx.db, mirroring the
// component's public semantics. Lets us exercise the whole adapter (row writes,
// ledger dedupe, id map, change-log append, cursor, JSON round-trip, pull,
// membership) without a Convex backend.
function makeCtx() {
  const ops = new Map<string, unknown>();
  const idMaps = new Map<string, string>();
  const changes: any[] = [];
  let changeSeq = 0;
  let rowSeq = 0;
  const rows = new Map<string, any>();

  const lf = {
    ops: { getByOpId: "ops.getByOpId", record: "ops.record" },
    idMaps: { get: "idMaps.get", put: "idMaps.put" },
    changes: {
      append: "changes.append",
      listAfter: "changes.listAfter",
      latestVersion: "changes.latestVersion",
      scopeForLocal: "changes.scopeForLocal"
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
      case "changes.scopeForLocal": {
        const rel = changes.filter((c) => c.table === a.table && c.localId === a.localId);
        return rel.length ? rel[rel.length - 1].scopeKey : null;
      }
      case "changes.listAfter": {
        const after = a.cursor ?? "";
        return changes.filter((c) => c.scopeKey === a.scopeKey && c.changeId > after).slice(0, a.limit);
      }
      case "changes.latestVersion": {
        const rel = changes.filter((c) => c.table === a.table && c.localId === a.localId);
        return rel.length ? Math.max(...rel.map((c) => c.version)) : 0;
      }
      default:
        throw new Error(`unexpected runQuery ${fn}`);
    }
  };

  const runMutation = async (fn: string, a: any) => {
    switch (fn) {
      case "ops.record":
        ops.set(`${a.userId}:${a.opId}`, { status: a.status, resultJson: a.resultJson, changesJson: a.changesJson, error: a.error });
        return;
      case "idMaps.put":
        idMaps.set(`${a.table}:${a.localId}`, a.serverId);
        return;
      case "changes.append": {
        const changeId = String(++changeSeq).padStart(12, "0");
        changes.push({ changeId, ...a });
        return changeId;
      }
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
      tables: { todos: { scope: { kind: "byUser", field: "ownerId" }, idField: "localId", conflict: "fieldLww" } },
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
          conflict: "fieldLww"
        }
      },
      isMember: async () => false,
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
      tables: { todos: { scope: { kind: "byUser", field: "ownerId" }, idField: "localId", conflict: "fieldLww" } }
    }) as unknown as { push: any };

    await expect(
      push.handler(ctx, { clientId: "c1", userId: "u1", schemaVersion: 1, mutations: [] })
    ).rejects.toThrow(/authenticated identity/);
  });

  it("derives userId from auth, ignoring the client-supplied userId (I7)", async () => {
    const { ctx, lf, rows } = makeCtx();
    (ctx.auth as any).getUserIdentity = async () => ({ subject: "real-user" });
    const { push } = createSyncFunctions({
      component: lf,
      mutation: (d) => d,
      query: (d) => d,
      tables: { todos: { scope: { kind: "byUser", field: "ownerId" }, idField: "localId", conflict: "fieldLww" } }
    }) as unknown as { push: any };

    await push.handler(ctx, {
      clientId: "c1",
      userId: "attacker", // client lies; must be ignored in favor of the auth identity
      schemaVersion: 1,
      mutations: [
        { opId: "op1", clientId: "c1", schemaVersion: 1, functionName: "todos:create", table: "todos", kind: "insert" as const, localId: "l1", value: { ownerId: "attacker", text: "x" } }
      ]
    });
    expect([...rows.values()][0]).toMatchObject({ ownerId: "real-user" });
  });

  it("accepts conflict: timestampLww (the bundled component now wires per-field write clocks)", () => {
    const { lf } = makeCtx();
    const fns = createSyncFunctions({
      component: lf,
      mutation: (d) => d,
      query: (d) => d,
      tables: { notes: { scope: { kind: "byUser", field: "ownerId" }, idField: "localId", conflict: "timestampLww" } }
    }) as unknown as { push: any; pull: any };
    // No throw — timestampLww is live. push/pull are composed; the pushStore wires
    // getFieldClocks/putFieldClocks to the component's fieldClocks module.
    expect(fns.push).toBeDefined();
    expect(fns.pull).toBeDefined();
  });
});
