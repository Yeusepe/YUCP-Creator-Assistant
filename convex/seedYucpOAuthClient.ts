/**
 * One-time seed: register the YUCP Unity Editor OAuth2 public client.
 *
 * Run once with:
 *   npx convex run seedYucpOAuthClient:seedUnityOAuthClient
 *
 * This is safe to run again — it checks for an existing client first.
 *
 * References:
 *   - Better Auth oauthProvider plugin docs:
 *     https://www.better-auth.com/docs/plugins/oauth-provider
 *   - RFC 8252 (OAuth 2.0 for Native Apps / loopback redirect):
 *     https://datatracker.ietf.org/doc/html/rfc8252
 */

import { internalMutation } from './_generated/server';
import { components } from './_generated/api';

export const seedUnityOAuthClient = internalMutation({
  args: {},
  handler: async (ctx) => {
    const siteUrl = (process.env.CONVEX_SITE_URL ?? '').replace(/\/$/, '');
    if (!siteUrl) throw new Error('CONVEX_SITE_URL env var is not set');

    // The fixed callback URL that the loopback proxy normalises to.
    // Unity actually sends redirect_uri=http://127.0.0.1:PORT/callback,
    // but our /api/yucp/oauth/authorize handler rewrites it to this fixed URL
    // before passing to Better Auth — so this is what Better Auth validates.
    const callbackUrl = `${siteUrl}/api/yucp/oauth/callback`;

    // Check whether the client already exists
    const existing = await ctx.runQuery(
      components.betterAuth.adapter.findMany,
      {
        model: 'oauthClient',
        where: [{ field: 'clientId', value: 'yucp-unity-editor', operator: 'eq' }],
        limit: 1,
        paginationOpts: { cursor: null, numItems: 1 },
      },
    );

    if (existing.length > 0) {
      console.log('yucp-unity-editor OAuth client already exists — skipping seed.');
      return { created: false };
    }

    const now = Date.now();
    const result = await ctx.runMutation(
      components.betterAuth.adapter.create,
      {
        input: {
          model: 'oauthClient',
          data: {
            clientId: 'yucp-unity-editor',
            clientSecret: null,
            name: 'YUCP Unity Editor',
            redirectUris: [callbackUrl],
            scopes: ['cert:issue'],
            grantTypes: ['authorization_code'],
            responseTypes: ['code'],
            tokenEndpointAuthMethod: 'none',
            public: true,
            type: 'public',
            skipConsent: false,
            disabled: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    );

    console.log('Created yucp-unity-editor OAuth client:', result);
    return { created: true, result };
  },
});
