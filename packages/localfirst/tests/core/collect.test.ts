import { describe, expect, it } from "vitest";
import { collectManifest } from "../../src/core/collect";
import type { LocalMutationContext } from "../../src/core/manifest";

// Fake lf.table exports: the same metadata shape the server DSL attaches,
// carrying REAL closures — exactly what a client gets from `import * as todos`.
function lfFn(meta: Record<string, unknown>): Record<string, unknown> {
  const fn = { isConvexFunction: true };
  Object.defineProperty(fn, "__convexLocalFirst", { value: meta, enumerable: false });
  return fn;
}

const tableMeta = {
  tableName: "todos",
  idField: "localId",
  scope: { kind: "byUser", field: "ownerId" },
  indexes: { byList: ["ownerId", "listId", "createdAt"] }
};

const todosModule = {
  list: lfFn({
    kind: "query",
    ...tableMeta,
    spec: {
      args: { listId: {} },
      index: "byList",
      key: ({ auth, args }: { auth: { userId: string | null }; args: { listId: string } }) => [auth.userId, args.listId],
      order: "asc",
      initial: []
    }
  }),
  create: lfFn({
    kind: "insert",
    ...tableMeta,
    spec: {
      args: { listId: {}, text: {} },
      value: ({
        auth,
        args,
        now,
        localId
      }: {
        auth: { userId: string | null };
        args: { listId: string; text: string };
        now: number;
        localId: string;
      }) => ({
        ownerId: auth.userId,
        listId: args.listId,
        // Real computation — impossible for a static field-source parser, trivial at runtime.
        text: args.text.trim().toUpperCase(),
        ref: localId,
        done: false,
        createdAt: now
      })
    }
  }),
  toggle: lfFn({
    kind: "patch",
    ...tableMeta,
    spec: {
      args: { id: {}, done: {} },
      patch: ({ args, now }: { args: { done: boolean }; now: number }) => ({ done: args.done, updatedAt: now })
    }
  }),
  update: lfFn({
    kind: "patch",
    ...tableMeta,
    // No patch(): forwards every arg except the id; undefined args are skipped.
    spec: { args: { id: {}, text: {}, done: {} } }
  }),
  remove: lfFn({
    kind: "remove",
    ...tableMeta,
    spec: { args: { id: {} } }
  })
};

const mutationCtx: LocalMutationContext = {
  now: 1000,
  clientId: "c1",
  userId: "u1",
  localId: (table) => `${table}-local-1`
};

