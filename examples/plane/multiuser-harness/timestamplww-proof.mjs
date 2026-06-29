// PROOF: timestamp-ordered LWW converges against the REAL deployed backend (cloud-free).
//
// The `issues` table declares conflict: "timestampLww". Two authenticated members of mu-demo
// concurrently edit the SAME issue's SCALAR fields offline, then reconnect in the WRONG order
// (the newer edit's push lands first, the older edit's push lands later). Arrival-order LWW
// would let whichever push arrives LAST win — here that's the STALE edit. Timestamp-ordered LWW
// keeps the NEWER edit regardless of arrival order, backed by the component's fieldClocks table.
//
// Also proves the best-of-both: on the SAME timestampLww table, a SET field (label_ids) still
// merges convergently (set/counter deltas are exempt from the timestamp rule). Every claim asserts.
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { randomUUID } from "node:crypto";
import { mintToken } from "./jwt.mjs";

const URL = process.env.VITE_CONVEX_URL || "http://127.0.0.1:3214";
const SCHEMA_VERSION = 1;
const pushRef = makeFunctionReference("sync:push");
const pullRef = makeFunctionReference("sync:pull");

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) failures++;
};

function clientFor(subject) {
  const c = new ConvexHttpClient(URL);
  c.setAuth(mintToken(subject));
  const envClientId = `client-${subject}-${randomUUID().slice(0, 8)}`;
  return {
    // Each mutation may carry its own `timestamp` (the op's logical clock) and `clientId`
    // (the LWW tiebreaker) — that's what timestampLww resolves on.
    async push(mutations) {
      return c.mutation(pushRef, {
        clientId: envClientId,
        userId: subject,
        schemaVersion: SCHEMA_VERSION,
        mutations: mutations.map((m) => ({
          opId: m.opId ?? randomUUID(),
          clientId: m.clientId ?? envClientId,
          schemaVersion: SCHEMA_VERSION,
          functionName: m.functionName ?? `${m.table}:${m.kind}`,
          table: m.table,
          kind: m.kind,
          localId: m.localId,
          value: m.value,
          patch: m.patch,
          timestamp: m.timestamp
        }))
      });
    },
    async pull(scopes, cursors = {}) {
      let merged = { ...cursors };
      const all = [];
      let last = null;
      for (let i = 0; i < 50; i++) {
        const r = await c.query(pullRef, { clientId: envClientId, userId: subject, schemaVersion: SCHEMA_VERSION, scopes, cursors: merged });
        all.push(...r.changes);
        merged = { ...merged, ...r.cursors };
        last = r;
        if (!Object.values(r.hasMore ?? {}).some(Boolean)) break;
      }
      return { ...last, changes: all, cursors: merged };
    }
  };
}

const wsScope = (value) => [{ kind: "byWorkspace", value }];
const ts = Date.now();
const uid = randomUUID().slice(0, 8);

// Fold a scalar field from an issue's change log: insert seeds it, each patch that touches it
// overwrites — so the last logged value is the converged server state (pull is delta-free).
function fieldOf(changes, localId, field) {
  let val;
  for (const c of changes) {
    if (c.localId !== localId || c.table !== "issues") continue;
    if (c.kind === "insert") val = c.data?.[field];
    else if (c.kind === "patch" && c.patch && field in c.patch) val = c.patch[field];
  }
  return val;
}

const alice = clientFor("alice");
const bob = clientFor("bob");

console.log("\n=== timestampLww: a NEWER edit wins even when it arrives FIRST (offline-first fix) ===");
const projLocalId = `tl-proj-${uid}`;
const issueLocalId = `tl-issue-${uid}`;
const seed = await alice.push([
  { table: "projects", kind: "insert", localId: projLocalId, value: { workspace: "mu-demo", name: `TL ${uid}`, identifier: "TL", created_at: ts, updated_at: ts } },
  {
    table: "issues", kind: "insert", localId: issueLocalId,
    value: {
      workspace_id: "mu-demo", project_id: projLocalId, sequence_id: Math.floor(Math.random() * 100000),
      name: "v0", sort_order: 1000, priority: "none", label_ids: ["base"], assignee_ids: [],
      created_at: ts, updated_at: ts, created_by: "server-sets-scope"
    }
  }
]);
assert(seed.rejected.length === 0, "alice seeded project+issue (name:'v0', priority:'none')");

