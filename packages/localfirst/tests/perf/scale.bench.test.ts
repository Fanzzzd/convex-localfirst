import { describe, expect, it } from "vitest";
import {
  MemoryLocalStore,
  byWorkspace,
  collection,
  defineLocalFirstManifest,
  localTable,
  type RowValue,
  type ServerChange
} from "../../src/core";
import { LocalCache, LocalFirstEngine, SearchManager } from "../../src/core/internal";

/**
 * Scale/perf regression suite (P3 item 6). Plain vitest tests (not `vitest bench`) so they
 * run in the normal CI gate. Ceilings are DELIBERATELY generous absolute wall-clock bounds
 * (so slow/loaded CI never flakes); the actual numbers are console.logged for tracking.
 *
 * Skip locally with LF_SKIP_BENCH=1.
 */
const skip = process.env.LF_SKIP_BENCH === "1";

const WORKSPACE = "w1";
const STATUSES = ["open", "in_progress", "closed", "backlog"] as const;

function manifest() {
  const ws = byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "m" });
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      issues: localTable({
        table: "issues",
        idField: "localId",
        scope: ws,
        indexes: {
          byRank: ["workspaceId", "rank"],
          byStatusRank: ["workspaceId", "status", "rank"]
        }
      })
    },
    queries: {},
    mutations: {}
  });
}

/** N synthetic issues, all in one workspace (the Plane-scale worst case). */
function synthIssues(n: number): ServerChange[] {
  const changes: ServerChange[] = new Array(n);
  for (let i = 0; i < n; i++) {
    changes[i] = {
      changeId: `c${i}`,
      scopeKey: `byWorkspace:${WORKSPACE}`,
      table: "issues",
      id: `i${i}`,
      kind: "insert",
      value: {
        workspaceId: WORKSPACE,
        status: STATUSES[i % STATUSES.length],
        rank: String(i).padStart(9, "0"),
        title: `Issue ${i}`,
        assignee: `u${i % 50}`
      },
      version: 1,
      serverTime: 1
    };
  }
  return changes;
}

function hostEngine() {
  // A host for the standalone cache: only its manifest + scope-matching logic is used
  // (pure, store-independent), so it runs against an empty store of its own.
  return new LocalFirstEngine({ manifest: manifest(), store: new MemoryLocalStore(), clientId: "c", userId: "u", nameOf: (r) => String(r) });
}

async function seededStore(n: number): Promise<MemoryLocalStore> {
  const store = new MemoryLocalStore();
  await store.applyServerChanges(synthIssues(n));
  return store;
}

