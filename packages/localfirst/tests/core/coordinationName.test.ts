import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexedDbStore, MemoryLocalStore } from "../../src/core";
import { coordinationName } from "../../src/core/internal";

// IndexedDbStore's constructor opens the DB, so a fake IndexedDB must exist.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

const idb = (databaseName: string, namespace: string) =>
  new IndexedDbStore({ databaseName, namespace });

describe("coordinationName", () => {
  it("separates DIFFERENT databases (e.g. prod vs staging on one origin)", () => {
    expect(coordinationName(idb("prod", "u1"), "u1")).not.toBe(
      coordinationName(idb("staging", "u1"), "u1"),
    );
  });

  it("separates DIFFERENT namespaces (e.g. two users) on the same database", () => {
    expect(coordinationName(idb("app", "u1"), "u1")).not.toBe(
      coordinationName(idb("app", "u2"), "u2"),
    );
  });

  it("shares ONE name across stores over the SAME database+namespace (same boundary)", () => {
    expect(coordinationName(idb("app", "u1"), "u1")).toBe(coordinationName(idb("app", "u1"), "u1"));
  });

  it("is collision-proof: a ':' in a segment cannot merge two distinct boundaries", () => {
    // Naive `${db}:${ns}` would give "a:b:c" for both — JSON encoding keeps them distinct.
    expect(coordinationName(idb("a:b", "c"), null)).not.toBe(
      coordinationName(idb("a", "b:c"), null),
    );
  });

  it("falls back to the user key for a non-IndexedDb (per-instance) store", () => {
    expect(coordinationName(new MemoryLocalStore(), "alice")).not.toBe(
      coordinationName(new MemoryLocalStore(), "bob"),
    );
    // Same user => same key regardless of the (unshared) memory store instance.
    expect(coordinationName(new MemoryLocalStore(), "alice")).toBe(
      coordinationName(new MemoryLocalStore(), "alice"),
    );
  });

  it("never collides an IndexedDb boundary with a user-fallback boundary", () => {
    expect(coordinationName(idb("idb", "x"), "x")).not.toBe(
      coordinationName(new MemoryLocalStore(), "x"),
    );
  });
});
