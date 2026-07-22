import { describe, expect, it } from "vitest";
import { collectTables, createLocalFirst } from "../../src/server/index";

// collectTables derives the createSyncFunctions({ tables }) config from the imported
// lf.table modules, so scope/idField/conflict have ONE source of truth (the lf.table
// definitions) instead of being restated — and silently drifting — in sync.ts.

const lf = createLocalFirst({
  defaults: { idField: "id" },
});

const wsScope = lf.byWorkspace({ workspaceIdField: "workspace_id", membershipTable: "ws_members" });

// Mimic `import * as issues from "./issues"` — a module namespace whose exports are
// the lf.table functions (each carrying non-enumerable __convexLocalFirst metadata).
const issues = {
  create: lf.table("issues", { shape: {}, scope: wsScope }).insert({ args: {}, value: () => ({}) }),
  update: lf.table("issues", { shape: {}, scope: wsScope }).patch({ args: {} }),
  remove: lf.table("issues", { shape: {}, scope: wsScope }).remove({ args: {} }),
};

const labels = {
  list: lf
    .table("labels", { shape: {}, scope: wsScope })
    .query({ args: {}, index: "by", key: () => [] }),
  create: lf.table("labels", { shape: {}, scope: wsScope }).insert({ args: {}, value: () => ({}) }),
};

// A byUser-scoped module (mirrors the todo example's `todos`) so the byUser path is
// covered, not just byWorkspace.
const todos = {
  create: lf
    .table("todos", { shape: {}, scope: lf.byUser("ownerId"), idField: "localId" })
    .insert({ args: {}, value: () => ({}) }),
};

describe("collectTables", () => {
  it("derives one config per table from the modules' attached metadata", () => {
    const tables = collectTables({ issues, labels, todos });
    expect(Object.keys(tables).sort()).toEqual(["issues", "labels", "todos"]);
    expect(tables.issues).toEqual({
      scope: {
        kind: "byWorkspace",
        workspaceIdField: "workspace_id",
        membershipTable: "ws_members",
      },
      idField: "id",
      syncedFields: ["id"], // empty shape → just the id field
      mutations: {
        "issues:create": { kind: "insert", fields: ["id"] },
        "issues:update": { kind: "patch", fields: [] },
        "issues:remove": { kind: "delete", fields: [] },
      },
    });
    // byUser scope + a per-table idField override both flow through unchanged.
    expect(tables.todos).toEqual({
      scope: { kind: "byUser", field: "ownerId" },
      idField: "localId",
      syncedFields: ["localId"],
      mutations: { "todos:create": { kind: "insert", fields: ["localId"] } },
    });
    // No setFields leaks into the server config — the server materializes set-deltas
    // by shape, not per-table config.
    expect("setFields" in tables.issues).toBe(false);
  });

  it("ignores non-local-first exports (plain functions, values)", () => {
    const mixed = {
      helper: () => 42,
      CONSTANT: "x",
      create: lf
        .table("states", { shape: {}, scope: wsScope })
        .insert({ args: {}, value: () => ({}) }),
    };
    expect(Object.keys(collectTables({ mixed }))).toEqual(["states"]);
  });

  it("throws when no local-first tables are found (forgot to import/pass them)", () => {
    expect(() => collectTables({ nothing: { plain: () => 0 } })).toThrow(/no local-first tables/);
  });

  it("carries the schemaVersion declared once in createLocalFirst to createSyncFunctions", () => {
    const lf2 = createLocalFirst({ schemaVersion: 3 });
    const mod = {
      create: lf2
        .table("things", { shape: {}, scope: lf2.byUser("ownerId") })
        .insert({ args: {}, value: () => ({}) }),
    };
    const tables = collectTables({ mod });
    expect(
      (tables as Record<PropertyKey, unknown>)[Symbol.for("convexLocalFirst.schemaVersion")],
    ).toBe(3);
    // Non-enumerable: iterating the config sees table names only.
    expect(Object.keys(tables)).toEqual(["things"]);
  });

  it("fails closed on conflicting config for the same table name", () => {
    const otherScope = lf.byWorkspace({
      workspaceIdField: "workspace",
      membershipTable: "other_members",
    });
    const tampered = {
      a: lf.table("dupes", { shape: {}, scope: wsScope }).insert({ args: {}, value: () => ({}) }),
      b: lf
        .table("dupes", { shape: {}, scope: otherScope })
        .insert({ args: {}, value: () => ({}) }),
    };
    expect(() => collectTables({ tampered })).toThrow(/conflicting config for table "dupes"/);
  });
});