function ms(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

(skip ? describe.skip : describe)("scale benchmarks (P3)", () => {
  for (const N of [10_000, 50_000] as const) {
    describe(`${N.toLocaleString()} issues`, () => {
      it("(a) boots hydration into the cache", async () => {
        const store = await seededStore(N);
        const cache = new LocalCache(hostEngine(), store);
        const t0 = performance.now();
        await cache.hydrate();
        const elapsed = performance.now() - t0;
        console.log(`[bench] (a) hydrate ${N} rows into cache: ${elapsed.toFixed(1)}ms`);
        expect(cache.tableRows("issues").length).toBe(N);
        expect(elapsed).toBeLessThan(N >= 50_000 ? 4000 : 2000);
      });

      it("(b) applies a 500-change server pull incrementally", async () => {
        const store = await seededStore(N);
        const cache = new LocalCache(hostEngine(), store);
        await cache.hydrate();
        // 500 changes: 250 patches to existing rows + 250 brand-new rows.
        const changes: ServerChange[] = [];
        for (let k = 0; k < 250; k++) {
          changes.push({
            changeId: `p${k}`, scopeKey: `byWorkspace:${WORKSPACE}`, table: "issues", id: `i${k}`,
            kind: "patch", patch: { status: "closed" }, version: 2, serverTime: 2
          });
          changes.push({
            changeId: `n${k}`, scopeKey: `byWorkspace:${WORKSPACE}`, table: "issues", id: `new${k}`,
            kind: "insert", value: { workspaceId: WORKSPACE, status: "open", rank: `zz${k}`, title: `New ${k}` }, version: 1, serverTime: 2
          });
        }
        const elapsed = ms(() => cache.applyServerChanges(changes));
        console.log(`[bench] (b) apply 500-change pull at ${N} rows: ${elapsed.toFixed(1)}ms`);
        expect(cache.tableRows("issues").length).toBe(N + 250);
        expect(elapsed).toBeLessThan(1000);
      });

      it("(c) propagates a single-row delta to 20 active queries", async () => {
        const store = await seededStore(N);
        const engine = hostEngine();
        const cache = new LocalCache(engine, store);
        await cache.hydrate();
        // 20 active queries, each a scoped + ordered slice with a predicate.
        const subs = Array.from({ length: 20 }, (_, k) =>
          cache.subscribeQuery(
            collection<RowValue>("issues")
              .scope({ workspaceId: WORKSPACE })
              .where((r) => r.status === STATUSES[k % STATUSES.length])
              .order("rank")
              .limit(50),
            () => {}
          )
        );
        // One new row that matches some of the 20 queries.
        const delta: ServerChange = {
          changeId: "hot", scopeKey: `byWorkspace:${WORKSPACE}`, table: "issues", id: "hotrow",
          kind: "insert", value: { workspaceId: WORKSPACE, status: "open", rank: "000000000", title: "hot" }, version: 1, serverTime: 3
        };
        const elapsed = ms(() => cache.applyServerChanges([delta]));
        console.log(`[bench] (c) single delta → 20 queries at ${N} rows: ${elapsed.toFixed(2)}ms`);
        // The spec's headline ceiling: single-delta propagation < 50ms at 50k.
        expect(elapsed).toBeLessThan(50);
        for (const sub of subs) sub.dispose();
      });

      it("(d) an indexed query beats a full scan", async () => {
        const store = await seededStore(N);
        const engine = hostEngine();
        const cache = new LocalCache(engine, store);
        await cache.hydrate();

        // Indexed: equality on (workspaceId, status) + order on rank → the byStatusRank index
        // narrows candidates to one status (~N/4) AND yields them pre-sorted (no sort).
        const indexedPlan = collection<RowValue>("issues").scope({ workspaceId: WORKSPACE, status: "open" }).order("rank");
        expect(cache.explain(indexedPlan).strategy).toBe("index");
        expect(cache.explain(indexedPlan).index).toBe("byStatusRank");
        const indexed = ms(() => {
          const sub = cache.subscribeQuery(indexedPlan, () => {});
          void sub.current();
          sub.dispose();
        });

        // Full scan: the same result set, but ordering on a NON-indexed field forces a
        // whole-table filter + sort.
        const scanPlan = collection<RowValue>("issues")
          .scope({ workspaceId: WORKSPACE })
          .where((r) => r.status === "open")
          .order("title");
        expect(cache.explain(scanPlan).strategy).toBe("scan");
        const scan = ms(() => {
          const sub = cache.subscribeQuery(scanPlan, () => {});
          void sub.current();
          sub.dispose();
        });

        console.log(`[bench] (d) indexed=${indexed.toFixed(1)}ms  fullScan=${scan.toFixed(1)}ms  at ${N} rows`);
        expect(indexed).toBeLessThan(N >= 50_000 ? 3000 : 1500);
        expect(scan).toBeLessThan(N >= 50_000 ? 4000 : 2000);
      });

      if (N === 50_000) {
        it("maintains a four-column grouped board incrementally", async () => {
          const store = await seededStore(N);
          const cache = new LocalCache(hostEngine(), store);
          await cache.hydrate();
          const plan = collection<RowValue>("issues")
            .scope({ workspaceId: WORKSPACE })
            .groupBy("status")
            .order("rank");
          let sub!: ReturnType<typeof cache.subscribeQuery<RowValue, unknown, "status">>;
          const initMs = ms(() => {
            sub = cache.subscribeQuery(plan, () => {});
          });
          const before = sub.current();
          const untouched = before.get("in_progress");
          expect([...before.values()].reduce((total, rows) => total + rows.length, 0)).toBe(N);

          const moveMs = ms(() => cache.applyServerChanges([{
            changeId: "board-move", scopeKey: `byWorkspace:${WORKSPACE}`, table: "issues", id: "i0",
            kind: "patch", patch: { status: "closed", rank: "000000010" }, version: 2, serverTime: 2
          }]));
          const after = sub.current();
          console.log(
            `[bench] grouped-board at ${N}: init=${initMs.toFixed(1)}ms  move=${moveMs.toFixed(2)}ms`
          );
          expect(after.get("open")).toHaveLength(N / 4 - 1);
          expect(after.get("closed")).toHaveLength(N / 4 + 1);
          expect(after.get("in_progress")).toBe(untouched);
          expect(initMs).toBeLessThan(3000);
          expect(moveMs).toBeLessThan(50);
          sub.dispose();
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Local full-text search (P4): search-as-you-type latency at Plane scale.
// ---------------------------------------------------------------------------

// Rotated vocabulary so "iss" matches EVERY row (worst case: rank+sort 50k) while
// "issue tra…" narrows to the rows whose title carries a "tra*" word.
const TRA_WORDS = ["tracker", "traffic", "transfer", "transit", "translation", "trailing"];
const OTHER_WORDS = ["backlog", "regression", "flaky", "timeout", "layout", "cursor", "hover", "modal"];

function searchManifest() {
  const ws = byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "m" });
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      issues: localTable({
        table: "issues",
        idField: "localId",
        scope: ws,
        indexes: {},
        searchFields: ["title", "description_html"]
      })
    },
    queries: {},
    mutations: {}
  });
}

/** N searchable issues: every title contains "Issue"; ~1/7 also carry a "tra*" word. */
function synthSearchable(n: number): ServerChange[] {
  const changes: ServerChange[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const traWord = i % 7 === 0 ? TRA_WORDS[i % TRA_WORDS.length]! : OTHER_WORDS[i % OTHER_WORDS.length]!;
    changes[i] = {
      changeId: `c${i}`,
      scopeKey: `byWorkspace:${WORKSPACE}`,
      table: "issues",
      id: `i${i}`,
      kind: "insert",
      value: {
        workspaceId: WORKSPACE,
        title: `Issue ${i}: ${traWord} problem`,
        description_html: `<p>The <b>${traWord}</b> needs attention in module ${i % 200}.</p>`,
        updated_at: i
      },
      version: 1,
      serverTime: 1
    };
  }
  return changes;
}

function searchHost() {
  return new LocalFirstEngine({ manifest: searchManifest(), store: new MemoryLocalStore(), clientId: "c", userId: "u", nameOf: (r) => String(r) });
}

(skip ? describe.skip : describe)("search benchmarks (P4)", () => {
  for (const N of [10_000, 50_000] as const) {
    it(`(e) search-as-you-type over ${N.toLocaleString()} issues stays instant`, async () => {
      const store = new MemoryLocalStore();
      await store.applyServerChanges(synthSearchable(N));
      const cache = new LocalCache(searchHost(), store);
      await cache.hydrate();

      const t0 = performance.now();
      const manager = new SearchManager(cache, searchManifest());
      const buildMs = performance.now() - t0;
      console.log(`[bench] (e) build search index for ${N} rows: ${buildMs.toFixed(1)}ms`);

      // Type "issue tracker" one keystroke at a time; measure each lookup. "iss" is the
      // worst case (matches all N rows → rank+sort N); later keystrokes narrow.
      const sequence = ["i", "is", "iss", "issu", "issue", "issue ", "issue t", "issue tr", "issue tra"];
      let worst = 0;
      let issMs = 0;
      let issueTraMs = 0;
      let issueTraTotal = 0;
      for (const q of sequence) {
        const t = performance.now();
        const res = manager.run("issues", q, { scope: { workspaceId: WORKSPACE }, limit: 25 });
        const dt = performance.now() - t;
        worst = Math.max(worst, dt);
        if (q === "iss") issMs = dt;
        if (q === "issue tra") {
          issueTraMs = dt;
          issueTraTotal = res.total;
        }
      }
      console.log(
        `[bench] (e) at ${N}: "iss"=${issMs.toFixed(2)}ms  "issue tra"=${issueTraMs.toFixed(2)}ms ` +
          `(total ${issueTraTotal})  worstKeystroke=${worst.toFixed(2)}ms`
      );

      // "iss" matches every row; "issue tra" narrows to the tra* subset (~N/7).
      expect(manager.run("issues", "iss", { scope: { workspaceId: WORKSPACE } }).total).toBe(N);
      expect(issueTraTotal).toBeGreaterThan(0);
      expect(issueTraTotal).toBeLessThan(N);
      // The spec's headline keystrokes stay instant even at 50k (generous ceiling so loaded
      // CI never flakes; console logs track the real numbers). "iss" is the worst realistic
      // case (matches all N rows → rank+sort N).
      expect(issMs).toBeLessThan(20);
      expect(issueTraMs).toBeLessThan(20);
      // Whole-sequence sanity bound: even a 1-char prefix (broadest possible, plus the
      // one-time lazy vocab sort on the first probe) must not blow up — a real regression trips.
      expect(worst).toBeLessThan(50);
    });
  }
});
