// Live multi-client online-sync check against a running Convex backend.
// Proves: push (client A) -> pull (client B) -> idempotent re-push, with a real
// server DB and the real sync.push / sync.pull functions.
//
// Usage: start the backend (`npx convex dev`) then:
//   node scripts/live-sync-check.mjs
import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const url = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
// Unique user per run so the byUser scope starts empty (deterministic, no reset).
const run = Date.now().toString(36);
const user = `user_${run}`;

function op(localId, text) {
  return {
    opId: `op_${localId}`,
    clientId: "A",
    schemaVersion: 1,
    functionName: "todos:create",
    table: "todos",
    kind: "insert",
    localId,
    value: { ownerId: "CLIENT_LIES", listId: "inbox", text, done: false, createdAt: 1, updatedAt: 1 }
  };
}

const a = new ConvexHttpClient(url);
const b = new ConvexHttpClient(url);

// 1. Client A pushes an insert.
const push1 = await a.mutation(api.sync.push, { clientId: "A", userId: user, schemaVersion: 1, mutations: [op("t1", "hello")] });
assert.equal(push1.accepted.length, 1, "op accepted");
assert.equal(push1.rejected.length, 0, "nothing rejected");
assert.equal(push1.changes.length, 1, "one change emitted");
assert.equal(push1.idMaps.length, 1, "id map returned for insert");
// Security: client-supplied ownerId is ignored; server forces the authed user.
assert.equal(push1.changes[0].data.ownerId, user, "server overrode client owner id");
console.log("✓ client A pushed insert; server owns the row");

// 2. Client B pulls from an empty cursor and sees A's change.
const pull1 = await b.query(api.sync.pull, {
  clientId: "B",
  userId: user,
  schemaVersion: 1,
  scopes: [{ kind: "byUser" }],
  cursors: {}
});
assert.equal(pull1.changes.length, 1, "client B pulled one change");
assert.equal(pull1.changes[0].localId, "t1", "B sees t1");
assert.equal(pull1.changes[0].data.text, "hello", "B sees the text");
const cursorKey = `u:${user}`;
assert.ok(pull1.cursors[cursorKey], "cursor advanced");
console.log("✓ client B pulled A's change (multi-client sync)");

// 3. Re-push the SAME op — must be idempotent (ledger dedupe), no second change.
const push2 = await a.mutation(api.sync.push, { clientId: "A", userId: user, schemaVersion: 1, mutations: [op("t1", "hello")] });
assert.equal(push2.accepted.length, 1, "duplicate op still acknowledged");

const pullAll = await b.query(api.sync.pull, {
  clientId: "B",
  userId: user,
  schemaVersion: 1,
  scopes: [{ kind: "byUser" }],
  cursors: {}
});
assert.equal(pullAll.changes.length, 1, "no duplicate change after re-push (idempotent)");
console.log("✓ re-push was idempotent (no duplicate row/change)");

// 4. Another user cannot see user_a's rows.
const c = new ConvexHttpClient(url);
const pullOther = await c.query(api.sync.pull, {
  clientId: "C",
  userId: `other_${run}`,
  schemaVersion: 1,
  scopes: [{ kind: "byUser" }],
  cursors: {}
});
assert.equal(pullOther.changes.length, 0, "another user cannot read user_a's scope");
console.log("✓ scope isolation: another user sees nothing of user_a");

console.log("\nALL LIVE SYNC CHECKS PASSED against", url);
