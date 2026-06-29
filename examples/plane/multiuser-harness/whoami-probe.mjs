// De-risk probe: confirm cloud-free custom-JWT auth works against the local
// backend. Calls whoami:whoami (1) with no auth, (2) with a locally-minted JWT
// for "alice". ASSERTS the second returns { subject: "alice" }.
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { mintToken } from "./jwt.mjs";

const URL = process.env.VITE_CONVEX_URL || "http://127.0.0.1:3214";
const whoami = makeFunctionReference("whoami:whoami");

function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERT FAILED:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

const anon = new ConvexHttpClient(URL);
const anonResult = await anon.query(whoami, {});
console.log("anon whoami:", JSON.stringify(anonResult));
assert(anonResult.authenticated === false, "no-auth query returns unauthenticated");

const aliceToken = mintToken("alice");
const alice = new ConvexHttpClient(URL);
alice.setAuth(aliceToken);
const aliceResult = await alice.query(whoami, {});
console.log("alice whoami:", JSON.stringify(aliceResult));
assert(aliceResult.authenticated === true, "alice token authenticates");
assert(aliceResult.subject === "alice", `subject is 'alice' (got ${aliceResult.subject})`);

const bobToken = mintToken("bob");
const bob = new ConvexHttpClient(URL);
bob.setAuth(bobToken);
const bobResult = await bob.query(whoami, {});
console.log("bob whoami:", JSON.stringify(bobResult));
assert(bobResult.subject === "bob", `subject is 'bob' (got ${bobResult.subject})`);

console.log("\nDE-RISK PASSED: cloud-free custom-JWT auth -> ctx.auth.getUserIdentity().subject");
