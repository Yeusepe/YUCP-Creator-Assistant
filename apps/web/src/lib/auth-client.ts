import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { passkeyClient } from '@better-auth/passkey/client';
import { convexClient } from '@convex-dev/better-auth/client/plugins';
import { polarClient } from '@polar-sh/better-auth/client';
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth client for the web app.
 *
 * The web app is the only browser auth surface.
 * `/api/auth/*` is same-origin and proxied to Convex by TanStack Start.
 *
 * No `baseURL` needed: defaults to current origin, which proxies
 * `/api/auth/*` to Convex via the TanStack Start auth route.
 */
export const authClient = createAuthClient({
  plugins: [
    convexClient(),
    oauthProviderClient(),
    polarClient(),
    emailOTPClient(),
    twoFactorClient(),
    passkeyClient(),
  ],
});
