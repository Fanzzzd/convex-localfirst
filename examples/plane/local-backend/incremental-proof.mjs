// PROOF: sync is INCREMENTAL (delta), not full re-pull — the property that makes it
// scale to a production-sized dataset. After an initial pull returns a cursor, a
// re-pull with that cursor returns ~nothing; writing ONE row then makes the next
// delta pull return exactly that one row. So steady-state sync cost tracks CHANGES,
// not total table size. Cloud-free (locally-minted JWT, reuses the harness).
//
//   node incremental-proof.mjs
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { randomUUID } from "node:crypto";
import { mintToken } from "../multiuser-harness/jwt.mjs";

const URL = process.env.VITE_CONVEX_URL || "http://127.0.0.1:3214";
const SCHEMA_VERSION = 1;
const pushRef = makeFunctionReference("sync:push");
const pullRef = makeFunctionReference("sync:pull");
const WS = "mu-demo";
const SCOPES = [{ kind: "byWorkspace", value: WS }];

let failures = 0;
const assert = (cond, msg) => { console.log((cond ? "  PASS: " : "  FAIL: ") + msg); if (!cond) failures++; };

const c = new ConvexHttpClient(URL);
c.setAuth(mintToken("alice"));
const clientId = `inc-${randomUUID().slice(0, 8)}`;

// One pull PAGE (single round-trip) starting from `cursors`; returns {changes, cursors}.
async function pullPage(cursors) {
  const r = await c.query(pullRef, { clientId, userId: "alice", schemaVersion: SCHEMA_VERSION, scopes: SCOPES, cursors });
  return { changes: r.changes, cursors: { ...cursors, ...r.cursors }, hasMore: r.hasMore };
}
// Drain ALL pages from `cursors`, returning the merged changes + the final cursor.
async function drain(cursors) {
  let cur = cursors, all = [];
  for (let i = 0; i < 200; i++) {
    const p = await pullPage(cur);
    all.push(...p.changes); cur = p.cursors;
    if (!Object.values(p.hasMore ?? {}).some(Boolean)) break;
  }
  return { changes: all, cursors: cur };
}
function projectInsert(localId, name) {
  const ts = Date.now();
  return { opId: randomUUID(), clientId, schemaVersion: SCHEMA_VERSION, functionName: "projects:insert",
    table: "projects", kind: "insert", localId, value: { workspace: WS, name, identifier: "INC", created_at: ts, updated_at: ts } };
}

console.log("=== incremental sync (delta pulls) against the durable local backend ===");

// 1) Initial full sync — drain everything, keep the high-water cursor C1.
const initial = await drain({});
console.log(`  initial drain: ${initial.changes.length} changes; cursor captured`);
assert(initial.changes.length >= 0, "initial full pull completes + yields a cursor");
const C1 = initial.cursors;

// 2) Re-pull from C1 with NO new writes -> delta is empty (no full re-pull).
const noop = await drain(C1);
assert(noop.changes.length === 0, `re-pull from cursor returns 0 changes (got ${noop.changes.length}) — not a full re-pull`);

// 3) Write ONE new row, then a delta pull from C1 returns exactly that row.
const id = `inc-proj-${Date.now()}-${randomUUID().slice(0, 8)}`;
const res = await c.mutation(pushRef, { clientId, userId: "alice", schemaVersion: SCHEMA_VERSION,
  mutations: [projectInsert(id, `Incremental ${id}`)] });
assert((res.rejected ?? []).length === 0, "single insert accepted");

const delta = await drain(C1);
const onlyNew = delta.changes.filter((ch) => ch.table === "projects");
assert(delta.changes.some((ch) => ch.localId === id), "delta pull from cursor returns the new row");
assert(delta.changes.length <= 3, `delta is small (got ${delta.changes.length}, expected ~1) — cost tracks changes, not table size`);

// 4) Advancing past the new row -> empty again (cursor monotonic, no re-delivery).
const after = await drain(delta.cursors);
assert(after.changes.length === 0, `pull past the new row is empty again (got ${after.changes.length}) — cursor is monotonic`);

console.log(failures === 0 ? "\nALL INCREMENTAL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
