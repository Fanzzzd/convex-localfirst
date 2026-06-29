import { describe, expect, it } from "vitest";
import { v } from "convex/values";
import { createLocalFirst } from "@convex-localfirst/server";
import {
  MemoryLocalStore,
  defineLocalFirstManifest,
  localTable,
  type LocalFirstManifest
} from "@convex-localfirst/core";
import {
  LocalFirstEngine,
  declarativeInsert,
  declarativePatch,
  declarativeQuery,
  declarativeRemove
} from "@convex-localfirst/core/internal";
import { emitManifestSource, introspectExports, type ManifestEntry } from "../src/codegen";

// A DSL module identical in shape to examples/todo-perfect-dx/convex/todos.ts.
function todosModule() {
  const lf = createLocalFirst({ schema: {} });
  const todos = lf.table("todos", {
    scope: lf.byUser("ownerId"),
    idField: "localId",
    conflict: lf.fieldLww(),
    indexes: { byList: ["ownerId", "listId", "createdAt"] }
  });
  return {
    list: todos.query({
      args: { listId: v.string() },
      index: "byList",
      key: ({ auth, args }) => [auth.userId, args.listId],
      order: "asc",
      initial: []
    }),
    create: todos.insert({
      args: { listId: v.string(), text: v.string() },
      value: ({ auth, args, now }) => ({
        ownerId: auth.userId,
        listId: String(args.listId),
        text: String(args.text),
        done: false,
        createdAt: now,
        updatedAt: now
      })
    }),
    toggle: todos.patch({
      args: { id: v.string(), done: v.boolean() },
      id: ({ args }) => String(args.id),
      patch: ({ args, now }) => ({ done: Boolean(args.done), updatedAt: now })
    }),
    remove: todos.remove({ args: { id: v.string() }, id: ({ args }) => String(args.id) })
  };
}

// Rebuild a runtime manifest from introspected entries (mirrors emitManifestSource).
function buildManifest(entries: ManifestEntry[]): LocalFirstManifest {
  const tables: Record<string, ReturnType<typeof localTable>> = {};
  const queries: Record<string, ReturnType<typeof declarativeQuery>> = {};
  const mutations: Record<string, ReturnType<typeof declarativeInsert>> = {};
  for (const e of entries) {
    tables[e.tableMeta.table] = localTable({
      table: e.tableMeta.table,
      idField: e.tableMeta.idField,
      scope: e.tableMeta.scope,
      conflict: e.tableMeta.conflict as "fieldLww",
      indexes: e.tableMeta.indexes
    });
    if (e.type === "query") queries[e.descriptor.name] = declarativeQuery(e.descriptor);
    else if (e.type === "insert") mutations[e.descriptor.name] = declarativeInsert(e.descriptor);
    else if (e.type === "patch") mutations[e.descriptor.name] = declarativePatch(e.descriptor);
    else mutations[e.descriptor.name] = declarativeRemove(e.descriptor);
  }
  return defineLocalFirstManifest({ schemaVersion: 1, tables, queries, mutations });
}

