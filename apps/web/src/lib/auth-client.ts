import { convexClient } from '@convex-dev/better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth client for the web app.
 *
 * The `convexClient()` plugin handles cross-domain auth with Convex:
 * - Stores session cookies in localStorage (cross-domain safe)
 * - Adds `Better-Auth-Cookie` header to requests
 * - Reads `Set-Better-Auth-Cookie` from responses
 * - OTT auto-exchange handled by ConvexBetterAuthProvider
 *
 * No `baseURL` needed: defaults to current origin, which proxies
 * /api/auth/* to Convex via the TanStack Start catch-all route.
 */
export const authClient = createAuthClient({
  plugins: [convexClient()],
});
