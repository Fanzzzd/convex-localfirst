// Cloud-free CUSTOM JWT auth for the local Convex backend.
//
// This proves the convex-localfirst package supports REAL per-user identity with
// NO Convex cloud and NO third-party auth provider (Auth0/Clerk). We mint JWTs
// with a local keypair we control (multiuser-harness/jwt.mjs) and embed the
// public JWKS INLINE as a data: URI, so there is no extra HTTP server to host the
// keys. `npx convex dev` pushes this config to the local backend on :3214.
//
// When a client calls setAuth(() => token) and the token validates here,
// ctx.auth.getUserIdentity().tokenIdentifier combines issuer + JWT `sub`; the
// package uses that globally unique value as its server-authoritative user id.
//
// NOTE: auth.config.ts is bundled for the Convex runtime (not Node), so it cannot
// read files / use node:crypto here. The JWKS below is therefore a STATIC inline
// value. To regenerate after changing the keypair, run:
//   node multiuser-harness/sync-auth-config.mjs
// which rewrites the `jwks` literal from multiuser-harness/keys/public.pem.
export const ISSUER = "https://convex-localfirst.local/test-issuer";
export const APPLICATION_ID = "convex-localfirst-multiuser";

// JWKS-DATA-URI-START (managed by sync-auth-config.mjs)
const JWKS_DATA_URI =
  "data:application/json;base64,eyJrZXlzIjpbeyJrdHkiOiJSU0EiLCJuIjoiNmFDZjJOdURuOVdBMWJDOGNsQV9lLWxPdWJ4S0M5TVN6YmhjMS1DbE1WRW1RbFNyMGU1cnFZdzZRUWRBRjRsOVVxS1lZUnRwYkFFanF2QzRDVGlKcTk0TzV3UGc0ZmRQM01taFM5UWpYRkdCMk93aWZXSGFXMjAzUEdNcGNIVWxGSXpCLXFNZGhFdU5FV0QyVnd1TkFxa2VzUG9LUVpFcTBnVXBBNXFhd0NmZUk3RnduR0g1TTV0cmlKTGFnMDBjQ05BaGhZZUthOFpSMkNlUml1SDA1Zm93YjVPSzBfNkc1YlNlTGZCQk1PcGNmS05CeU1qdEJEdHU4VWRlZVdPWlg2dDBISlRqTWJlZmJkZkFYZTVFcklNS1EzTkVrakxTa1pPTW9RUTh0VHJlUlFDQmgwc0IySzNkS3ZrT0ZQUVVCZXdRSmZjMmF1M3FVOGlfNi1lbkZ3IiwiZSI6IkFRQUIiLCJraWQiOiJsZi1tdWx0aXVzZXItdGVzdC1rZXkiLCJ1c2UiOiJzaWciLCJhbGciOiJSUzI1NiJ9XX0=";
// JWKS-DATA-URI-END

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: APPLICATION_ID,
      issuer: ISSUER,
      jwks: JWKS_DATA_URI,
      algorithm: "RS256"
    }
  ]
};
