// Seed real multi-user fixtures via mutations (no hand-editing of data):
//   users:      alice, bob
//   workspace "mu-demo":    alice admin(20), bob member(15)   (shared)
//   workspace "alice-only": alice admin(20) ONLY  (bob is NOT a member)
// These are the ground truth the multi-user proof asserts against. Idempotent.
//
// "mu-demo" is a DEDICATED multi-user workspace (not the original single-user
// "demo", which has accumulated 500+ change-log rows from the Plane e2e runs and
// would page the pull). A fresh shared workspace is both representative ("two
// users share a workspace") and keeps the existing demo untouched.
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ISSUER } from "./jwt.mjs";

const URL = process.env.VITE_CONVEX_URL || "http://127.0.0.1:3214";
const upsertUser = makeFunctionReference("workspaces:upsertUser");
const createWorkspace = makeFunctionReference("workspaces:createWorkspace");
const addMember = makeFunctionReference("workspaces:addMember");

const client = new ConvexHttpClient(URL);

const tokenId = (subject) => `${ISSUER}|${subject}`;

function user(subject) {
  return {
    id: tokenId(subject),
    email: `${subject}@convex-localfirst.local`,
    display_name: subject,
    first_name: subject,
    last_name: "",
    avatar_url: ""
  };
}

await client.mutation(upsertUser, user("alice"));
await client.mutation(upsertUser, user("bob"));

// mu-demo: dedicated shared workspace. createWorkspace makes the creator (alice)
// admin (20); bob is added as a member (15).
await client.mutation(createWorkspace, { user_id: tokenId("alice"), id: "mu-demo", name: "Multi-User Demo", slug: "mu-demo" });
await client.mutation(addMember, { user_id: tokenId("alice"), workspace_id: "mu-demo", role: 20 });
await client.mutation(addMember, { user_id: tokenId("bob"), workspace_id: "mu-demo", role: 15 });

// alice-only: alice is the sole member; bob must be DENIED.
await client.mutation(createWorkspace, { user_id: tokenId("alice"), id: "alice-only", name: "Alice Only", slug: "alice-only" });

console.log("seed complete: alice+bob in 'mu-demo' (admin/member), alice-only is alice-only");
