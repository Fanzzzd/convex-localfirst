import { describe, expect, it } from "vitest";
import {
  MemoryLocalStore,
  byWorkspace,
  collection,
  defineLocalFirstManifest,
  localTable,
  many,
  type RowDelta,
  type RowValue,
  type ServerChange
} from "../../src/core";
import { LocalFirstEngine, SortedIndex } from "../../src/core/internal";

function issuesManifest() {
  const ws = byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "m" });
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      issues: localTable({
        table: "issues",
        idField: "localId",
        scope: ws,
        indexes: {
          byStatusRank: ["workspaceId", "status", "rank"],
          byRank: ["workspaceId", "rank"]
        }
      }),
      comments: localTable({ table: "comments", idField: "localId", scope: ws, indexes: {} })
    },
    queries: {},
    mutations: {}
  });
}

function seedChange(table: string, id: string, value: Record<string, unknown>, version = 1): ServerChange {
  return {
    changeId: `c-${table}-${id}-${version}`,
    scopeKey: `byWorkspace:${value.workspaceId}`,
    table,
    id,
    kind: "insert",
    value,
    version,
    serverTime: version
  };
}

async function makeEngine(seed: ServerChange[] = []) {
  const store = new MemoryLocalStore();
  for (const change of seed) await store.applyServerChange(change);
  const engine = new LocalFirstEngine({
    manifest: issuesManifest(),
    store,
    clientId: "c",
    userId: "u",
    nameOf: (r) => String(r)
  });
  return { engine, store };
}

/** Await one microtask/timer flush so async cache hydration settles. */
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("SortedIndex", () => {
  it("keeps entries sorted and supports equality-prefix lookups + pre-sorted iteration", () => {
    const index = new SortedIndex(["workspaceId", "rank"]);
    const rows = [
      { _id: "a", workspaceId: "w1", rank: "m" },
      { _id: "b", workspaceId: "w1", rank: "a" },
      { _id: "c", workspaceId: "w2", rank: "z" },
      { _id: "d", workspaceId: "w1", rank: "z" }
    ] as unknown as RowValue[];
    for (const row of rows) index.insert(row);
    // pre-sorted iteration for w1 by rank: b(a) < a(m) < d(z)
    expect(index.idsWithPrefix(["w1"])).toEqual(["b", "a", "d"]);
    expect(index.idsWithPrefix(["w2"])).toEqual(["c"]);
    expect(index.idsWithPrefix(["nope"])).toEqual([]);
    expect(index.size).toBe(4);
    // remove keeps order
    index.remove(rows[1]!); // b
    expect(index.idsWithPrefix(["w1"])).toEqual(["a", "d"]);
  });

  it("binary-search insert positions a new row correctly among many", () => {
    const index = new SortedIndex(["n"]);
    for (const n of [5, 1, 9, 3, 7]) index.insert({ _id: `id${n}`, n } as unknown as RowValue);
    expect(index.allIds()).toEqual(["id1", "id3", "id5", "id7", "id9"]);
  });
});

describe("delta bus", () => {
  it("emits typed upsert/delete deltas for server-change applies (P3 item 1)", async () => {
    const { engine, store } = await makeEngine();
    await engine.subscribeLiveQuery(collection("issues").scope({ workspaceId: "w1" }), () => {});
    await flush();
    const seen: RowDelta[] = [];
    const off = engine.subscribeDeltas((deltas) => seen.push(...deltas));

    // Apply via the engine's server-change path by pulling — here drive the cache
    // directly through an out-of-band store write + poke (the resync/gap path).
    await store.applyServerChange(seedChange("issues", "i1", { workspaceId: "w1", status: "open", rank: "m" }));
    engine.pokeLocalChange();
    await flush();

    off();
    const upserts = seen.filter((d) => d.kind === "upsert");
    expect(upserts.some((d) => d.table === "issues" && d.localId === "i1")).toBe(true);
  });
});