describe("codegen introspection", () => {
  const entries = introspectExports("todos", todosModule());

  it("derives a query descriptor (filters + sort) from the DSL spec", () => {
    const list = entries.find((e) => e.descriptor.name === "todos:list");
    expect(list).toMatchObject({
      type: "query",
      descriptor: { table: "todos", filters: ["listId"], orderBy: "createdAt", order: "asc" }
    });
  });

  it("introspects an insert's field sources (arg / auth / now / const)", () => {
    const create = entries.find((e) => e.descriptor.name === "todos:create");
    expect(create?.type).toBe("insert");
    expect((create as { descriptor: { fields: Record<string, unknown> } }).descriptor.fields).toEqual({
      ownerId: { from: "auth" },
      listId: { from: "arg", arg: "listId" },
      text: { from: "arg", arg: "text" },
      done: { from: "const", value: false },
      createdAt: { from: "now" },
      updatedAt: { from: "now" }
    });
  });

  it("introspects patch fields and the id arg", () => {
    const toggle = entries.find((e) => e.descriptor.name === "todos:toggle") as Extract<ManifestEntry, { type: "patch" }>;
    expect(toggle.descriptor.idArg).toBe("id");
    expect(toggle.descriptor.fields).toEqual({ done: { from: "arg", arg: "done" }, updatedAt: { from: "now" } });
  });

  it("introspects the remove id arg", () => {
    const remove = entries.find((e) => e.descriptor.name === "todos:remove") as Extract<ManifestEntry, { type: "remove" }>;
    expect(remove.descriptor.idArg).toBe("id");
  });

  it("the generated manifest actually works end-to-end through the engine", async () => {
    const manifest = buildManifest(entries);
    const store = new MemoryLocalStore();
    let n = 0;
    const engine = new LocalFirstEngine({
      manifest,
      store,
      clientId: "c",
      userId: "user_a",
      nameOf: (r) => String(r),
      idFactory: () => `todos_${++n}`,
      clock: () => 100,
      transport: {
        async push(req) {
          return { accepted: req.mutations.map((o) => ({ opId: o.opId })), rejected: [], idMaps: [], changes: [], serverTime: 1 };
        },
        async pull() {
          return { changes: [], cursors: {}, serverTime: 1 };
        }
      }
    });

    const call = engine.mutate("todos:create", { listId: "inbox", text: "hi" });
    await call.local;
    let rows = await engine.query<{ listId: string }, readonly Record<string, unknown>[]>("todos:list", { listId: "inbox" });
    expect(rows?.[0]).toMatchObject({ ownerId: "user_a", listId: "inbox", text: "hi", done: false });

    const id = String(rows?.[0]?._id);
    await engine.mutate("todos:toggle", { id, done: true }).local;
    rows = await engine.query("todos:list", { listId: "inbox" });
    expect(rows?.[0]?.done).toBe(true);

    await engine.mutate("todos:remove", { id }).local;
    rows = await engine.query("todos:list", { listId: "inbox" });
    expect(rows).toHaveLength(0);
  });

  it("emits a browser-safe manifest module without leaking sentinels", () => {
    const source = emitManifestSource(1, entries);
    expect(source).toContain('from "@convex-localfirst/core"');
    // I13: the manifest interpreters are imported from the INTERNAL subpath, not the
    // public root (GOAL §6 forbids manifest interpreters in the public surface).
    expect(source).toContain('from "@convex-localfirst/core/internal"');
    expect(source).toMatch(/import \{\s*declarativeInsert,[\s\S]*?\}\s*from "@convex-localfirst\/core\/internal"/);
    expect(source).toContain('"todos:list": declarativeQuery(');
    expect(source).toContain('"todos:create": declarativeInsert(');
    expect(source).toContain('"todos:toggle": declarativePatch(');
    expect(source).toContain('"todos:remove": declarativeRemove(');
    expect(source.includes(String.fromCharCode(0))).toBe(false);
  });
});