// alice's edit name->"A" was made LATER (ts+10) but its push reaches the server FIRST.
const aNew = await alice.push([
  { table: "issues", kind: "patch", localId: issueLocalId, patch: { name: "A" }, timestamp: ts + 10 }
]);
assert(aNew.rejected.length === 0, "alice's newer name='A' (ts+10) accepted, arrives first");
assert(aNew.changes[0]?.patch?.name === "A", "server applied 'A' (it was the newest so far)");

// bob's edit name->"B" was made EARLIER (ts+5, e.g. offline) but its push reaches the server LATER.
const bStale = await bob.push([
  { table: "issues", kind: "patch", localId: issueLocalId, patch: { name: "B" }, timestamp: ts + 5 }
]);
assert(bStale.rejected.length === 0, "bob's op is ACCEPTED (not an error) — but its stale field-write is dropped");
assert(bStale.changes[0]?.patch?.name === undefined, "bob's older name='B' did NOT win (dropped, arrival-order would have clobbered)");

const afterName = await bob.pull(wsScope("mu-demo"));
assert(fieldOf(afterName.changes, issueLocalId, "name") === "A", "converged name is 'A' — the NEWER edit survived despite arriving earlier");

console.log("\n=== timestampLww: concurrent edits to DIFFERENT scalar fields both apply ===");
await alice.push([{ table: "issues", kind: "patch", localId: issueLocalId, patch: { priority: "urgent" }, timestamp: ts + 20 }]);
await bob.push([{ table: "issues", kind: "patch", localId: issueLocalId, patch: { sort_order: 2000 }, timestamp: ts + 18 }]);
const afterDiff = await alice.pull(wsScope("mu-demo"));
assert(fieldOf(afterDiff.changes, issueLocalId, "priority") === "urgent", "priority='urgent' applied");
assert(fieldOf(afterDiff.changes, issueLocalId, "sort_order") === 2000, "sort_order=2000 applied (different field, lower ts, no collision)");
assert(fieldOf(afterDiff.changes, issueLocalId, "name") === "A", "name still 'A' (untouched by these patches)");

console.log("\n=== timestampLww: equal-timestamp tie broken deterministically by clientId (order-independent) ===");
// Same ts; op.clientId is the tiebreaker. "z-hi" > "a-lo" lexically → "z-hi" wins regardless of order.
await alice.push([{ table: "issues", kind: "patch", localId: issueLocalId, clientId: "a-lo", patch: { name: "from-lo" }, timestamp: ts + 30 }]);
await bob.push([{ table: "issues", kind: "patch", localId: issueLocalId, clientId: "z-hi", patch: { name: "from-hi" }, timestamp: ts + 30 }]);
let tie = await alice.pull(wsScope("mu-demo"));
assert(fieldOf(tie.changes, issueLocalId, "name") === "from-hi", "higher clientId 'z-hi' won the equal-ts tie");
// Now the reverse order: low arrives after high, same ts → still loses (deterministic, not arrival-based).
await alice.push([{ table: "issues", kind: "patch", localId: issueLocalId, clientId: "a-lo", patch: { name: "from-lo-2" }, timestamp: ts + 30 }]);
tie = await alice.pull(wsScope("mu-demo"));
assert(fieldOf(tie.changes, issueLocalId, "name") === "from-hi", "lower clientId still loses at equal ts even arriving later (order-independent)");

console.log("\n=== best-of-both: a SET field still merges on the SAME timestampLww table (deltas exempt) ===");
const aLbl = await alice.push([{ table: "issues", kind: "patch", localId: issueLocalId, patch: { label_ids: { __lfSet: { add: ["label-A"], remove: [] } } }, timestamp: ts + 40 }]);
const bLbl = await bob.push([{ table: "issues", kind: "patch", localId: issueLocalId, patch: { label_ids: { __lfSet: { add: ["label-B"], remove: [] } } }, timestamp: ts + 1 }]);
assert(aLbl.rejected.length === 0 && bLbl.rejected.length === 0, "both label add-deltas accepted");
const afterLbl = await alice.pull(wsScope("mu-demo"));
const labels = fieldOf(afterLbl.changes, issueLocalId, "label_ids");
assert(Array.isArray(labels) && labels.includes("label-A") && labels.includes("label-B"),
  `BOTH concurrent label adds survived despite different ts — set field merged, not timestamp-clobbered (${JSON.stringify(labels)})`);

console.log(failures === 0 ? "\n✅ timestampLww converges on the real backend (newer-wins + tiebreak + set-field exemption)" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
