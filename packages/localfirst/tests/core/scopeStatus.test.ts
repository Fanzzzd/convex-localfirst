import { describe, expect, it } from "vitest";
import {
  MemoryLocalStore,
  byUser,
  byWorkspace,
  defineLocalFirstManifest,
  localTable,
  type PullResponse,
  type PushResponse,
  type SyncScope,
  type SyncTransport,
} from "../../src/core/index.js";
import { LocalFirstEngine } from "../../src/core/internal.js";

// §10 useScopeStatus is derived from these engine primitives — tested here headlessly so the
// hydrating→hydrated / partial / denied transitions are deterministic.

const USER = "u_s";

function manifest() {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      todos: localTable({
        table: "todos",
        idField: "localId",
        scope: byUser("ownerId"),
        indexes: {},
      }),
      docs: localTable({
        table: "docs",
        idField: "localId",
        scope: byWorkspace({ workspaceIdField: "wsId", membershipTable: "members" }),
        indexes: {},
      }),
    },
    queries: {},
    mutations: {},
  });
}

const emptyPush = async (): Promise<PushResponse> => ({
  accepted: [],
  rejected: [],
  idMaps: [],
  changes: [],
  serverTime: 1,
});

function makeEngine(pull: SyncTransport["pull"]): LocalFirstEngine {
  return new LocalFirstEngine({
    manifest: manifest(),
    store: new MemoryLocalStore(),
    clientId: "c",
    userId: USER,
    transport: { push: emptyPush, pull },
    nameOf: (r) => String(r),
    sleep: async () => {},
  });
}

const userScope: SyncScope = { kind: "byUser", key: `u:${USER}` };
const wsScope: SyncScope = { kind: "byWorkspace", key: "byWorkspace:w1" };

describe("§10 per-scope status", () => {
  it("hydrating → hydrated once the first pull delivers a cursor", async () => {
    const engine = makeEngine(
      async (): Promise<PullResponse> => ({
        changes: [],
        cursors: { [`u:${USER}`]: "1" },
        serverTime: 1,
      }),
    );
    expect(engine.getScopeStatus({})).toEqual({
      hydrated: false,
      partial: false,
      syncing: false,
      denied: false,
    });
    await engine.syncOnce([userScope]);
    const status = engine.getScopeStatus({});
    expect(status.hydrated).toBe(true);
    expect(status.partial).toBe(false);
    expect(status.syncing).toBe(false);
    expect(status.denied).toBe(false);
  });

  it("reports partial while a budget-limited drain cannot advance", async () => {
    // hasMore stays true but the cursor never advances past its first value → the drain
    // exits early and marks the scope partial (still hydrated — a first page arrived).
    const engine = makeEngine(
      async (): Promise<PullResponse> => ({
        changes: [],
        cursors: { [`u:${USER}`]: "0" },
        hasMore: { [`u:${USER}`]: true },
        serverTime: 1,
      }),
    );
    await engine.syncOnce([userScope]);
    const status = engine.getScopeStatus({});
    expect(status.hydrated).toBe(true);
    expect(status.partial).toBe(true);
  });

  it("flips to denied after a membership revocation, and hydrated goes false", async () => {
    let revoked = false;
    const engine = makeEngine(async (): Promise<PullResponse> => {
      if (revoked) {
        return { changes: [], cursors: {}, serverTime: 1, deniedScopes: ["byWorkspace:w1"] };
      }
      return {
        changes: [],
        cursors: { "byWorkspace:w1": "1" },
        serverTime: 1,
        roles: { "byWorkspace:w1": "admin" },
      };
    });

    await engine.syncOnce([wsScope]);
    let status = engine.getScopeStatus({ wsId: "w1" });
    expect(status.hydrated).toBe(true);
    expect(status.denied).toBe(false);

    revoked = true;
    await engine.syncOnce([wsScope]);
    status = engine.getScopeStatus({ wsId: "w1" });
    expect(status.denied).toBe(true);
    expect(status.hydrated).toBe(false);
  });

  it("notifies subscribers on scope-status transitions", async () => {
    let notified = 0;
    const engine = makeEngine(
      async (): Promise<PullResponse> => ({
        changes: [],
        cursors: { [`u:${USER}`]: "1" },
        serverTime: 1,
      }),
    );
    const unsub = engine.subscribeScopeStatus(() => notified++);
    await engine.syncOnce([userScope]);
    expect(notified).toBeGreaterThan(0);
    unsub();
  });
});
