// Cloud-free JWT helper for the convex-localfirst multi-user proof.
// Uses ONLY Node's built-in `crypto` (no external deps). Generates an RS256
// keypair, builds a JWKS from the public key, and mints/signs JWTs locally.
//
// TEST KEYS ONLY. The private key lives in ./keys/private.pem (gitignored).
// Nothing here ever talks to Convex cloud or any external auth provider.
import { generateKeyPairSync, createSign, createPublicKey, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(HERE, "keys");
const PRIV_PATH = join(KEYS_DIR, "private.pem");
const PUB_PATH = join(KEYS_DIR, "public.pem");
const KID = "lf-multiuser-test-key";

export const ISSUER = "https://convex-localfirst.local/test-issuer";
export const APPLICATION_ID = "convex-localfirst-multiuser";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** Generate (once) and load the test RSA keypair. */
export function ensureKeys() {
  if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true });
  if (!existsSync(PRIV_PATH) || !existsSync(PUB_PATH)) {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    writeFileSync(PRIV_PATH, privateKey, { mode: 0o600 });
    writeFileSync(PUB_PATH, publicKey, { mode: 0o600 });
  }
  return { privatePem: readFileSync(PRIV_PATH, "utf8"), publicPem: readFileSync(PUB_PATH, "utf8") };
}

/** Build a JWKS (RFC 7517) JSON for the public key. */
export function buildJwks() {
  const { publicPem } = ensureKeys();
  const jwk = createPublicKey(publicPem).export({ format: "jwk" });
  return {
    keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }]
  };
}

/** Mint + sign an RS256 JWT for `subject`, with optional extra claims. */
export function mintToken(subject, extraClaims = {}, { ttlSeconds = 3600 } = {}) {
  const { privatePem } = ensureKeys();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: KID };
  const payload = {
    iss: ISSUER,
    aud: APPLICATION_ID,
    sub: subject,
    iat: now,
    nbf: now,
    exp: now + ttlSeconds,
    jti: randomUUID(),
    ...extraClaims
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privatePem).toString("base64url");
  return `${signingInput}.${signature}`;
}

// CLI: `node jwt.mjs jwks` prints the JWKS; `node jwt.mjs token alice` prints a token.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === "jwks") {
    console.log(JSON.stringify(buildJwks(), null, 2));
  } else if (cmd === "token") {
    console.log(mintToken(process.argv[3] || "alice"));
  } else {
    console.error("usage: node jwt.mjs jwks | token <subject>");
    process.exit(1);
  }
}
