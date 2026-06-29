// Full client-stack E2E against a running Convex backend: two real
// LocalFirstEngine instances syncing through createConvexTransport + sync.push /
// sync.pull. Proves engine A's optimistic mutation reaches the server and engine
// B pulls it — the complete offline->online->second-client loop.
//
// Usage: start the backend (`npx convex dev`) then:
//   node scripts/live-engine-e2e.mjs
import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import {
  MemoryLocalStore,
  byUser,
  createConvexTransport,
  defineLocalFirstManifest,
  fieldLww,
  localMutation,
  localQuery,
  localTable
} from "@convex-localfirst/core";
// The engine is internal (I13); this diagnostic script drives it directly.
import { LocalFirstEngine } from "@convex-localfirst/core/internal";
import { api } from "../convex/_generated/api.js";

const url = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const user = `user_${Date.now().toString(36)}`;

function manifest() {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      todos: localTable({
        table: "todos",
        idField: "localId",
        scope: byUser("ownerId"),
        conflict: fieldLww(),
        indexes: { byList: ["ownerId", "listId", "createdAt"] }
      })
    },
    queries: {
      "todos:list": localQuery({
        kind: "query",
        name: "todos:list",
        table: "todos",
        initial: [],
        run: (rows, args) => rows.filter((r) => r.listId === args.listId)
      })
    },
    mutations: {
      "todos:create": localMutation({
        kind: "mutation",
        name: "todos:create",
        table: "todos",
        plan: (args, ctx) => ({
          kind: "insert",
          table: "todos",
          id: ctx.localId("todos"),
          value: {
            ownerId: ctx.userId,
            listId: args.listId,
            text: args.text,
            done: false,
            createdAt: ctx.now,
            updatedAt: ctx.now
          }
        })
      })
    }
  });
}

function engine(clientId) {
  let n = 0;
  return new LocalFirstEngine({
    manifest: manifest(),
    store: new MemoryLocalStore(),
    clientId,
    userId: user,
    nameOf: (r) => String(r),
    idFactory: () => `${clientId}_${++n}`,
    transport: createConvexTransport({ client: new ConvexHttpClient(url), push: api.sync.push, pull: api.sync.pull, clientId, userId: user })
  });
}

// Engine A: optimistic insert, then it pushes to the real server.
const a = engine("A");
const call = a.mutate("todos:create", { listId: "inbox", text: "from-A" });
await call.local;
const localRows = await a.query("todos:list", { listId: "inbox" });
assert.equal(localRows.length, 1, "A sees its todo optimistically before the server ack");
const serverResult = await call.server; // pushes to the live backend
assert.ok(serverResult, "server accepted A's mutation");
console.log("✓ engine A: optimistic insert, then pushed to the live server");

// Engine B: a different client, fresh store, pulls A's todo from the server.
const b = engine("B");
await b.syncOnce([{ kind: "byUser", key: `u:${user}` }]);
const pulledRows = await b.query("todos:list", { listId: "inbox" });
assert.equal(pulledRows.length, 1, "B pulled A's todo");
assert.equal(pulledRows[0].text, "from-A", "B sees the right text");
assert.equal(pulledRows[0].ownerId, user, "server-owned row");
console.log("✓ engine B: pulled A's todo from the server (second-client sync)");

console.log("\nFULL CLIENT-STACK E2E PASSED against", url);
