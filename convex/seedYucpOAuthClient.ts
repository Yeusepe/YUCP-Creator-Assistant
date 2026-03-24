/**
 * Ensure the first-party YUCP Unity OAuth2 public clients exist with the expected config.
 *
 * Manual repair:
 *   npx convex run seedYucpOAuthClient:seedUnityOAuthClient
 *
 * This is safe to run again. The Convex-owned /api/yucp/oauth/authorize route
 * also calls this idempotently so deployments self-heal without a separate
 * production-only seed step.
 *
 * References:
 *   - Better Auth oauthProvider plugin docs:
 *     https://www.better-auth.com/docs/plugins/oauth-provider
 *   - RFC 8252 (OAuth 2.0 for Native Apps / loopback redirect):
 *     https://datatracker.ietf.org/doc/html/rfc8252
 */

import { components } from './_generated/api';
import { internalMutation } from './_generated/server';
import { type BetterAuthPageResult, getBetterAuthPage } from './lib/betterAuthAdapter';

type UnityOAuthClientDescriptor = {
  clientId: string;
  name: string;
  scopes: string[];
  authDomain: 'user' | 'creator';
};

const UNITY_NATIVE_OAUTH_CLIENTS: readonly UnityOAuthClientDescriptor[] = [
  {
    clientId: 'yucp-unity-user',
    name: 'YUCP Unity User',
    scopes: ['verification:read'],
    authDomain: 'user',
  },
  {
    clientId: 'yucp-unity-creator',
    name: 'YUCP Unity Creator',
    scopes: ['cert:issue', 'profile:read'],
    authDomain: 'creator',
  },
] as const;

export function buildUnityOAuthClientMetadata(descriptor: UnityOAuthClientDescriptor): string {
  return JSON.stringify({
    firstParty: true,
    platform: 'unity',
    authDomain: descriptor.authDomain,
  });
}

async function upsertUnityOAuthClient(
  ctx: any,
  descriptor: UnityOAuthClientDescriptor,
  callbackUrl: string
) {
  const desiredClient = {
    clientSecret: null,
    name: descriptor.name,
    redirectUris: [callbackUrl],
    scopes: descriptor.scopes,
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    tokenEndpointAuthMethod: 'none',
    public: true,
    type: 'public',
    skipConsent: false,
    disabled: false,
    metadata: buildUnityOAuthClientMetadata(descriptor),
    updatedAt: Date.now(),
  };

  const existingResult = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: 'oauthClient',
    where: [{ field: 'clientId', value: descriptor.clientId, operator: 'eq' }],
    limit: 1,
    paginationOpts: { cursor: null, numItems: 1 },
  })) as BetterAuthPageResult<{ clientId: string }>;
  const existing = getBetterAuthPage(existingResult);

  if (existing.length > 0) {
    const result = await ctx.runMutation(components.betterAuth.adapter.updateOne as any, {
      input: {
        model: 'oauthClient',
        where: [{ field: 'clientId', value: descriptor.clientId, operator: 'eq' }],
        update: desiredClient,
      },
    });

    console.log(`Updated ${descriptor.clientId} Unity OAuth client:`, result);
    return { clientId: descriptor.clientId, created: false, updated: true, result };
  }

  const now = Date.now();
  const result = await ctx.runMutation(components.betterAuth.adapter.create, {
    input: {
      model: 'oauthClient',
      data: {
        clientId: descriptor.clientId,
        createdAt: now,
        ...desiredClient,
      },
    },
  });

  console.log(`Created ${descriptor.clientId} Unity OAuth client:`, result);
  return { clientId: descriptor.clientId, created: true, updated: false, result };
}

export const seedUnityOAuthClient = internalMutation({
  args: {},
  handler: async (ctx) => {
    const siteUrl = (process.env.CONVEX_SITE_URL ?? '').replace(/\/$/, '');
    if (!siteUrl) throw new Error('CONVEX_SITE_URL env var is not set');

    // The fixed callback URL that the loopback proxy normalises to.
    // Unity actually sends redirect_uri=http://127.0.0.1:PORT/callback,
    // but our /api/yucp/oauth/authorize handler rewrites it to this fixed URL
    // before passing to Better Auth, so this is what Better Auth validates.
    const callbackUrl = `${siteUrl}/api/yucp/oauth/callback`;
    const results = [];
    for (const descriptor of UNITY_NATIVE_OAUTH_CLIENTS) {
      results.push(await upsertUnityOAuthClient(ctx, descriptor, callbackUrl));
    }
    return { ensured: results };
  },
});

/**
 * Purge all stored JWKS keys so they are regenerated with the current algorithm.
 *
 * Run once after changing the Better Auth JWT signing configuration:
 *   npx convex run seedYucpOAuthClient:purgeJwks
 */
export const purgeJwks = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model: 'jwks' },
      paginationOpts: { cursor: null, numItems: 1000 },
    } as any);
    console.log(
      'Purged all JWKS keys, they will be regenerated as RS256 from the current Better Auth and Convex JWT config on next request.'
    );
    return { purged: true };
  },
});
