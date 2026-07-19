// PROOF: real, production-grade MULTI-USER end-to-end, cloud-free.
//
// Two ConvexHttpClients, each setAuth'd with its OWN locally-minted JWT (alice,
// bob), drive the package's sync:push / sync:pull endpoints directly (the exact
// wire shape convex-localfirst/core's transport uses). Identity is resolved by
// the SERVER from the JWT (ctx.auth.getUserIdentity().subject), so each client
// genuinely acts as a different authenticated user. Every claim is a hard assert.
//
//   3a  Shared collaboration: alice creates rows in 'demo'; bob (member) pulls
//       and SEES them, edits one, and alice sees the edit.
//   3b  Scope isolation (I7): bob is DENIED reads + writes to 'alice-only';
//       alice is allowed.
//   3c  Server-authoritative identity: a client authed as bob that puts
//       userId:"alice" in the envelope still acts as bob (auth subject wins).
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { randomUUID } from "node:crypto";
import { mintToken } from "./jwt.mjs";

const URL = process.env.VITE_CONVEX_URL || "http://127.0.0.1:3214";
const SCHEMA_VERSION = 1;
const pushRef = makeFunctionReference("sync:push");
const pullRef = makeFunctionReference("sync:pull");

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  PASS:", msg);
  } else {
    console.error("  FAIL:", msg);
    failures++;
  }
}

// A client for a given JWT subject. `envelopeUserId` lets us forge the client
// envelope userId (for 3c); it defaults to the real subject.
function clientFor(subject, { envelopeUserId } = {}) {
  const c = new ConvexHttpClient(URL);
  c.setAuth(mintToken(subject));
  const clientId = `client-${subject}-${randomUUID().slice(0, 8)}`;
  const envUser = envelopeUserId ?? subject;
  return {
    subject,
    clientId,
    async push(mutations) {
      return c.mutation(pushRef, {
        clientId,
        userId: envUser, // forged when envelopeUserId is set — server must ignore it
        schemaVersion: SCHEMA_VERSION,
        mutations: mutations.map((m) => ({
          opId: m.opId ?? randomUUID(),
          clientId,
          schemaVersion: SCHEMA_VERSION,
          functionName: m.functionName ?? `${m.table}:${m.kind}`,
          table: m.table,
          kind: m.kind,
          localId: m.localId,
          value: m.value,
          patch: m.patch
        }))
      });
    },
    // Drains ALL pages (follows `hasMore` via the returned cursors) exactly like
    // the engine does, so accumulated change-log data never hides newer rows.
    async pull(scopes, cursors = {}) {
      let merged = { ...cursors };
      const all = [];
      let last = null;
      for (let i = 0; i < 50; i++) {
        const r = await c.query(pullRef, {
          clientId,
          userId: envUser,
          schemaVersion: SCHEMA_VERSION,
          scopes,
          cursors: merged
        });
        all.push(...r.changes);
        merged = { ...merged, ...r.cursors };
        last = r;
        if (!Object.values(r.hasMore ?? {}).some(Boolean)) break;
      }
      return { ...last, changes: all, cursors: merged };
    }
  };
}

const ts = Date.now();
const uid = randomUUID().slice(0, 8);
const wsScope = (value) => [{ kind: "byWorkspace", value }];

function projectInsert(localId, workspace, name) {
  return {
    table: "projects",
    kind: "insert",
    localId,
    value: { workspace, name, identifier: name.slice(0, 4).toUpperCase(), created_at: ts, updated_at: ts }
  };
}
function issueInsert(localId, workspace_id, project_id, name) {
  return {
    table: "issues",
    kind: "insert",
    localId,
    value: {
      workspace_id,
      project_id,
      sequence_id: Math.floor(Math.random() * 100000),
      name,
      sort_order: 1000,
      priority: "none",
      label_ids: [],
      assignee_ids: [],
      created_at: ts,
      updated_at: ts,
      created_by: "ignored-server-sets-scope"
    }
  };
}

const alice = clientFor("alice");
const bob = clientFor("bob");

// ----------------------------------------------------------------------------
console.log("\n=== 3a. Shared collaboration in 'mu-demo' (two real users) ===");
// alice (member of mu-demo) creates a project + an issue.
const projLocalId = `proj-${uid}`;
const issueLocalId = `issue-${uid}`;
const aliceProjectPush = await alice.push([
  projectInsert(projLocalId, "mu-demo", `Shared ${uid}`),
  issueInsert(issueLocalId, "mu-demo", projLocalId, `Issue by alice ${uid}`)
]);
assert(aliceProjectPush.rejected.length === 0, "alice's project+issue inserts in 'mu-demo' accepted");
assert(aliceProjectPush.accepted.length === 2, "two ops accepted for alice");

