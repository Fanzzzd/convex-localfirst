import { describe, expect, it } from "vitest";
import {
  MemoryLocalStore,
  byWorkspace,
  defineLocalFirstManifest,
  localTable,
  type RowDelta,
  type RowValue,
  type ServerChange,
} from "../../src/core";
import {
  LocalCache,
  LocalFirstEngine,
  SearchIndex,
  SearchManager,
  looksLikeHtml,
  stripHtml,
  tokenize,
} from "../../src/core/internal";

// ---------------------------------------------------------------------------
// Tokenizer / HTML stripping
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumerics", () => {
    expect(tokenize("Fix the Login-Bug, now!")).toEqual(["fix", "the", "login", "bug", "now"]);
  });

  it("is unicode-aware (accents, non-latin scripts, digits)", () => {
    expect(tokenize("Café déjà-vu")).toEqual(["café", "déjà", "vu"]);
    expect(tokenize("naïve 42 tokens")).toEqual(["naïve", "42", "tokens"]);
    expect(tokenize("北京 city")).toEqual(["北京", "city"]);
  });

  it("strips HTML tags from values that look like HTML", () => {
    expect(looksLikeHtml("<p>hello</p>")).toBe(true);
    expect(looksLikeHtml("a < b and c > d")).toBe(false);
    expect(tokenize("<p>Hello <b>world</b></p>")).toEqual(["hello", "world"]);
    // A '<' used as a comparison is not treated as a tag → the surrounding text survives.
    expect(tokenize("a < b")).toEqual(["a", "b"]);
  });

  it("decodes a few common entities when stripping HTML", () => {
    expect(stripHtml("<i>Tom &amp; Jerry</i>")).toContain("&");
    expect(tokenize("<i>Tom &amp; Jerry</i>")).toEqual(["tom", "jerry"]);
  });

  it("coerces arrays and non-strings, and handles empty/null", () => {
    expect(tokenize(["red", "green-ish"])).toEqual(["red", "green", "ish"]);
    expect(tokenize(1234)).toEqual(["1234"]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SearchIndex: scoring / prefix / required tokens
// ---------------------------------------------------------------------------

function idx(
  fields: string[],
  rows: Array<{ id: string; values: unknown[]; recency?: number | null }>,
): SearchIndex {
  const index = new SearchIndex(fields);
  for (const row of rows) index.add(row.id, row.values, row.recency ?? null);
  return index;
}

describe("SearchIndex ranking", () => {
  it("prefix-matches the final query token (search-as-you-type)", () => {
    const index = idx(
      ["title"],
      [
        { id: "a", values: ["Issue tracker"] },
        { id: "b", values: ["Issued badge"] },
        { id: "c", values: ["Completely unrelated"] },
      ],
    );
    expect(new Set(index.search("iss").ids)).toEqual(new Set(["a", "b"]));
    expect(index.search("track").ids).toEqual(["a"]);
    expect(index.search("xyz").ids).toEqual([]);
  });

  it("weights earlier searchFields more heavily", () => {
    // "urgent" in the title (field 0) should outrank "urgent" only in the body (field 1).
    const index = idx(
      ["title", "body"],
      [
        { id: "title-hit", values: ["urgent thing", "plain body"] },
        { id: "body-hit", values: ["plain thing", "urgent body"] },
      ],
    );
    expect(index.search("urgent").ids).toEqual(["title-hit", "body-hit"]);
  });

  it("ranks an exact token above a longer prefix-only match", () => {
    const index = idx(
      ["title"],
      [
        { id: "prefix", values: ["issues galore"] },
        { id: "exact", values: ["issue"] },
      ],
    );
    // Query "issue": "exact" matches the whole token, "prefix" only via "issues".
    expect(index.search("issue").ids).toEqual(["exact", "prefix"]);
  });

  it("ranks a row matching more prefix tokens above one matching fewer", () => {
    const index = idx(
      ["title"],
      [
        { id: "many", values: ["issue issues issuer"] },
        { id: "one", values: ["issue alone"] },
      ],
    );
    expect(index.search("iss").ids).toEqual(["many", "one"]);
  });

  it("requires every complete (non-final) token (AND semantics)", () => {
    const index = idx(
      ["title"],
      [
        { id: "both", values: ["login page bug"] },
        { id: "onlylogin", values: ["login screen"] },
        { id: "onlybug", values: ["random bug"] },
      ],
    );
    // "login bug" → "login" required exact, "bug" prefix. Only the row with both matches.
    expect(index.search("login bug").ids).toEqual(["both"]);
  });

  it("breaks ties by recency (newer first) then by id", () => {
    const index = idx(
      ["title"],
      [
        { id: "old", values: ["same title"], recency: 100 },
        { id: "new", values: ["same title"], recency: 200 },
        { id: "none1", values: ["same title"], recency: null },
        { id: "none2", values: ["same title"], recency: null },
      ],
    );
    // Equal score: recency desc first (new before old), rows without recency sort last by id.
    expect(index.search("same").ids).toEqual(["new", "old", "none1", "none2"]);
  });

  it("reports total and honors limit", () => {
    const index = idx(
      ["title"],
      Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, values: ["match"] })),
    );
    const res = index.search("match", { limit: 3 });
    expect(res.total).toBe(10);
    expect(res.ids).toHaveLength(3);
  });

  it("empty query yields nothing", () => {
    const index = idx(["title"], [{ id: "a", values: ["anything"] }]);
    expect(index.search("")).toEqual({ ids: [], total: 0 });
    expect(index.search("   ")).toEqual({ ids: [], total: 0 });
  });

  it("applies a scope filter and reflects it in total", () => {
    const index = idx(
      ["title"],
      [
        { id: "a", values: ["shared word"] },
        { id: "b", values: ["shared word"] },
        { id: "c", values: ["shared word"] },
      ],
    );
    const res = index.search("shared", { filter: (id) => id !== "b" });
    expect(new Set(res.ids)).toEqual(new Set(["a", "c"]));
    expect(res.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Incremental maintenance (add / update / remove without a rebuild)
// ---------------------------------------------------------------------------

describe("SearchIndex incremental maintenance", () => {
  it("reflects re-index (patch) and removal", () => {
    const index = new SearchIndex(["title"]);
    index.add("a", ["hello world"], null);
    expect(index.search("world").ids).toEqual(["a"]);

    // Patch: re-add same id with new text — old tokens must be dropped.
    index.add("a", ["hello there"], null);
    expect(index.search("world").ids).toEqual([]);
    expect(index.search("there").ids).toEqual(["a"]);

    index.remove("a");
    expect(index.search("hello").ids).toEqual([]);
    expect(index.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SearchManager wired to a live cache via the engine (delta-driven, no rescans)
// ---------------------------------------------------------------------------

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
        searchFields: ["title", "description_html"],
      }),
      // A non-searchable table (no searchFields) — search must yield nothing for it.
      comments: localTable({ table: "comments", idField: "localId", scope: ws, indexes: {} }),
    },
    queries: {},
    mutations: {},
  });
}

function change(
  id: string,
  value: Record<string, unknown>,
  kind: ServerChange["kind"] = "insert",
  version = 1,
  ws = "w1",
): ServerChange {
  const base = {
    changeId: `c-${id}-${version}`,
    scopeKey: `byWorkspace:${ws}`,
    table: "issues",
    id,
    kind,
    version,
    serverTime: version,
  };
  // Patch changes carry a `patch`; insert/replace carry a `value`; delete carries neither.
  if (kind === "patch") return { ...base, patch: value };
  if (kind === "delete") return base as ServerChange;
  return { ...base, value };
}

/** A standalone LocalCache (using the engine only as the pure CacheHost) seeded from the
 *  store, hydrated, with a SearchManager wired to its delta bus — the exact substrate the
 *  engine wires internally, but drivable directly via cache.applyServerChanges. */
async function seededManager(
  seed: ServerChange[],
): Promise<{ cache: LocalCache; manager: SearchManager }> {
  const store = new MemoryLocalStore();
  for (const c of seed) await store.applyServerChange(c);
  const manifest = searchManifest();
  const host = new LocalFirstEngine({
    manifest,
    store: new MemoryLocalStore(),
    clientId: "c",
    userId: "u",
    nameOf: (r) => String(r),
  });
  const cache = new LocalCache(host, store);
  await cache.hydrate();
  const manager = new SearchManager(cache, manifest);
  return { cache, manager };
}

describe("SearchManager (delta-maintained, no rescans)", () => {
  it("builds from the hydrated cache and resolves live rows; HTML fields are searchable", async () => {
    const { manager } = await seededManager([
      change("i1", {
        workspaceId: "w1",
        title: "Login bug",
        description_html: "<p>Cannot <b>sign in</b></p>",
      }),
      change("i2", { workspaceId: "w1", title: "Logout works", description_html: "<p>fine</p>" }),
    ]);
    const sub = manager.subscribe("issues", "log", undefined, () => {});
    expect(new Set(sub.current().results.map((r) => r._id))).toEqual(new Set(["i1", "i2"]));
    expect(sub.current().total).toBe(2);
    // "sign" appears only inside the tag-stripped description_html.
    const sub2 = manager.subscribe("issues", "sign", undefined, () => {});
    expect(sub2.current().results.map((r) => r._id)).toEqual(["i1"]);
    sub.dispose();
    sub2.dispose();
  });

  it("updates a live search from deltas (insert/patch/delete) without a rebuild", async () => {
    const { cache, manager } = await seededManager([
      change("i1", { workspaceId: "w1", title: "alpha", description_html: "" }),
    ]);
    let notes = 0;
    const sub = manager.subscribe("issues", "alpha", undefined, () => notes++);
    expect(sub.current().results.map((r) => r._id)).toEqual(["i1"]);

    // INSERT a new matching row → delta → index update → notify.
    cache.applyServerChanges([
      change("i2", { workspaceId: "w1", title: "alpha two", description_html: "" }),
    ]);
    expect(notes).toBeGreaterThan(0);
    expect(new Set(sub.current().results.map((r) => r._id))).toEqual(new Set(["i1", "i2"]));

    // PATCH i1's title away from "alpha" → it leaves the result.
    cache.applyServerChanges([
      change("i1", { workspaceId: "w1", title: "renamed", description_html: "" }, "patch", 2),
    ]);
    expect(sub.current().results.map((r) => r._id)).toEqual(["i2"]);

    // DELETE i2 → empty.
    cache.applyServerChanges([change("i2", { workspaceId: "w1" }, "delete", 3)]);
    expect(sub.current().results).toEqual([]);
    sub.dispose();
  });

  it("filters by scope and reflects it in total", async () => {
    const { manager } = await seededManager([
      change("i1", { workspaceId: "w1", title: "shared", description_html: "" }),
      change("i2", { workspaceId: "w2", title: "shared", description_html: "" }, "insert", 1, "w2"),
    ]);
    const scoped = manager.subscribe(
      "issues",
      "shared",
      { scope: { workspaceId: "w1" } },
      () => {},
    );
    expect(scoped.current().results.map((r) => r._id)).toEqual(["i1"]);
    expect(scoped.current().total).toBe(1);
    scoped.dispose();
  });

  it("yields nothing for a table without searchFields", async () => {
    const { manager } = await seededManager([
      change("i1", { workspaceId: "w1", title: "x", description_html: "" }),
    ]);
    const sub = manager.subscribe("comments", "anything", undefined, () => {});
    expect(sub.current()).toEqual({ results: [], total: 0 });
    sub.dispose();
  });

  it("keeps a stable result reference when an unrelated change lands", async () => {
    const { cache, manager } = await seededManager([
      change("i1", { workspaceId: "w1", title: "alpha", description_html: "" }),
    ]);
    const sub = manager.subscribe("issues", "alpha", undefined, () => {});
    const first = sub.current().results;
    // An unrelated insert (doesn't match "alpha") must not change the result identity.
    cache.applyServerChanges([
      change("i2", { workspaceId: "w1", title: "beta", description_html: "" }),
    ]);
    expect(sub.current().results).toBe(first);
    sub.dispose();
  });
});

// A standalone SearchManager over a hand-built cache-like, proving no engine dependency.
describe("SearchManager (standalone over a minimal cache)", () => {
  it("builds once and maintains from deltas", () => {
    const rows = new Map<string, RowValue>();
    const listeners = new Set<(d: readonly RowDelta[]) => void>();
    const cache = {
      isHydrated: true,
      hydrate: async () => {},
      tableRows: (t: string) => (t === "docs" ? [...rows.values()] : []),
      visibleRow: (_t: string, id: string) => rows.get(id),
      subscribeDeltas: (l: (d: readonly RowDelta[]) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    rows.set("d1", { _id: "d1", title: "hello world" });
    const manifest = defineLocalFirstManifest({
      schemaVersion: 1,
      tables: {
        docs: localTable({
          table: "docs",
          idField: "localId",
          scope: byWorkspace({ workspaceIdField: "w", membershipTable: "m" }),
          indexes: {},
          searchFields: ["title"],
        }),
      },
      queries: {},
      mutations: {},
    });
    const manager = new SearchManager(cache, manifest);
    let notified = 0;
    const sub = manager.subscribe("docs", "hello", undefined, () => notified++);
    expect(sub.current().results.map((r) => r._id)).toEqual(["d1"]);

    // Simulate a delta: add d2, emit.
    rows.set("d2", { _id: "d2", title: "hello there" });
    for (const l of listeners)
      l([{ table: "docs", localId: "d2", kind: "upsert", row: rows.get("d2")! }]);
    expect(notified).toBeGreaterThan(0);
    expect(new Set(sub.current().results.map((r) => r._id))).toEqual(new Set(["d1", "d2"]));
    manager.dispose();
  });
});