describe("codegen DSL defaults (omitted id/patch)", () => {
  // A module that leans on every default: idField/conflict from createLocalFirst defaults,
  // and patch/remove with NO id() (→ idField by convention) and the update with NO patch()
  // (→ forward all args except the id arg, 1:1). This is the minimal-boilerplate shape.
  function notesModule() {
    const lf = createLocalFirst({ schema: {}, defaults: { idField: "id", conflict: "fieldLww" } });
    const notes = lf.table("notes", { scope: lf.byUser("ownerId"), indexes: { byOwner: ["ownerId", "createdAt"] } });
    return {
      // The engine assigns the row id (stamped onto idField "id"); creates don't pass one.
      create: notes.insert({
        args: { ownerId: v.string(), title: v.string() },
        value: ({ args, now }) => ({ ownerId: String(args.ownerId), title: String(args.title), createdAt: now })
      }),
      // no id(), no patch()
      update: notes.patch({ args: { id: v.string(), title: v.optional(v.string()), pinned: v.optional(v.boolean()) } }),
      // no id()
      remove: notes.remove({ args: { id: v.string() } })
    };
  }
  const entries = introspectExports("notes", notesModule());

  it("defaults the patch id arg to the table idField and forwards every other arg 1:1", () => {
    const update = entries.find((e) => e.descriptor.name === "notes:update") as Extract<ManifestEntry, { type: "patch" }>;
    expect(update.descriptor.idArg).toBe("id"); // from createLocalFirst defaults.idField
    expect(update.descriptor.fields).toEqual({
      title: { from: "arg", arg: "title" },
      pinned: { from: "arg", arg: "pinned" }
    }); // "id" excluded; all other args forwarded
  });

  it("defaults the remove id arg to the table idField", () => {
    const remove = entries.find((e) => e.descriptor.name === "notes:remove") as Extract<ManifestEntry, { type: "remove" }>;
    expect(remove.descriptor.idArg).toBe("id");
  });

  it("FAILS CLOSED when id() is omitted and no arg is 'id' or named after idField (no-id descriptor)", () => {
    // idField defaults to "localId"; the remove arg is "widgetKey" → neither "id" nor "localId".
    const lf = createLocalFirst({ schema: {} });
    const widgets = lf.table("widgets", { scope: lf.byUser("ownerId"), indexes: { byOwner: ["ownerId"] } });
    const mod = { drop: widgets.remove({ args: { widgetKey: v.string() } }) };
    expect(() => introspectExports("widgets", mod)).toThrow(/neither an "id" arg nor one named "localId"/);
  });

  it("the defaulted patch/remove drive the engine end-to-end", async () => {
    const manifest = buildManifest(entries);
    const store = new MemoryLocalStore();
    const engine = new LocalFirstEngine({
      manifest,
      store,
      clientId: "c",
      userId: "user_a",
      nameOf: (r) => String(r),
      idFactory: () => "notes_1",
      clock: () => 100,
      transport: {
        async push(req) {
          return { accepted: req.mutations.map((o) => ({ opId: o.opId })), rejected: [], idMaps: [], changes: [], serverTime: 1 };
        },
        async pull() {
          return { changes: [], cursors: {}, serverTime: 1 };
        }
      }
    });

    const id = (await engine.mutate("notes:create", { ownerId: "user_a", title: "draft" }).local).id;
    // defaulted patch: forwards title (and would pinned if given), keyed by the default id arg
    await engine.mutate("notes:update", { id, title: "final" }).local;
    const row = await engine.getRow<Record<string, unknown>>("notes", id);
    expect(row?.title).toBe("final");
    // defaulted remove: keyed by the default id arg
    await engine.mutate("notes:remove", { id }).local;
    expect(await engine.getRow("notes", id)).toBeUndefined();
  });
});

describe("codegen setFields", () => {
  it("emits declared setFields into the table (and omits the key when absent)", () => {
    const lf = createLocalFirst({ schema: {} });
    const issues = lf.table("issues", {
      scope: lf.byUser("ownerId"),
      indexes: { byOwner: ["ownerId"] },
      setFields: ["label_ids", "assignee_ids"]
    });
    const plain = lf.table("notes", { scope: lf.byUser("ownerId"), indexes: { byOwner: ["ownerId"] } });
    const entries = [
      ...introspectExports("issues", { add: issues.insert({ args: { label_ids: v.array(v.string()) }, value: ({ args }) => ({ label_ids: args.label_ids }) }) }),
      ...introspectExports("notes", { add: plain.insert({ args: { text: v.string() }, value: ({ args }) => ({ text: String(args.text) }) }) })
    ];
    const issuesMeta = entries.find((e) => e.tableMeta.table === "issues");
    expect(issuesMeta?.tableMeta.setFields).toEqual(["label_ids", "assignee_ids"]);

    const src = emitManifestSource(1, entries);
    // Assert the FACT (emitted module carries setFields) without pinning JSON.stringify
    // formatting, so the emitter can be reformatted (spacing/key order/prettier) without churn.
    expect(src).toContain("setFields");
    // The plain "notes" table omits set fields entirely — assert structurally on the entry,
    // not by counting word occurrences in the emitted text.
    expect(entries.find((e) => e.tableMeta.table === "notes")?.tableMeta.setFields).toBeUndefined();
  });
});

