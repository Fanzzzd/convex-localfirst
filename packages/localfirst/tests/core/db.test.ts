import { describe, expect, it } from "vitest";
import { v } from "convex/values";
import {
  MemoryLocalStore,
  collectManifest,
  collection,
  createLocalDb,
  many,
  one,
  viaIds,
  type ServerChange,
} from "../../src/core";
import { LocalFirstEngine } from "../../src/core/internal";
import { createLocalFirst } from "../../src/server";

const lf = createLocalFirst();
const scope = lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "members" });

const statesTable = lf.table("states", {
  shape: { workspaceId: v.string(), name: v.string() },
  scope,
  indexes: { byWorkspace: ["workspaceId", "name"] },
});

const labelsTable = lf.table("labels", {
  shape: { workspaceId: v.string(), name: v.string() },
  scope,
  indexes: { byWorkspace: ["workspaceId", "name"] },
});

const commentsTable = lf.table("comments", {
  shape: { workspaceId: v.string(), issueId: v.string(), body: v.string() },
  scope,
  indexes: { byWorkspace: ["workspaceId", "issueId"] },
});

const issuesTable = lf.table("issues", {
  shape: {
    workspaceId: v.string(),
    title: v.string(),
    status: v.string(),
    stateId: v.string(),
    labelIds: v.array(v.string()),
  },
  scope,
  indexes: { byWorkspaceTitle: ["workspaceId", "title"] },
  relations: {
    state: lf.one("states", "stateId"),
    labels: lf.many("labels", { via: "labelIds" }),
    comments: lf.backref("comments", "issueId"),
  },
});

const modules = {
  issues: { issues: issuesTable },
  states: { states: statesTable },
  labels: { labels: labelsTable },
  comments: { comments: commentsTable },
};

function change(
  table: string,
  id: string,
  value: Record<string, unknown>,
  version = 1,
): ServerChange {
  return {
    changeId: `${table}-${id}-${version}`,
    scopeKey: `byWorkspace:${String(value.workspaceId)}`,
    table,
    id,
    kind: "insert",
    value,
    version,
    serverTime: version,
  };
}

async function setup() {
  const store = new MemoryLocalStore();
  const seed = [
    change("states", "s1", { workspaceId: "w1", name: "Open" }),
    change("labels", "l1", { workspaceId: "w1", name: "Bug" }),
    change("issues", "i1", {
      workspaceId: "w1",
      title: "Alpha",
      status: "open",
      stateId: "s1",
      labelIds: ["l1", "l2"],
    }),
    change("issues", "i2", {
      workspaceId: "w1",
      title: "Beta",
      status: "closed",
      stateId: "s1",
      labelIds: [],
    }),
    change("comments", "c1", { workspaceId: "w1", issueId: "i1", body: "First" }),
  ];
  for (const item of seed) await store.applyServerChange(item);
  const manifest = collectManifest(modules);
  const engine = new LocalFirstEngine({
    manifest,
    store,
    clientId: "c",
    userId: "u",
    nameOf: String,
  });
  return { db: createLocalDb(modules), engine, manifest, store };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("createLocalDb", () => {
  it("plumbs declared relations into the client manifest", async () => {
    const { manifest } = await setup();
    expect(manifest.tables.issues.relations).toEqual({
      state: { kind: "one", table: "states", foreignKey: "stateId" },
      labels: { kind: "many", table: "labels", via: "labelIds" },
      comments: { kind: "backref", table: "comments", foreignKey: "issueId" },
    });
  });

  it("returns the same rows and query plan as equivalent collection combinators", async () => {
    const { db, engine } = await setup();
    const typed = db.issues
      .scope({ workspaceId: "w1" })
      .filter({ status: "open" })
      .orderBy("title")
      .limit(1)
      .with("state", "labels", "comments");
    const manual = collection("issues")
      .scope({ workspaceId: "w1" })
      .where((row) => row.status === "open")
      .order("title")
      .limit(1)
      .related("state", one("states", "stateId"))
      .related("labels", viaIds("labels", "labelIds"))
      .related("comments", many("comments", "issueId"));

    expect(await engine.runLocalQuery(typed)).toEqual(await engine.runLocalQuery(manual));
    expect(engine.explainQuery(typed)).toMatchObject({
      strategy: "index",
      index: "byWorkspaceTitle",
    });
  });

  it("uses null for a missing declared one relation without changing the legacy combinator", async () => {
    const { db, engine, store } = await setup();
    await store.applyServerChange(
      change("issues", "i3", {
        workspaceId: "w1",
        title: "Missing state",
        status: "open",
        stateId: "missing",
        labelIds: [],
      }),
    );
    const declared = await engine.runLocalQuery(
      db.issues.scope({ workspaceId: "w1" }).where("title", "Missing state").with("state"),
    );
    const legacy = await engine.runLocalQuery(
      collection("issues")
        .scope({ workspaceId: "w1" })
        .where((row) => row.title === "Missing state")
        .related("state", one("states", "stateId")),
    );
    expect(declared[0]?.state).toBeNull();
    expect(legacy[0]?.state).toBeUndefined();
  });

  it("keeps .with() relations incremental as target rows arrive", async () => {
    const { db, engine, store } = await setup();
    const sub = engine.subscribeLiveQuery(
      db.issues.scope({ workspaceId: "w1" }).where("title", "Alpha").with("labels"),
      () => {},
    );
    await flush();
    expect(sub.current()?.[0]?.labels.map((label) => label.name)).toEqual(["Bug"]);

    await store.applyServerChange(change("labels", "l2", { workspaceId: "w1", name: "Urgent" }));
    engine.pokeLocalChange();
    await flush();

    expect(sub.current()?.[0]?.labels.map((label) => label.name)).toEqual(["Bug", "Urgent"]);
    sub.dispose();
  });
});
