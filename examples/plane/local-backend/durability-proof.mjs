// PROOF: the standalone local backend is DURABLE — data written through the
// package's sync wire survives a backend CRASH + auto-restart (the supervisor in
// serve.sh), and a FRESH client reconnecting after the bounce still sees it.
// Cloud-free: identity is a locally-minted JWT (reuses the multi-user harness).
//
//   node durability-proof.mjs write           -> seeds a uniquely-tagged project,
//                                                asserts it is pullable, prints its id
//   node durability-proof.mjs verify <localId> -> a NEW client pulls and asserts the
//                                                row is still there (post-restart)
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { randomUUID } from "node:crypto";
import { mintToken } from "../multiuser-harness/jwt.mjs";

const URL = process.env.VITE_CONVEX_URL || "http://127.0.0.1:3214";
const SCHEMA_VERSION = 1;
const pushRef = makeFunctionReference("sync:push");
const pullRef = makeFunctionReference("sync:pull");
const WS = "mu-demo"; // alice is a member (seeded by the multi-user harness)

function client(subject) {
  const c = new ConvexHttpClient(URL);
  c.setAuth(mintToken(subject));
  const clientId = `dur-${subject}-${randomUUID().slice(0, 8)}`;
  return {
    push: (mutations) =>
      c.mutation(pushRef, { clientId, userId: subject, schemaVersion: SCHEMA_VERSION,
        mutations: mutations.map((m) => ({ opId: randomUUID(), clientId, schemaVersion: SCHEMA_VERSION,
          functionName: `${m.table}:${m.kind === "insert" ? "create" : m.kind === "patch" ? "update" : "remove"}`,
          table: m.table, kind: m.kind, localId: m.localId, value: m.value })) }),
    pull: async () => {
      let cursors = {}, all = [];
      for (let i = 0; i < 50; i++) {
        const r = await c.query(pullRef, { clientId, userId: subject, schemaVersion: SCHEMA_VERSION,
          scopes: [{ kind: "byWorkspace", value: WS }], cursors });
        all.push(...r.changes); cursors = { ...cursors, ...r.cursors };
        if (!Object.values(r.hasMore ?? {}).some(Boolean)) break;
      }
      return all;
    }
  };
}

const cmd = process.argv[2];

if (cmd === "write") {
  const localId = `dur-proj-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const ts = Date.now();
  const alice = client("alice");
  const res = await alice.push([{ table: "projects", kind: "insert", localId,
    value: { workspace: WS, name: `Durability ${localId}`, identifier: "DUR", created_at: ts, updated_at: ts } }]);
  if (res.rejected?.length) { console.error("FAIL: write rejected", res.rejected); process.exit(1); }
  const changes = await alice.pull();
  const seen = changes.some((c) => c.localId === localId && c.table === "projects");
  if (!seen) { console.error("FAIL: row not pullable immediately after write"); process.exit(1); }
  console.error("PASS: wrote + pulled tagged row pre-crash");
  console.log(localId); // stdout = the id, for the shell to pass to `verify`
} else if (cmd === "verify") {
  const localId = process.argv[3];
  if (!localId) { console.error("usage: verify <localId>"); process.exit(2); }
  const fresh = client("alice"); // NEW client/connection = reconnect after the bounce
  const changes = await fresh.pull();
  const seen = changes.some((c) => c.localId === localId && c.table === "projects");
  if (!seen) { console.error(`FAIL: row ${localId} missing after crash+restart (NOT durable)`); process.exit(1); }
  console.error(`PASS: row ${localId} survived the crash+restart, served to a fresh client`);
} else {
  console.error("usage: node durability-proof.mjs write | verify <localId>");
  process.exit(2);
}