describe("collectManifest", () => {
  it("derives schemaVersion declared once in createLocalFirst (metadata), option overrides", () => {
    const versioned = {
      remove: lfFn({ kind: "remove", ...tableMeta, schemaVersion: 4, spec: { args: { id: {} } } })
    };
    expect(collectManifest({ todos: versioned }).schemaVersion).toBe(4);
    expect(collectManifest({ todos: versioned }, { schemaVersion: 9 }).schemaVersion).toBe(9);
    const conflicting = {
      a: lfFn({ kind: "remove", ...tableMeta, schemaVersion: 4, spec: { args: { id: {} } } }),
      b: lfFn({ kind: "remove", ...tableMeta, schemaVersion: 5, spec: { args: { id: {} } } })
    };
    expect(() => collectManifest({ t: conflicting })).toThrow(/conflicting schemaVersions/);
  });

  it("builds tables/queries/mutations named <moduleKey>:<exportName>", () => {
    const manifest = collectManifest({ todos: todosModule });
    expect(manifest.schemaVersion).toBe(1);
    expect(Object.keys(manifest.tables)).toEqual(["todos"]);
    expect(manifest.tables.todos.scope).toEqual({ kind: "byUser", field: "ownerId" });
    expect(Object.keys(manifest.queries)).toEqual(["todos:list"]);
    expect(Object.keys(manifest.mutations).sort()).toEqual(["todos:create", "todos:remove", "todos:toggle", "todos:update"]);
    expect(collectManifest({ todos: todosModule }, { schemaVersion: 3 }).schemaVersion).toBe(3);
  });

  it("query: runs the real key closure over the index prefix and sorts by the rest", () => {
    const manifest = collectManifest({ todos: todosModule });
    const rows = [
      { _id: "a", ownerId: "u1", listId: "inbox", createdAt: 2, text: "b" },
      { _id: "b", ownerId: "u1", listId: "inbox", createdAt: 1, text: "a" },
      { _id: "c", ownerId: "u1", listId: "other", createdAt: 0, text: "x" },
      { _id: "d", ownerId: "u2", listId: "inbox", createdAt: 0, text: "not mine" }
    ];
    const result = manifest.queries["todos:list"].run(rows, { listId: "inbox" }, { now: 0, userId: "u1" });
    expect(result.map((row: { _id: string }) => row._id)).toEqual(["b", "a"]);
  });

  it("query: anonymous mode skips the owner column instead of matching nothing", () => {
    const manifest = collectManifest({ todos: todosModule });
    const rows = [{ _id: "a", ownerId: "whoever", listId: "inbox", createdAt: 1 }];
    const result = manifest.queries["todos:list"].run(rows, { listId: "inbox" }, { now: 0, userId: null });
    expect(result).toHaveLength(1);
  });

  it("query: a workspace table carries its pull scope from the scope-field arg", () => {
    const issues = {
      list: lfFn({
        kind: "query",
        tableName: "issues",
        idField: "localId",
        scope: { kind: "byWorkspace", workspaceIdField: "workspaceId", membershipTable: "members" },
        indexes: { byWorkspace: ["workspaceId", "createdAt"] },
        spec: {
          args: { workspaceId: {} },
          index: "byWorkspace",
          key: ({ args }: { args: { workspaceId: string } }) => [args.workspaceId]
        }
      })
    };
    const manifest = collectManifest({ issues });
    expect(manifest.queries["issues:list"].scope?.({ workspaceId: "w1" })).toEqual({
      kind: "byWorkspace",
      key: "byWorkspace:w1",
      table: "issues"
    });
  });

  it("insert: runs the real value closure (computed fields, localId, auth, now)", () => {
    const manifest = collectManifest({ todos: todosModule });
    const plan = manifest.mutations["todos:create"].plan({ listId: "inbox", text: "  ship it " }, mutationCtx);
    expect(plan).toEqual({
      kind: "insert",
      table: "todos",
      id: "todos-local-1",
      value: {
        ownerId: "u1",
        listId: "inbox",
        text: "SHIP IT",
        ref: "todos-local-1",
        done: false,
        createdAt: 1000
      }
    });
  });

  it("patch: explicit patch() runs; default forwards args minus id, skipping undefined", () => {
    const manifest = collectManifest({ todos: todosModule });
    expect(manifest.mutations["todos:toggle"].plan({ id: "r1", done: true }, mutationCtx)).toEqual({
      kind: "patch",
      table: "todos",
      id: "r1",
      patch: { done: true, updatedAt: 1000 }
    });
    expect(manifest.mutations["todos:update"].plan({ id: "r1", text: "hi", done: undefined }, mutationCtx)).toEqual({
      kind: "patch",
      table: "todos",
      id: "r1",
      patch: { text: "hi" }
    });
  });

  it("remove: defaults the id to the 'id' arg; custom id() closures run", () => {
    const manifest = collectManifest({ todos: todosModule });
    expect(manifest.mutations["todos:remove"].plan({ id: "r9" }, mutationCtx)).toEqual({
      kind: "delete",
      table: "todos",
      id: "r9"
    });

    const custom = {
      prune: lfFn({
        kind: "remove",
        ...tableMeta,
        spec: { args: { entryId: {} }, id: ({ args }: { args: { entryId: string } }) => args.entryId }
      })
    };
    expect(collectManifest({ docs: custom }).mutations["docs:prune"].plan({ entryId: "e1" }, mutationCtx)).toEqual({
      kind: "delete",
      table: "todos",
      id: "e1"
    });
  });

  it("fails closed: unknown index, missing id arg, ctx access, conflicting table config, empty modules", () => {
    const badQuery = {
      list: lfFn({ kind: "query", ...tableMeta, spec: { args: {}, index: "nope", key: () => [] } })
    };
    expect(() => collectManifest({ t: badQuery })).toThrow(/does not declare it/);

    const badPatch = { p: lfFn({ kind: "patch", ...tableMeta, spec: { args: { text: {} } } }) };
    expect(() => collectManifest({ t: badPatch })).toThrow(/omits id\(\)/);

    const ctxUser = {
      create: lfFn({
        kind: "insert",
        ...tableMeta,
        spec: { args: {}, value: ({ ctx }: { ctx: { db: unknown } }) => ({ x: ctx.db }) }
      })
    };
    expect(() => collectManifest({ t: ctxUser }).mutations["t:create"].plan({}, mutationCtx)).toThrow(
      /ctx\.db is not available/
    );

    const divergent = {
      a: lfFn({ kind: "remove", ...tableMeta, spec: { args: { id: {} } } }),
      b: lfFn({ kind: "remove", ...tableMeta, idField: "otherId", spec: { args: { id: {} } } })
    };
    expect(() => collectManifest({ t: divergent })).toThrow(/conflicting table config/);

    expect(() => collectManifest({})).toThrow(/no local-first functions/);
  });
});
