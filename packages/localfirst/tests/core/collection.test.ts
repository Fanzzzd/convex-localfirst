import { describe, expect, it } from "vitest";
import {
  MemoryLocalStore,
  byWorkspace,
  collection,
  defineLocalFirstManifest,
  localTable,
  many,
  manyToMany,
  one,
  viaIds
} from "../../src/core";
import { LocalFirstEngine } from "../../src/core/internal";
import { acceptAllTransport, createHarness } from "./helpers";

describe("collection() client query builder", () => {
  it("filters, orders, and limits the live derived view", async () => {
    const { engine } = createHarness({ transport: acceptAllTransport() });
    await engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "a" }).local;
    await engine.mutate("todos:create", { localId: "t2", listId: "inbox", text: "b" }).local;
    await engine.mutate("todos:create", { localId: "t3", listId: "inbox", text: "c" }).local;
    await engine.mutate("todos:toggle", { id: "t2", done: true }).local;

    const rows = await engine.runLocalQuery(
      collection("todos")
        .where((row) => row.done !== true)
        .order("createdAt", "desc")
        .limit(1)
    );

    // newest not-done todo, capped at 1 — proves where + order + limit compose.
    expect(rows.map((row) => row.text)).toEqual(["c"]);
  });

  it("chains where as AND and only sees rows already in the local store", async () => {
    const { engine } = createHarness({ transport: acceptAllTransport() });
    await engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "keep" }).local;
    await engine.mutate("todos:create", { localId: "t2", listId: "later", text: "drop" }).local;

    const rows = await engine.runLocalQuery(
      collection("todos")
        .where((row) => row.listId === "inbox")
        .where((row) => row.text === "keep")
    );

    expect(rows.map((row) => row.text)).toEqual(["keep"]);
  });

  it("scope() filters rows, not just the pull (no cross-scope leak when multiple scopes are local)", async () => {
    const { engine } = createHarness({ transport: acceptAllTransport() });
    await engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "a" }).local;
    await engine.mutate("todos:create", { localId: "t2", listId: "later", text: "b" }).local;
    await engine.mutate("todos:create", { localId: "t3", listId: "inbox", text: "c" }).local;

    // The local store holds two "scopes" (listId values); scope() must show only one.
    const rows = await engine.runLocalQuery(collection("todos").scope({ listId: "inbox" }));
    expect(rows.map((row) => row.text).sort()).toEqual(["a", "c"]);
  });

  it("limit clamps a negative value to empty instead of dropping the last row", async () => {
    const { engine } = createHarness({ transport: acceptAllTransport() });
    await engine.mutate("todos:create", { localId: "t1", listId: "inbox", text: "a" }).local;
    await engine.mutate("todos:create", { localId: "t2", listId: "inbox", text: "b" }).local;
    const rows = await engine.runLocalQuery(collection("todos").limit(-1));
    expect(rows).toHaveLength(0);
  });

  it("runLocalQuery fails closed for a workspace-scoped table queried with no scope value", async () => {
    const manifest = defineLocalFirstManifest({
      schemaVersion: 1,
      tables: {
        issues: localTable({
          table: "issues",
          idField: "localId",
          scope: byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "m" }),
          indexes: {}
        })
      },
      queries: {},
      mutations: {}
    });
    const store = new MemoryLocalStore();
    await store.applyServerChange({
      changeId: "c1", scopeKey: "byWorkspace:w1", table: "issues", id: "i1",
      kind: "insert", value: { workspaceId: "w1", title: "x" }, version: 1, serverTime: 1
    });
    const engine = new LocalFirstEngine({ manifest, store, clientId: "c", userId: "u", nameOf: String });

    // No scope value -> empty, NOT the whole local cache.
    expect(await engine.runLocalQuery(collection("issues"))).toEqual([]);
    expect(await engine.runLocalQuery(collection("issues").scope({}))).toEqual([]);
    // With the scope value -> the row is returned.
    const rows = await engine.runLocalQuery(collection("issues").scope({ workspaceId: "w1" }));
    expect(rows.map((row) => row.title)).toEqual(["x"]);
  });

  it("engine.query (declarative path) also fails closed for a scoped table without the scope arg", async () => {
    const manifest = defineLocalFirstManifest({
      schemaVersion: 1,
      tables: {
        issues: localTable({
          table: "issues",
          idField: "localId",
          scope: byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "m" }),
          indexes: {}
        })
      },
      queries: {
        "issues:list": {
          kind: "query",
          name: "issues:list",
          table: "issues",
          initial: [],
          scope: (args: { workspaceId?: string }) => ({
            kind: "byWorkspace" as const,
            key: `byWorkspace:${String(args.workspaceId)}`,
            table: "issues"
          }),
          run: (rows: readonly Record<string, unknown>[], args: { workspaceId?: string }) =>
            rows.filter((row) => row.workspaceId === args.workspaceId)
        }
      },
      mutations: {}
    });
    const store = new MemoryLocalStore();
    await store.applyServerChange({
      changeId: "c1", scopeKey: "byWorkspace:w1", table: "issues", id: "i1", kind: "insert",
      value: { workspaceId: "w1", title: "x" }, version: 1, serverTime: 1
    });
    await store.applyServerChange({
      changeId: "c2", scopeKey: "byWorkspace:w2", table: "issues", id: "i2", kind: "insert",
      value: { workspaceId: "w2", title: "y" }, version: 1, serverTime: 1
    });
    const engine = new LocalFirstEngine({ manifest, store, clientId: "c", userId: "u", nameOf: String });

    // Missing scope arg -> initial (empty), NOT both cached workspaces' rows.
    expect(await engine.query("issues:list", {})).toEqual([]);
    // With the scope arg -> only that workspace's row.
    const w1 = (await engine.query("issues:list", { workspaceId: "w1" })) as Array<{ title: string }>;
    expect(w1.map((row) => row.title)).toEqual(["x"]);
  });

  it("a sloppy custom query.run cannot leak another scope's cached rows (engine pre-filters)", async () => {
    const manifest = defineLocalFirstManifest({
      schemaVersion: 1,
      tables: {
        issues: localTable({
          table: "issues",
          idField: "localId",
          scope: byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "m" }),
          indexes: {}
        })
      },
      // A custom query whose run() ignores the workspace scope entirely — the engine
      // must still confine it to the requested scope so it can't see other workspaces.
      queries: {
        "issues:all": {
          kind: "query",
          name: "issues:all",
          table: "issues",
          initial: [],
          run: (rows) => rows
        }
      },
      mutations: {}
    });
    const store = new MemoryLocalStore();
    await store.applyServerChange({
      changeId: "c1", scopeKey: "byWorkspace:w1", table: "issues", id: "i1", kind: "insert",
      value: { workspaceId: "w1", title: "x" }, version: 1, serverTime: 1
    });
    await store.applyServerChange({
      changeId: "c2", scopeKey: "byWorkspace:w2", table: "issues", id: "i2", kind: "insert",
      value: { workspaceId: "w2", title: "y" }, version: 1, serverTime: 1
    });
    const engine = new LocalFirstEngine({ manifest, store, clientId: "c", userId: "u", nameOf: String });

    const w1 = (await engine.query("issues:all", { workspaceId: "w1" })) as Array<{ title: string }>;
    expect(w1.map((row) => row.title)).toEqual(["x"]);
  });

  it("attaches one / many / manyToMany relations from local tables", async () => {
    const ws = byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "m" });
    const t = (table: string) => localTable({ table, idField: "localId", scope: ws, indexes: {} });
    const manifest = defineLocalFirstManifest({
      schemaVersion: 1,
      tables: { issues: t("issues"), projects: t("projects"), comments: t("comments"), labels: t("labels"), issue_labels: t("issue_labels") },
      queries: {},
      mutations: {}
    });
    const store = new MemoryLocalStore();
    const seed = (table: string, id: string, value: Record<string, unknown>) =>
      store.applyServerChange({
        changeId: `c-${id}`, scopeKey: "byWorkspace:w1", table, id, kind: "insert",
        value: { workspaceId: "w1", ...value }, version: 1, serverTime: 1
      });
    await seed("projects", "p1", { name: "Platform" });
    await seed("issues", "i1", { title: "Bug", projectId: "p1", tag_ids: ["l2", "l1", "ghost"] });
    await seed("issues", "i2", { title: "Feature", projectId: "p1" });
    await seed("comments", "cm1", { issueId: "i1", body: "hi" });
    await seed("comments", "cm2", { issueId: "i1", body: "again" });
    await seed("labels", "l1", { name: "urgent" });
    await seed("labels", "l2", { name: "later" });
    await seed("issue_labels", "il1", { issueId: "i1", labelId: "l1" });
    const engine = new LocalFirstEngine({ manifest, store, clientId: "c", userId: "u", nameOf: String });

    const rows = await engine.runLocalQuery(
      collection<{ title: string; projectId: string; tag_ids?: string[] }>("issues")
        .scope({ workspaceId: "w1" })
        .order("title")
        .related("project", one<{ name: string }>("projects", "projectId"))
        .related("comments", many<{ body: string }>("comments", "issueId"))
        .related("labels", manyToMany<{ name: string }>("labels", "issue_labels", "issueId", "labelId"))
        .related("tags", viaIds<{ name: string }>("labels", "tag_ids"))
    );

    expect(rows.map((r) => r.title)).toEqual(["Bug", "Feature"]); // ordered
    expect(rows[0].project?.name).toBe("Platform"); // one (typed)
    expect(rows[0].comments.map((c) => c.body).sort()).toEqual(["again", "hi"]); // many
    expect(rows[1].comments).toEqual([]); // i2 has none
    expect(rows[0].labels.map((l) => l.name)).toEqual(["urgent"]); // manyToMany
    expect(rows[1].labels).toEqual([]);
    // viaIds: the id-array on the base row, in array order; missing/absent are skipped.
    expect(rows[0].tags.map((t) => t.name)).toEqual(["later", "urgent"]); // ["l2","l1","ghost"] order
    expect(rows[1].tags).toEqual([]); // no tag_ids field at all
  });

  it("attaches a reusable relation map via withRelations() (define-once DX)", async () => {
    const ws = byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "m" });
    const t = (table: string) => localTable({ table, idField: "localId", scope: ws, indexes: {} });
    const manifest = defineLocalFirstManifest({
      schemaVersion: 1,
      tables: { issues: t("issues"), projects: t("projects"), comments: t("comments"), labels: t("labels"), issue_labels: t("issue_labels") },
      queries: {},
      mutations: {}
    });
    const store = new MemoryLocalStore();
    const seed = (table: string, id: string, value: Record<string, unknown>) =>
      store.applyServerChange({
        changeId: `c-${id}`, scopeKey: "byWorkspace:w1", table, id, kind: "insert",
        value: { workspaceId: "w1", ...value }, version: 1, serverTime: 1
      });
    await seed("projects", "p1", { name: "Platform" });
    await seed("issues", "i1", { title: "Bug", projectId: "p1" });
    await seed("comments", "cm1", { issueId: "i1", body: "hi" });
    await seed("labels", "l1", { name: "urgent" });
    await seed("issue_labels", "il1", { issueId: "i1", labelId: "l1" });
    const engine = new LocalFirstEngine({ manifest, store, clientId: "c", userId: "u", nameOf: String });

    // The relation map is declared once and could live next to the row type.
    const issueRelations = {
      project: one<{ name: string }>("projects", "projectId"),
      comments: many<{ body: string }>("comments", "issueId"),
      labels: manyToMany<{ name: string }>("labels", "issue_labels", "issueId", "labelId")
    };
    const rows = await engine.runLocalQuery(
      collection<{ title: string; projectId: string }>("issues").scope({ workspaceId: "w1" }).withRelations(issueRelations)
    );

    expect(rows[0].project?.name).toBe("Platform"); // one (typed via the map)
    expect(rows[0].comments.map((c) => c.body)).toEqual(["hi"]); // many
    expect(rows[0].labels.map((l) => l.name)).toEqual(["urgent"]); // manyToMany
  });

  it("derives the byUser pull scope for a plan", () => {
    const { engine } = createHarness({ transport: acceptAllTransport() });
    expect(engine.scopeForPlan(collection("todos"))).toEqual({
      kind: "byUser",
      key: "u:user_a",
      table: "todos"
    });
  });
});