describe("codegen counterFields", () => {
  it("emits declared counterFields into the table (and omits the key when absent)", () => {
    const lf = createLocalFirst({ schema: {} });
    const issues = lf.table("issues", {
      scope: lf.byUser("ownerId"),
      indexes: { byOwner: ["ownerId"] },
      counterFields: ["vote_count"]
    });
    const plain = lf.table("notes", { scope: lf.byUser("ownerId"), indexes: { byOwner: ["ownerId"] } });
    const entries = [
      ...introspectExports("issues", { add: issues.insert({ args: { vote_count: v.number() }, value: ({ args }) => ({ vote_count: args.vote_count }) }) }),
      ...introspectExports("notes", { add: plain.insert({ args: { text: v.string() }, value: ({ args }) => ({ text: String(args.text) }) }) })
    ];
    const issuesMeta = entries.find((e) => e.tableMeta.table === "issues");
    expect(issuesMeta?.tableMeta.counterFields).toEqual(["vote_count"]);

    const src = emitManifestSource(1, entries);
    // Format-independent: the emitted module carries counterFields; the plain "notes" table
    // omits the key (asserted structurally on the entry, not by counting words in the text).
    expect(src).toContain("counterFields");
    expect(entries.find((e) => e.tableMeta.table === "notes")?.tableMeta.counterFields).toBeUndefined();
  });
});

describe("codegen fail-closed", () => {
  it("THROWS on a spread value object instead of silently emitting a manifest missing fields", () => {
    const lf = createLocalFirst({ schema: {} });
    const notes = lf.table("notes", {
      scope: lf.byUser("ownerId"),
      idField: "localId",
      conflict: lf.fieldLww(),
      indexes: {}
    });
    const mod = {
      // `{ ...args }` can't be statically mapped to field sources — codegen must fail
      // closed, not drop the fields and push empty/wrong values.
      create: notes.insert({ args: { text: v.string() }, value: ({ args }) => ({ ...args }) })
    };
    expect(() => introspectExports("notes", mod)).toThrow(/spread|not a "key: expr"/i);
  });

  it("THROWS on shorthand property values (can't be statically mapped to a field source)", () => {
    const lf = createLocalFirst({ schema: {} });
    const notes = lf.table("notes", {
      scope: lf.byUser("ownerId"),
      idField: "localId",
      conflict: lf.fieldLww(),
      indexes: {}
    });
    const mod = {
      // `{ text }` shorthand has no `key: expr` — codegen must fail closed.
      create: notes.insert({ args: { text: v.string() }, value: ({ args: { text } }) => ({ text }) })
    };
    expect(() => introspectExports("notes", mod)).toThrow(/not a "key: expr"|shorthand/i);
  });

  it("THROWS on a computed property key (not a static field name)", () => {
    const lf = createLocalFirst({ schema: {} });
    const notes = lf.table("notes", {
      scope: lf.byUser("ownerId"),
      idField: "localId",
      conflict: lf.fieldLww(),
      indexes: {}
    });
    const mod = {
      // `{ [args.text]: 1 }` — a computed key can't be emitted as a static field.
      create: notes.insert({ args: { text: v.string() }, value: ({ args }) => ({ [args.text]: 1 }) })
    };
    expect(() => introspectExports("notes", mod)).toThrow(/computed/i);
  });
});

describe("codegen byWorkspace scope", () => {
  function issuesModule() {
    const lf = createLocalFirst({ schema: {} });
    const issues = lf.table("issues", {
      scope: lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "ws_members" }),
      idField: "localId",
      conflict: lf.fieldLww(),
      indexes: { byWorkspace: ["workspaceId", "createdAt"] }
    });
    return {
      list: issues.query({
        args: { workspaceId: v.string() },
        index: "byWorkspace",
        key: ({ args }) => [args.workspaceId],
        order: "asc",
        initial: []
      })
    };
  }

  const entries = introspectExports("issues", issuesModule());

  it("emits the workspace pull scope (value from the workspaceId arg)", () => {
    const list = entries.find((e) => e.descriptor.name === "issues:list");
    expect(list).toMatchObject({
      type: "query",
      descriptor: { table: "issues", scope: { kind: "byWorkspace", valueArg: "workspaceId" } }
    });
  });

  it("the declarative query derives a SyncScope keyed by the workspace value", () => {
    const list = entries.find((e) => e.descriptor.name === "issues:list") as Extract<ManifestEntry, { type: "query" }>;
    const def = declarativeQuery(list.descriptor);
    expect(def.scope?.({ workspaceId: "ws-demo" })).toEqual({
      kind: "byWorkspace",
      key: "byWorkspace:ws-demo",
      table: "issues"
    });
  });
});
