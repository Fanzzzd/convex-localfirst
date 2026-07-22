import { describe, expect, it, vi } from "vitest";
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
import { LocalCache, LocalFirstEngine, SortedIndex } from "../../src/core/internal";

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

  it("plans filter eq/in prefixes and the next-field range, but not opaque where predicates", async () => {
    const { engine } = await makeEngine();
    const eq = engine.explainQuery(
      collection<RowValue>("issues")
        .scope({ workspaceId: "w1" })
        .filter({ status: "open", rank: { gte: "b", lt: "z" } })
        .order("rank")
    );
    expect(eq).toMatchObject({ strategy: "index", index: "byStatusRank", prefix: ["w1", "open"] });
    expect(eq.range).toEqual({ field: "rank", gte: "b", lt: "z" });

    const union = engine.explainQuery(
      collection<RowValue>("issues")
        .scope({ workspaceId: "w1" })
        .filter({ status: { in: ["open", "closed"] } })
        .order("rank")
    );
    expect(union).toMatchObject({ strategy: "index", index: "byStatusRank", sortedByIndex: false });
    expect(union.prefixes).toEqual([["w1", "open"], ["w1", "closed"]]);

    const largeIn = engine.explainQuery(
      collection<RowValue>("issues")
        .scope({ workspaceId: "w1" })
        .filter({ status: { in: Array.from({ length: 17 }, (_, index) => `s${index}`) } })
        .order("rank")
    );
    expect(largeIn.strategy).toBe("scan");

    const opaque = engine.explainQuery(
      collection<RowValue>("issues")
        .scope({ workspaceId: "w1" })
        .where((row) => row.status === "open")
        .order("rank")
    );
    expect(opaque.index).toBe("byRank");
    expect(opaque.index).not.toBe("byStatusRank");
  });
});

describe("grouped and count-only live views", () => {
  it("moves rows between groups, adds/removes groups, and preserves unaffected identities", async () => {
    const { engine, store } = await makeEngine([
      seedChange("issues", "i0", { workspaceId: "w1", status: null, rank: "0" }),
      seedChange("issues", "i1", { workspaceId: "w1", status: "open", rank: "b" }),
      seedChange("issues", "i2", { workspaceId: "w1", status: "closed", rank: "a" })
    ]);
    const sub = engine.subscribeLiveQuery(
      collection<RowValue>("issues").scope({ workspaceId: "w1" }).groupBy("status").order("rank"),
      () => {}
    );
    await flush();
    const initial = sub.current()!;
    const initialClosed = initial.get("closed")!;
    const initialNull = initial.get(null)!;
    expect(initialNull.map((row) => row._id)).toEqual(["i0"]);
    expect(initial.get("open")?.map((row) => row._id)).toEqual(["i1"]);

    await store.applyServerChange({
      changeId: "move", scopeKey: "byWorkspace:w1", table: "issues", id: "i1",
      kind: "patch", patch: { status: "closed", rank: "c" }, version: 2, serverTime: 2
    });
    engine.pokeLocalChange();
    await flush();
    const moved = sub.current()!;
    expect(moved).not.toBe(initial);
    expect(moved.has("open")).toBe(false);
    expect(moved.get("closed")?.map((row) => row._id)).toEqual(["i2", "i1"]);
    expect(moved.get(null)).toBe(initialNull);

    const movedClosed = moved.get("closed")!;
    await store.applyServerChange(
      seedChange("issues", "i3", { workspaceId: "w1", status: "backlog", rank: "d" })
    );
    engine.pokeLocalChange();
    await flush();
    const appeared = sub.current()!;
    expect(appeared.get("closed")).toBe(movedClosed);
    expect(appeared.get("backlog")?.map((row) => row._id)).toEqual(["i3"]);

    const stable = sub.current();
    engine.pokeLocalChange();
    await flush();
    expect(sub.current()).toBe(stable);
    expect(initialClosed).not.toBe(movedClosed);
    sub.dispose();
  });

  it("maintains grouped and scalar counts without invoking the row-output path", async () => {
    const store = new MemoryLocalStore();
    for (const change of [
      seedChange("issues", "i1", { workspaceId: "w1", status: "open", rank: "a" }),
      seedChange("issues", "i2", { workspaceId: "w1", status: "open", rank: "b" }),
      seedChange("issues", "i3", { workspaceId: "w1", status: "closed", rank: "c" })
    ]) await store.applyServerChange(change);
    const host = new LocalFirstEngine({
      manifest: issuesManifest(), store: new MemoryLocalStore(), clientId: "c", userId: "u", nameOf: String
    });
    const cache = new LocalCache(host, store);
    await cache.hydrate();
    const rowPath = vi.spyOn(cache as unknown as { _tableRowsInternal(table: string): readonly RowValue[] }, "_tableRowsInternal");
    const plan = collection<RowValue>("issues").scope({ workspaceId: "w1" }).groupBy("status");
    const rowRun = vi.spyOn(plan, "run");
    const grouped = cache.subscribeCounts(plan, () => {});
    const scalar = cache.subscribeCounts(collection<RowValue>("issues").scope({ workspaceId: "w1" }), () => {});
    expect(grouped.current()).toEqual({ open: 2, closed: 1 });
    expect(scalar.current()).toBe(3);
    expect(rowPath).not.toHaveBeenCalled();
    expect(rowRun).not.toHaveBeenCalled();

    cache.applyServerChanges([{
      changeId: "move-count", scopeKey: "byWorkspace:w1", table: "issues", id: "i3",
      kind: "patch", patch: { status: "open" }, version: 2, serverTime: 2
    }]);
    expect(grouped.current()).toEqual({ open: 3 });
    expect(scalar.current()).toBe(3);
    expect(rowPath).not.toHaveBeenCalled();
    expect(rowRun).not.toHaveBeenCalled();
    grouped.dispose();
    scalar.dispose();
  });
});
