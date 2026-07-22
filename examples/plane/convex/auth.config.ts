// Cloud-free CUSTOM JWT auth for the local Convex backend.
//
// This proves the convex-localfirst package supports REAL per-user identity with
// NO Convex cloud and NO third-party auth provider (Auth0/Clerk). We mint JWTs
// with a local keypair you control and embed the public JWKS INLINE as a data:
// URI, so there is no extra HTTP server to host the keys. `npx convex dev`
// pushes this config to the local backend on :3214.
//
// When a client calls setAuth(() => token) and the token validates here,
// ctx.auth.getUserIdentity().tokenIdentifier combines issuer + JWT `sub`; the
// package uses that globally unique value as its server-authoritative user id.
//
// NOTE: auth.config.ts is bundled for the Convex runtime (not Node), so it cannot
// read files / use node:crypto here. The JWKS below is therefore a STATIC inline
// value. Generate your own keypair (keep the private key OUT of git) and rewrite
// the literal below, e.g.:
//   node -e 'const{generateKeyPairSync}=require("node:crypto");const{publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});const j=publicKey.export({format:"jwk"});console.log("data:application/json;base64,"+Buffer.from(JSON.stringify({keys:[{...j,kid:"lf-multiuser-test-key",use:"sig",alg:"RS256"}]})).toString("base64"))'
export const ISSUER = "https://convex-localfirst.local/test-issuer";
export const APPLICATION_ID = "convex-localfirst-multiuser";

// JWKS-DATA-URI-START
const JWKS_DATA_URI =
  "data:application/json;base64,eyJrZXlzIjpbeyJrdHkiOiJSU0EiLCJuIjoid1F3V0hMV3BHdU1mQURLMm5mMXFZZUc5eVlENHMzUEg3aHhLYU9zbmNoX0VKaXkxTWhLVVRXMmtBVGc5Y3ZKTGlPX3FMek9tNDg3SWRhTGNzWXhSV0JxQzk5enJyc3dvUHNLVHNSbjM2amtBU2IwbHcwZGUtdmFCOFJmM1BBcGczZnhtbUtfZDdmSS1XbTJ4Qm15cUZwdVhIWWg3MGhGak83eGlkZVFNT0NqczRUekQzbXRBUzNEMTZsS3lhUm1pMjFKWXBEdW5PbFF0Q0QzWkNTZTNhYlNiYkhBdWo4cHpNX201MVN1U0s0R09neWpfSWpINFg0dldJbWk3M2dTTDcwVUZyUlZoUWMzWjk2X2thTFNybEpUYmQ2eWpqVEdSWFpNOTVuckJkTm00bkhrcGI5dXFpN2VGV0lSUXhnR0dhaFctdE5haEQ5Q19zQkVfYUNBQnB3IiwiZSI6IkFRQUIiLCJraWQiOiJsZi1tdWx0aXVzZXItdGVzdC1rZXkiLCJ1c2UiOiJzaWciLCJhbGciOiJSUzI1NiJ9XX0=";
// JWKS-DATA-URI-END

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: APPLICATION_ID,
      issuer: ISSUER,
      jwks: JWKS_DATA_URI,
      algorithm: "RS256",
    },
  ],
};
