import { query } from "./_generated/server";

// De-risk probe for cloud-free custom-JWT auth: returns the server-resolved
// identity (or null when unauthenticated). When a client presents a valid
// locally-minted JWT, this returns { subject: "<sub>" } — proving the local
// backend validated our token WITHOUT Convex cloud. Used only by the multi-user
// harness; harmless in the demo (returns null when no token is attached).
export const whoami = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { authenticated: false, subject: null };
    return {
      authenticated: true,
      subject: identity.subject,
      issuer: identity.issuer ?? null,
      tokenIdentifier: identity.tokenIdentifier ?? null
    };
  }
});
