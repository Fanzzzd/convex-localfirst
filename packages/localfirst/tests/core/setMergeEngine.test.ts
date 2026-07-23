import { describe, expect, it } from "vitest";
import {
  MemoryLocalStore,
  byUser,
  defineLocalFirstManifest,
  localMutation,
  localTable,
  type SyncTransport,
} from "../../src/core";
import { LocalFirstEngine } from "../../src/core/internal";

// A table whose `labels` array is a declared SET field (convergent add/remove).
function manifest() {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      issues: localTable({
        table: "issues",
        idField: "localId",
        scope: byUser("ownerId"),
        indexes: { byOwner: ["ownerId", "createdAt"] },
        setFields: ["labels"],
        counterFields: ["votes"],
      }),
    },
    queries: {},
    mutations: {
      "issues:setLabels": localMutation<{ id: string; labels: string[] }>({
        kind: "mutation",
        name: "issues:setLabels",
        table: "issues",
        plan(args) {
          // The app patches with the WHOLE intended array (as Plane's UI does); the engine
          // turns it into a set DELTA vs the current value.
          return { kind: "patch", table: "issues", id: args.id, patch: { labels: args.labels } };
        },
      }),
      "issues:setVotes": localMutation<{ id: string; votes: number }>({
        kind: "mutation",
        name: "issues:setVotes",
        table: "issues",
        plan(args) {
          // The app patches with the WHOLE intended number; the engine turns it into a
          // counter DELTA vs the current value so concurrent increments accumulate.
          return { kind: "patch", table: "issues", id: args.id, patch: { votes: args.votes } };
        },
      }),
    },
  });
}

