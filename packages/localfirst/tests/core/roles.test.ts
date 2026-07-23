import { describe, expect, it } from "vitest";
import {
  MemoryLocalStore,
  byWorkspace,
  defineLocalFirstManifest,
  localMutation,
  localTable,
  type ClientCanConfig,
  type LocalFirstManifest,
  type PullResponse,
  type PushResponse,
  type SyncTransport,
} from "../../src/core";
import { LocalFirstEngine } from "../../src/core/internal";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type DocRow = { workspace_id: string; title: string; created_by: string } & Record<string, unknown>;

// A viewer read-only mirror: members (role >= 15) write; viewers (role 10) are read-only.
const docsClientCan: ClientCanConfig<DocRow, number> = {
  write: ({ role }) => (role as number) >= 15,
};

function docsManifest(): LocalFirstManifest {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      docs: localTable({
        table: "docs",
        idField: "id",
        scope: byWorkspace({ workspaceIdField: "workspace_id", membershipTable: "ws_members" }),
        indexes: { byWorkspace: ["workspace_id"] },
        clientCan: docsClientCan as ClientCanConfig,
      }),
    },
    queries: {},
    mutations: {
      "docs:create": localMutation<{ workspace_id: string; title: string }>({
        kind: "mutation",
        name: "docs:create",
        table: "docs",
        operationKind: "insert",
        plan: (args, ctx) => ({
          kind: "insert",
          table: "docs",
          id: ctx.localId("docs"),
          value: {
            workspace_id: args.workspace_id,
            title: args.title,
            created_by: ctx.userId ?? "anon",
          },
        }),
      }),
      "docs:rename": localMutation<{ id: string; title: string }>({
        kind: "mutation",
        name: "docs:rename",
        table: "docs",
        operationKind: "patch",
        plan: (args) => ({
          kind: "patch",
          table: "docs",
          id: args.id,
          patch: { title: args.title },
        }),
      }),
    },
  });
}

/** Pull transport delivering a configurable per-scope role map (and optional denials). */
function rolePullTransport(state: {
  roles?: Record<string, unknown>;
  denied?: string[];
}): SyncTransport {
  return {
    async push(request): Promise<PushResponse> {
      return {
        accepted: request.mutations.map((op) => ({ opId: op.opId, serverResult: { ok: true } })),
        rejected: [],
        idMaps: [],
        changes: [],
        serverTime: 1,
      };
    },
    async pull(): Promise<PullResponse> {
      return {
        changes: [],
        cursors: { "byWorkspace:w1": "1" },
        serverTime: 1,
        roles: state.roles,
        deniedScopes: state.denied,
      };
    },
  };
}

function makeEngine(store: MemoryLocalStore, transport: SyncTransport): LocalFirstEngine {
  return new LocalFirstEngine({
    manifest: docsManifest(),
    store,
    clientId: "c1",
    userId: "user_a",
    transport,
    nameOf: (reference) => String(reference),
    idFactory: () => `docs_${Math.random().toString(36).slice(2)}`,
    clock: (() => {
      let now = 1000;
      return () => now++;
    })(),
    sleep: () => Promise.resolve(),
  });
}

const wsScope = { kind: "byWorkspace" as const, key: "byWorkspace:w1" };

describe("role sync (DX v4 §6)", () => {
  it("pull carries the role and getRole exposes it", async () => {
    const store = new MemoryLocalStore();
    const engine = makeEngine(store, rolePullTransport({ roles: { "byWorkspace:w1": 15 } }));
    expect(engine.getRole({ workspace_id: "w1" })).toBeUndefined(); // not synced yet

    await engine.syncOnce([wsScope]);
    expect(engine.getRole({ workspace_id: "w1" })).toBe(15);
  });

  it("survives a reload (durable via the store)", async () => {
    const store = new MemoryLocalStore();
    const engine1 = makeEngine(store, rolePullTransport({ roles: { "byWorkspace:w1": 10 } }));
    await engine1.syncOnce([wsScope]);
    expect(engine1.getRole({ workspace_id: "w1" })).toBe(10);

    // A "reload": a fresh engine over the SAME durable store seeds the role from disk.
    const engine2 = makeEngine(store, rolePullTransport({ roles: { "byWorkspace:w1": 10 } }));
    await flush();
    expect(engine2.getRole({ workspace_id: "w1" })).toBe(10);
  });

  it("evicts the role to null (denied) when the scope is denied", async () => {
    const store = new MemoryLocalStore();
    const engine = makeEngine(store, rolePullTransport({ roles: { "byWorkspace:w1": 15 } }));
    await engine.syncOnce([wsScope]);
    expect(engine.getRole({ workspace_id: "w1" })).toBe(15);

    const denyEngine = makeEngine(store, rolePullTransport({ denied: ["byWorkspace:w1"] }));
    await denyEngine.syncOnce([wsScope]);
    expect(denyEngine.getRole({ workspace_id: "w1" })).toBeNull(); // denied, not undefined
  });

  it("notifies subscribers when a role changes", async () => {
    const store = new MemoryLocalStore();
    const engine = makeEngine(store, rolePullTransport({ roles: { "byWorkspace:w1": 15 } }));
    let fired = 0;
    engine.subscribeRoles(() => fired++);
    await engine.syncOnce([wsScope]);
    expect(fired).toBeGreaterThan(0);
  });
});

describe("client write mirror — engine.can (DX v4 §6)", () => {
  const member = { workspace_id: "w1", title: "x", created_by: "user_a" };

  it("denies a viewer (role 10) and allows a member (role 15)", async () => {
    const store = new MemoryLocalStore();
    const viewer = makeEngine(store, rolePullTransport({ roles: { "byWorkspace:w1": 10 } }));
    await viewer.syncOnce([wsScope]);
    expect(
      viewer.can("docs", "patch", {
        before: member,
        patch: { title: "y" },
        proposed: { ...member, title: "y" },
      }),
    ).toBe(false);
    expect(viewer.can("docs", "insert", { proposed: member })).toBe(false);

    const store2 = new MemoryLocalStore();
    const admin = makeEngine(store2, rolePullTransport({ roles: { "byWorkspace:w1": 15 } }));
    await admin.syncOnce([wsScope]);
    expect(
      admin.can("docs", "patch", {
        before: member,
        patch: { title: "y" },
        proposed: { ...member, title: "y" },
      }),
    ).toBe(true);
  });

  it("returns true when the role is not synced yet (advisory)", () => {
    const store = new MemoryLocalStore();
    const engine = makeEngine(store, rolePullTransport({}));
    // No pull → role undefined → the mirror is NOT called → advisory true.
    expect(
      engine.can("docs", "patch", { before: member, patch: { title: "y" }, proposed: member }),
    ).toBe(true);
  });

  it("returns true when the table declares no mirror", async () => {
    // A manifest whose docs table has no clientCan.
    const manifest = docsManifest();
    const noMirror: LocalFirstManifest = {
      ...manifest,
      tables: { docs: { ...manifest.tables.docs!, clientCan: undefined } },
    };
    const store = new MemoryLocalStore();
    const engine = new LocalFirstEngine({
      manifest: noMirror,
      store,
      clientId: "c1",
      userId: "user_a",
      transport: rolePullTransport({ roles: { "byWorkspace:w1": 10 } }),
      nameOf: (r) => String(r),
      idFactory: () => "docs_x",
      sleep: () => Promise.resolve(),
    });
    await engine.syncOnce([wsScope]);
    // Even a viewer (10) passes: no mirror declared → advisory true.
    expect(
      engine.can("docs", "patch", { before: member, patch: { title: "y" }, proposed: member }),
    ).toBe(true);
  });
});