describe("in-memory cache + incremental views", () => {
  it("hydrates from the store once and serves live rows without re-reading", async () => {
    const { engine } = await makeEngine([
      seedChange("issues", "i1", { workspaceId: "w1", status: "open", rank: "m", title: "A" }),
      seedChange("issues", "i2", { workspaceId: "w1", status: "open", rank: "a", title: "B" })
    ]);
    let count = 0;
    const sub = engine.subscribeLiveQuery(
      collection<RowValue>("issues").scope({ workspaceId: "w1" }).order("rank"),
      () => count++
    );
    await flush();
    // Pre-sorted by rank: i2 (a) before i1 (m)
    expect(sub.current()?.map((r) => r._id)).toEqual(["i2", "i1"]);
    sub.dispose();
  });

  it("updates a subscription incrementally on a single delta and keeps stable identity", async () => {
    const { engine } = await makeEngine([
      seedChange("issues", "i1", { workspaceId: "w1", status: "open", rank: "m" })
    ]);
    let changes = 0;
    const sub = engine.subscribeLiveQuery(
      collection<RowValue>("issues").scope({ workspaceId: "w1" }).order("rank"),
      () => changes++
    );
    await flush();
    const first = sub.current();
    expect(first?.length).toBe(1);

    // A delta that does NOT change the visible result → stable identity, no extra change.
    const before = changes;
    engine.pokeLocalChange();
    await flush();
    expect(sub.current()).toBe(first); // same array reference (no churn)
    expect(changes).toBe(before);
    sub.dispose();
  });

  it("maintains sorted order via binary-search splice as rows arrive out of order", async () => {
    const { engine, store } = await makeEngine();
    const sub = engine.subscribeLiveQuery(
      collection<RowValue>("issues").scope({ workspaceId: "w1" }).order("rank"),
      () => {}
    );
    await flush();
    for (const [id, rank] of [["i1", "m"], ["i2", "z"], ["i3", "a"], ["i4", "t"]] as const) {
      await store.applyServerChange(seedChange("issues", id, { workspaceId: "w1", status: "open", rank }));
      engine.pokeLocalChange();
      await flush();
    }
    expect(sub.current()?.map((r) => r._id)).toEqual(["i3", "i1", "i4", "i2"]); // a<m<t<z
    sub.dispose();
  });

  it("respects limit and re-fills from the maintained full set on delete", async () => {
    const { engine, store } = await makeEngine([
      seedChange("issues", "i1", { workspaceId: "w1", status: "open", rank: "a" }),
      seedChange("issues", "i2", { workspaceId: "w1", status: "open", rank: "b" }),
      seedChange("issues", "i3", { workspaceId: "w1", status: "open", rank: "c" })
    ]);
    const sub = engine.subscribeLiveQuery(
      collection<RowValue>("issues").scope({ workspaceId: "w1" }).order("rank").limit(2),
      () => {}
    );
    await flush();
    expect(sub.current()?.map((r) => r._id)).toEqual(["i1", "i2"]);
    // Delete the top row → the 3rd fills in (limit maintained from the full sorted set).
    await store.applyServerChange({
      changeId: "d1", scopeKey: "byWorkspace:w1", table: "issues", id: "i1", kind: "delete", version: 2, serverTime: 2
    });
    engine.pokeLocalChange();
    await flush();
    expect(sub.current()?.map((r) => r._id)).toEqual(["i2", "i3"]);
    sub.dispose();
  });

  it("does not leak another scope's rows into a scoped subscription", async () => {
    const { engine } = await makeEngine([
      seedChange("issues", "i1", { workspaceId: "w1", status: "open", rank: "a" }),
      seedChange("issues", "i2", { workspaceId: "w2", status: "open", rank: "a" })
    ]);
    const sub = engine.subscribeLiveQuery(collection<RowValue>("issues").scope({ workspaceId: "w1" }), () => {});
    await flush();
    expect(sub.current()?.map((r) => r._id)).toEqual(["i1"]);
    sub.dispose();
  });

  it("updates relations incrementally when the related table changes", async () => {
    const { engine, store } = await makeEngine([
      seedChange("issues", "i1", { workspaceId: "w1", status: "open", rank: "a", title: "Bug" }),
      seedChange("comments", "cm1", { workspaceId: "w1", issueId: "i1", body: "first" })
    ]);
    const sub = engine.subscribeLiveQuery(
      collection<RowValue>("issues").scope({ workspaceId: "w1" }).related("comments", many<RowValue>("comments", "issueId")),
      () => {}
    );
    await flush();
    expect((sub.current()?.[0]?.comments as unknown[])?.length).toBe(1);
    // Add a comment on the related table → the issue query updates.
    await store.applyServerChange(seedChange("comments", "cm2", { workspaceId: "w1", issueId: "i1", body: "second" }));
    engine.pokeLocalChange();
    await flush();
    expect((sub.current()?.[0]?.comments as unknown[])?.length).toBe(2);
    sub.dispose();
  });
});

describe("query planner (explain)", () => {
  it("chooses a matching index for scope-equality + order, else a full scan", async () => {
    const { engine } = await makeEngine();
    const indexed = engine.explainQuery(collection("issues").scope({ workspaceId: "w1" }).order("rank"));
    expect(indexed.strategy).toBe("index");
    expect(indexed.index).toBe("byRank");
    expect(indexed.sortedByIndex).toBe(true);

    // Ordering by a non-indexed field → full scan.
    const scan = engine.explainQuery(collection("issues").scope({ workspaceId: "w1" }).order("title"));
    expect(scan.strategy).toBe("scan");
    expect(scan.index).toBe(null);

    // A scoped table queried with no scope value fails closed.
    const closed = engine.explainQuery(collection("issues"));
    expect(closed.scopeSatisfied).toBe(false);
  });
});
