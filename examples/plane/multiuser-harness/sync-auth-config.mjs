// Rewrites the static JWKS data: URI in ../convex/auth.config.ts from the current
// public key in ./keys/public.pem. Run after (re)generating the keypair so the
// backend's auth config matches the key the harness signs with. Reproducibility
// helper only — auth.config.ts itself stays a pure (node-API-free) Convex module.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJwks } from "./jwt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, "..", "convex", "auth.config.ts");

const jwks = JSON.stringify(buildJwks());
const dataUri = `data:application/json;base64,${Buffer.from(jwks).toString("base64")}`;

const src = readFileSync(CONFIG, "utf8");
const next = src.replace(
  /(JWKS-DATA-URI-START[\s\S]*?JWKS_DATA_URI =\s*")[^"]*(";)/,
  `$1${dataUri}$2`
);
if (next === src) {
  console.error("FAILED: could not find JWKS_DATA_URI block in auth.config.ts");
  process.exit(1);
}
writeFileSync(CONFIG, next);
console.log("auth.config.ts JWKS synced to keys/public.pem");