const okTransport: SyncTransport = {
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

function makeEngine(store: MemoryLocalStore) {
  return new LocalFirstEngine({
    manifest: manifest(),
    store,
    clientId: "c",
    userId: "u",
    transport: okTransport,
    nameOf: (r) => String(r),
    idFactory: () => "issues_1",
    clock: () => 100,
  });
}

describe("set-field merge through the engine", () => {
  it("a patch on a declared set field is recorded as an add/remove DELTA, and the optimistic view merges it", async () => {
    const store = new MemoryLocalStore();
    const engine = makeEngine(store);
    // canonical issue with labels ["a"] (as if already synced)
    await store.applyServerChange({
      changeId: "c1",
      scopeKey: "byUser:u",
      table: "issues",
      id: "issues_1",
      kind: "insert",
      value: { localId: "issues_1", ownerId: "u", labels: ["a"], createdAt: 1 },
      version: 1,
      serverTime: 1,
    });

    // The app patches with the whole new array ["a","b"]; the engine stores a DELTA {add:["b"]}.
    const commit = await engine.mutate("issues:setLabels", { id: "issues_1", labels: ["a", "b"] })
      .local;
    const patchOp = (await store.getAllOperations()).find((o) => o.kind === "patch");
    expect(patchOp?.patch?.labels).toEqual({ __lfSet: { add: ["b"], remove: [] } });

    // #24 × #22 interaction: the commit's `row` must carry the MATERIALIZED array (["a","b"]),
    // NOT the raw {__lfSet} delta the op stores — i.e. the patch-row return runs AFTER the
    // delta is replayed, so a caller using commit.row never sees the internal delta shape.
    expect(commit.row?.labels).toEqual(["a", "b"]);

    // Optimistic view applies the delta over current → ["a","b"] (same as commit.row).
    const row = await engine.getRow<Record<string, unknown>>("issues", "issues_1");
    expect(row?.labels).toEqual(["a", "b"]);
  });

  it("CONVERGES: a local add survives a concurrent REMOTE add to the same field (no clobber)", async () => {
    const store = new MemoryLocalStore();
    const engine = makeEngine(store);
    // canonical labels ["a"]
    await store.applyServerChange({
      changeId: "c1",
      scopeKey: "byUser:u",
      table: "issues",
      id: "issues_1",
      kind: "insert",
      value: { localId: "issues_1", ownerId: "u", labels: ["a"], createdAt: 1 },
      version: 1,
      serverTime: 1,
    });

    // Local user adds "b" (pending delta {add:["b"]} computed against current ["a"]).
    await engine.mutate("issues:setLabels", { id: "issues_1", labels: ["a", "b"] }).local;
    expect((await engine.getRow<Record<string, unknown>>("issues", "issues_1"))?.labels).toEqual([
      "a",
      "b",
    ]);

    // CONCURRENTLY another client added "x" → its materialized change ["a","x"] pulls in.
    await store.applyServerChange({
      changeId: "c2",
      scopeKey: "byUser:u",
      table: "issues",
      id: "issues_1",
      kind: "patch",
      patch: { labels: ["a", "x"] },
      version: 2,
      serverTime: 2,
    });

    // The still-pending local delta {add:["b"]} replays OVER the new canonical ["a","x"]
    // → ["a","x","b"]: BOTH adds survive. With whole-array LWW, "b" would have been lost.
    const row = await engine.getRow<Record<string, unknown>>("issues", "issues_1");
    expect(((row?.labels ?? []) as string[]).slice().sort()).toEqual(["a", "b", "x"]);
  });

  it("a patch on a declared counter field is recorded as a numeric DELTA, and the optimistic view adds it", async () => {
    const store = new MemoryLocalStore();
    const engine = makeEngine(store);
    // canonical issue with votes=3 (as if already synced)
    await store.applyServerChange({
      changeId: "c1",
      scopeKey: "byUser:u",
      table: "issues",
      id: "issues_1",
      kind: "insert",
      value: { localId: "issues_1", ownerId: "u", votes: 3, createdAt: 1 },
      version: 1,
      serverTime: 1,
    });

    // The app patches with the whole new number 5; the engine stores a DELTA {__lfCounter:+2}.
    const commit = await engine.mutate("issues:setVotes", { id: "issues_1", votes: 5 }).local;
    const patchOp = (await store.getAllOperations()).find((o) => o.kind === "patch");
    expect(patchOp?.patch?.votes).toEqual({ __lfCounter: 2 });

    // Optimistic view + commit.row apply the delta over current → 5 (materialized, not a delta).
    expect(commit.row?.votes).toBe(5);
    expect((await engine.getRow<Record<string, unknown>>("issues", "issues_1"))?.votes).toBe(5);
  });

  it("CONVERGES: a local increment ACCUMULATES with a concurrent REMOTE increment (no clobber)", async () => {
    const store = new MemoryLocalStore();
    const engine = makeEngine(store);
    // canonical votes=3
    await store.applyServerChange({
      changeId: "c1",
      scopeKey: "byUser:u",
      table: "issues",
      id: "issues_1",
      kind: "insert",
      value: { localId: "issues_1", ownerId: "u", votes: 3, createdAt: 1 },
      version: 1,
      serverTime: 1,
    });

    // Local user sets votes 5 (pending delta {+2} vs current 3).
    await engine.mutate("issues:setVotes", { id: "issues_1", votes: 5 }).local;
    expect((await engine.getRow<Record<string, unknown>>("issues", "issues_1"))?.votes).toBe(5);

    // CONCURRENTLY another client incremented +1 → its materialized change votes=4 pulls in.
    await store.applyServerChange({
      changeId: "c2",
      scopeKey: "byUser:u",
      table: "issues",
      id: "issues_1",
      kind: "patch",
      patch: { votes: 4 },
      version: 2,
      serverTime: 2,
    });

    // The still-pending local delta {+2} replays OVER the new canonical 4 → 6: BOTH increments
    // accumulate. With whole-number LWW, the local +2 would have been lost (stuck at 4).
    expect((await engine.getRow<Record<string, unknown>>("issues", "issues_1"))?.votes).toBe(6);
  });
});
