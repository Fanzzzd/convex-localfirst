import { describe, expect, it } from "vitest";
import { collectTables, createLocalFirst } from "../src/index";

// collectTables derives the createSyncFunctions({ tables }) config from the imported
// lf.table modules, so scope/idField/conflict have ONE source of truth (the lf.table
// definitions) instead of being restated — and silently drifting — in sync.ts.

const lf = createLocalFirst({
  schema: {},
  defaults: { idField: "id", conflict: "fieldLww" }
});

const wsScope = lf.byWorkspace({ workspaceIdField: "workspace_id", membershipTable: "ws_members" });

// Mimic `import * as issues from "./issues"` — a module namespace whose exports are
// the lf.table functions (each carrying non-enumerable __convexLocalFirst metadata).
const issues = {
  create: lf.table("issues", { scope: wsScope }).insert({ args: {}, value: () => ({}) }),
  update: lf.table("issues", { scope: wsScope }).patch({ args: {} }),
  remove: lf.table("issues", { scope: wsScope }).remove({ args: {} })
};

const labels = {
  list: lf.table("labels", { scope: wsScope }).query({ args: {}, index: "by", key: () => [] }),
  create: lf.table("labels", { scope: wsScope }).insert({ args: {}, value: () => ({}) })
};

// A byUser-scoped module (mirrors the todo example's `todos`) so the byUser path is
// covered, not just byWorkspace.
const todos = {
  create: lf.table("todos", { scope: lf.byUser("ownerId"), idField: "localId" }).insert({ args: {}, value: () => ({}) })
};

describe("collectTables", () => {
  it("derives one config per table from the modules' attached metadata", () => {
    const tables = collectTables({ issues, labels, todos });
    expect(Object.keys(tables).sort()).toEqual(["issues", "labels", "todos"]);
    expect(tables.issues).toEqual({
      scope: { kind: "byWorkspace", workspaceIdField: "workspace_id", membershipTable: "ws_members" },
      idField: "id",
      conflict: "fieldLww"
    });
    // byUser scope + a per-table idField override both flow through unchanged.
    expect(tables.todos).toEqual({
      scope: { kind: "byUser", field: "ownerId" },
      idField: "localId",
      conflict: "fieldLww"
    });
    // No setFields leaks into the server config — the server materializes set-deltas
    // by shape, not per-table config.
    expect("setFields" in tables.issues).toBe(false);
  });

  it("ignores non-local-first exports (plain functions, values)", () => {
    const mixed = {
      helper: () => 42,
      CONSTANT: "x",
      create: lf.table("states", { scope: wsScope }).insert({ args: {}, value: () => ({}) })
    };
    expect(Object.keys(collectTables({ mixed }))).toEqual(["states"]);
  });

  it("throws when no local-first tables are found (forgot to import/pass them)", () => {
    expect(() => collectTables({ nothing: { plain: () => 0 } })).toThrow(/no local-first tables/);
  });

  it("fails closed on conflicting config for the same table name", () => {
    const otherScope = lf.byWorkspace({ workspaceIdField: "workspace", membershipTable: "other_members" });
    const tampered = {
      a: lf.table("dupes", { scope: wsScope }).insert({ args: {}, value: () => ({}) }),
      b: lf.table("dupes", { scope: otherScope }).insert({ args: {}, value: () => ({}) })
    };
    expect(() => collectTables({ tampered })).toThrow(/conflicting config for table "dupes"/);
  });
});
