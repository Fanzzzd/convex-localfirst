// PROOF: set-field merge converges against the REAL deployed backend (cloud-free).
//
// Two authenticated users (alice, bob, both members of mu-demo) concurrently add a
// DIFFERENT label to the SAME issue's label_ids — each pushing an add/remove DELTA
// ({__lfSet:{add,remove}}) vs the shared base. The deployed serverSync materializes each
// delta against the CURRENT row, so BOTH adds survive. With the old whole-array LWW one
// would have been clobbered. Then alice removes a label via a delta. Every claim asserts.
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
  const clientId = `client-${subject}-${randomUUID().slice(0, 8)}`;
  return {
    async push(mutations) {
      return c.mutation(pushRef, {
        clientId,
        userId: subject,
        schemaVersion: SCHEMA_VERSION,
        mutations: mutations.map((m) => ({
          opId: m.opId ?? randomUUID(),
          clientId,
          schemaVersion: SCHEMA_VERSION,
          functionName:
            m.functionName ??
            `${m.table}:${m.kind === "insert" ? "create" : m.kind === "patch" ? "update" : "remove"}`,
          table: m.table,
          kind: m.kind,
          localId: m.localId,
          value: m.value,
          patch: m.patch,
        })),
      });
    },
    async pull(scopes, cursors = {}) {
      let merged = { ...cursors };
      const all = [];
      let last = null;
      for (let i = 0; i < 50; i++) {
        const r = await c.query(pullRef, {
          clientId,
          userId: subject,
          schemaVersion: SCHEMA_VERSION,
          scopes,
          cursors: merged,
        });
        all.push(...r.changes);
        Object.assign(merged, r.cursors);
        last = r;
        if (!Object.values(r.hasMore ?? {}).some(Boolean)) break;
      }
      return { ...last, changes: all, cursors: merged };
    },
  };
}

const wsScope = (value) => [{ kind: "byWorkspace", value }];
const ts = Date.now();
const uid = randomUUID().slice(0, 8);

// Fold an issue's label_ids from its change log: the insert seeds it, each patch logs the
// MATERIALIZED full array (server stays delta-free on pull), so the last one wins.
function labelsOf(changes, localId) {
  let labels;
  for (const c of changes) {
    if (c.localId !== localId || c.table !== "issues") continue;
    if (c.kind === "insert") labels = c.data?.label_ids;
    else if (c.kind === "patch" && c.patch && "label_ids" in c.patch) labels = c.patch.label_ids;
  }
  return labels;
}

const alice = clientFor("alice");
const bob = clientFor("bob");

console.log("\n=== set-field merge: concurrent adds converge (real backend) ===");
const projLocalId = `sm-proj-${uid}`;
const issueLocalId = `sm-issue-${uid}`;
const seed = await alice.push([
  {
    table: "projects",
    kind: "insert",
    localId: projLocalId,
    value: {
      workspace: "mu-demo",
      name: `SM ${uid}`,
      identifier: "SM",
      created_at: ts,
      updated_at: ts,
    },
  },
  {
    table: "issues",
    kind: "insert",
    localId: issueLocalId,
    value: {
      workspace_id: "mu-demo",
      project_id: projLocalId,
      name: `SM issue ${uid}`,
      sort_order: 1000,
      priority: "none",
      label_ids: ["base"],
      assignee_ids: [],
      created_at: ts,
      updated_at: ts,
      created_by: "server-sets-scope",
    },
  },
]);
assert(seed.rejected.length === 0, "alice seeded project+issue (label_ids:['base'])");

// CONCURRENT: alice adds "label-A", bob adds "label-B" — each a DELTA vs base ["base"].
const aAdd = await alice.push([
  {
    table: "issues",
    kind: "patch",
    localId: issueLocalId,
    patch: { label_ids: { __lfSet: { add: ["label-A"], remove: [] } } },
  },
]);
const bAdd = await bob.push([
  {
    table: "issues",
    kind: "patch",
    localId: issueLocalId,
    patch: { label_ids: { __lfSet: { add: ["label-B"], remove: [] } } },
  },
]);
assert(aAdd.rejected.length === 0, "alice's label-A add-delta accepted");
assert(bAdd.rejected.length === 0, "bob's label-B add-delta accepted (member, shared write)");

// Each accepted patch logs a MATERIALIZED array (pull stays delta-free).
assert(
  Array.isArray(aAdd.changes[0]?.patch?.label_ids),
  "server logged a materialized array (not a delta) for alice's push",
);

// Fresh pull → BOTH labels survive (the data-loss fix, proven end-to-end).
const after = await bob.pull(wsScope("mu-demo"));
const labels = labelsOf(after.changes, issueLocalId);
assert(Array.isArray(labels), `issue label_ids present after merge (${JSON.stringify(labels)})`);
assert(labels?.includes("base"), "base label retained");
assert(labels?.includes("label-A"), "alice's concurrent add SURVIVED");
assert(labels?.includes("label-B"), "bob's concurrent add SURVIVED (no clobber)");

console.log("\n=== set-field merge: remove via delta ===");
const rm = await alice.push([
  {
    table: "issues",
    kind: "patch",
    localId: issueLocalId,
    patch: { label_ids: { __lfSet: { add: [], remove: ["base"] } } },
  },
]);
assert(rm.rejected.length === 0, "alice's remove-delta accepted");
const afterRm = await alice.pull(wsScope("mu-demo"));
const labels2 = labelsOf(afterRm.changes, issueLocalId);
assert(!labels2?.includes("base"), "removed 'base' is gone");
assert(
  labels2?.includes("label-A") && labels2?.includes("label-B"),
  "concurrent adds still present after the remove",
);

console.log(
  failures === 0 ? "\n✅ set-merge converges on the real backend" : `\n❌ ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