// bob (member of mu-demo) pulls 'demo' and SEES alice's rows.
const bobPull1 = await bob.pull(wsScope("mu-demo"));
const bobSeesProject = bobPull1.changes.some((c) => c.localId === projLocalId && c.table === "projects");
const bobSeesIssue = bobPull1.changes.some((c) => c.localId === issueLocalId && c.table === "issues");
assert(bobSeesProject, "bob (member) pulled alice's project from 'mu-demo'");
assert(bobSeesIssue, "bob (member) pulled alice's issue from 'mu-demo'");
const issueChange = bobPull1.changes.find((c) => c.localId === issueLocalId);
assert(issueChange?.data?.name === `Issue by alice ${uid}`, "bob sees the issue's name as alice wrote it");

// bob edits the issue (patch). bob is a member -> allowed.
const bobEdit = await bob.push([
  { table: "issues", kind: "patch", localId: issueLocalId, patch: { name: `Edited by bob ${uid}`, priority: "high" } }
]);
assert(bobEdit.rejected.length === 0, "bob's patch of alice's issue accepted (shared write)");

// alice pulls again (from where she left off) and SEES bob's edit.
const aliceCursor = aliceProjectPush.changes.length
  ? { [`byWorkspace:mu-demo`]: aliceProjectPush.changes[aliceProjectPush.changes.length - 1].changeId }
  : {};
const alicePull = await alice.pull(wsScope("mu-demo"), aliceCursor);
const seesEdit = alicePull.changes.some((c) => c.localId === issueLocalId && c.patch?.name === `Edited by bob ${uid}`);
assert(seesEdit, "alice pulled bob's edit to the issue (round-trip across two real users)");

// ----------------------------------------------------------------------------
console.log("\n=== 3b. Scope isolation (I7): 'alice-only' ===");
// alice CAN read+write alice-only.
const aliceOnlyProj = `proj-ao-${uid}`;
const aliceOnlyPush = await alice.push([projectInsert(aliceOnlyProj, "alice-only", `AO ${uid}`)]);
assert(aliceOnlyPush.rejected.length === 0, "alice's insert into 'alice-only' accepted (she is a member)");
const alicePullAO = await alice.pull(wsScope("alice-only"));
assert(
  alicePullAO.changes.some((c) => c.localId === aliceOnlyProj),
  "alice pulled her own row from 'alice-only'"
);

// bob CANNOT read alice-only (membership denied -> scope skipped, 0 changes).
const bobPullAO = await bob.pull(wsScope("alice-only"));
assert(bobPullAO.changes.length === 0, "bob's pull of 'alice-only' returned ZERO changes (read denied)");

// bob CANNOT write alice-only (insert rejected: "Not a member of the target scope").
const bobWriteAO = await bob.push([projectInsert(`proj-ao-bob-${uid}`, "alice-only", `Bob AO ${uid}`)]);
assert(bobWriteAO.accepted.length === 0, "bob's insert into 'alice-only' NOT accepted");
assert(
  bobWriteAO.rejected.length === 1 && /member/i.test(bobWriteAO.rejected[0].message),
  `bob's write to 'alice-only' rejected as non-member (msg: ${bobWriteAO.rejected[0]?.message})`
);
// bob also cannot reach alice's row by patching it (cross-scope patch is denied).
const bobPatchAO = await bob.push([
  { table: "projects", kind: "patch", localId: aliceOnlyProj, patch: { name: "hijacked" } }
]);
assert(
  bobPatchAO.accepted.length === 0 && bobPatchAO.rejected.length === 1,
  `bob's patch of alice-only project rejected (msg: ${bobPatchAO.rejected[0]?.message})`
);

// ----------------------------------------------------------------------------
console.log("\n=== 3c. Server-authoritative identity (auth subject wins over client userId) ===");
// A client authed as BOB but forging userId:"alice" in the envelope. The row it
// creates in 'demo' must be attributed to BOB, not alice. We prove it two ways:
//  (1) the SAME forging client can write to 'demo' (bob IS a member) — if the
//      server trusted the envelope it would act as alice (also a member), so this
//      alone is ambiguous; the decisive test is (2).
//  (2) the forging client is DENIED 'alice-only'. If the server trusted the
//      forged userId:"alice", bob would be let into alice-only. He is NOT ->
//      proves the JWT subject (bob), not the client userId, decides access.
const bobForging = clientFor("bob", { envelopeUserId: "alice" });
const forgeDemo = await bobForging.push([projectInsert(`proj-forge-${uid}`, "mu-demo", `Forge ${uid}`)]);
assert(forgeDemo.rejected.length === 0, "forging client (auth=bob, envelope userId=alice) can write 'mu-demo' (bob is a member)");

const forgeAO = await bobForging.push([projectInsert(`proj-forge-ao-${uid}`, "alice-only", `ForgeAO ${uid}`)]);
assert(
  forgeAO.accepted.length === 0 && /member/i.test(forgeAO.rejected[0]?.message ?? ""),
  "forging client DENIED 'alice-only' despite envelope userId='alice' -> auth subject (bob) wins, client cannot forge identity (I7)"
);
const forgeAOPull = await bobForging.pull(wsScope("alice-only"));
assert(forgeAOPull.changes.length === 0, "forging client pulls ZERO from 'alice-only' (read uses auth subject bob, not forged userId)");

// ----------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "ALL MULTI-USER ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
