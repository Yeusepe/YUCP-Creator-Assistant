/**
 * Ensure the first-party YUCP Unity OAuth2 public clients exist with the expected config.
 *
 * Manual repair:
 *   npx convex run seedYucpOAuthClient:seedUnityOAuthClient
 *
 * This is safe to run again. Run it after each Convex deployment.
 *
 * References:
 *   - Better Auth oauthProvider plugin docs:
 *     https://www.better-auth.com/docs/plugins/oauth-provider
 *   - RFC 8252 (OAuth 2.0 for Native Apps / loopback redirect):
 *     https://datatracker.ietf.org/doc/html/rfc8252
 */

import { components } from './_generated/api';
import { internalMutation } from './_generated/server';
import {
  OAUTH_REFRESH_TOKEN_SCOPE,
  OAUTH_PROVIDER_SCOPES,
  type OAuthProviderScope,
} from './betterAuth/oauthProviderScopes';
import { PUBLIC_API_AUDIENCE } from '@yucp/shared';
import { type BetterAuthPageResult, getBetterAuthPage } from './lib/betterAuthAdapter';

type UnityOAuthClientDescriptor = {
  clientId: string;
  name: string;
  scopes: OAuthProviderScope[];
  authDomain: 'user' | 'creator';
};

const UNITY_NATIVE_OAUTH_CLIENTS: readonly UnityOAuthClientDescriptor[] = [
  {
    clientId: 'yucp-unity-user',
    name: 'YUCP Unity User',
    scopes: ['verification:read', 'products:read', OAUTH_REFRESH_TOKEN_SCOPE],
    authDomain: 'user',
  },
  {
    clientId: 'yucp-unity-creator',
    name: 'YUCP Unity Creator',
    scopes: ['cert:issue', 'profile:read', 'products:read', OAUTH_REFRESH_TOKEN_SCOPE],
    authDomain: 'creator',
  },
] as const;

export function getUnityOAuthClientDescriptors(): readonly UnityOAuthClientDescriptor[] {
  return UNITY_NATIVE_OAUTH_CLIENTS;
}

export function buildUnityOAuthClientMetadata(descriptor: UnityOAuthClientDescriptor): string {
  return JSON.stringify({
    firstParty: true,
    platform: 'unity',
    authDomain: descriptor.authDomain,
  });
}

export function buildPublicApiOAuthResourceRecord() {
  return {
    identifier: PUBLIC_API_AUDIENCE,
    name: 'YUCP public API',
    allowedScopes: [...OAUTH_PROVIDER_SCOPES],
    disabled: false,
    policyVersion: 1,
  };
}

export function buildUnityOAuthClientResourceLink(
  descriptor: UnityOAuthClientDescriptor
) {
  return {
    clientId: descriptor.clientId,
    resourceId: PUBLIC_API_AUDIENCE,
  };
}

async function upsertPublicApiOAuthResource(ctx: any) {
  const desiredResource = {
    ...buildPublicApiOAuthResourceRecord(),
    updatedAt: Date.now(),
  };
  const existingResult = (await ctx.runQuery(
    components.betterAuth.adapter.findMany,
    {
      model: 'oauthResource',
      where: [
        {
          field: 'identifier',
          value: PUBLIC_API_AUDIENCE,
          operator: 'eq',
        },
      ],
      limit: 1,
      paginationOpts: { cursor: null, numItems: 1 },
    }
  )) as BetterAuthPageResult<{ identifier: string }>;
  const existing = getBetterAuthPage(existingResult);

  if (existing.length > 0) {
    await ctx.runMutation(components.betterAuth.adapter.updateOne as any, {
      input: {
        model: 'oauthResource',
        where: [
          {
            field: 'identifier',
            value: PUBLIC_API_AUDIENCE,
            operator: 'eq',
          },
        ],
        update: desiredResource,
      },
    });
    return { created: false, updated: true };
  }

  await ctx.runMutation(components.betterAuth.adapter.create, {
    input: {
      model: 'oauthResource',
      data: {
        createdAt: Date.now(),
        ...desiredResource,
      },
    },
  });
  return { created: true, updated: false };
}

async function ensureUnityOAuthClientResourceLink(
  ctx: any,
  descriptor: UnityOAuthClientDescriptor
) {
  const desiredLink = buildUnityOAuthClientResourceLink(descriptor);
  const existingResult = (await ctx.runQuery(
    components.betterAuth.adapter.findMany,
    {
      model: 'oauthClientResource',
      where: [
        {
          field: 'clientId',
          value: desiredLink.clientId,
          operator: 'eq',
        },
      ],
      paginationOpts: { cursor: null, numItems: 100 },
    }
  )) as BetterAuthPageResult<{ clientId: string; resourceId: string }>;
  const existing = getBetterAuthPage(existingResult);

  if (
    existing.some(
      (link) => link.resourceId === desiredLink.resourceId
    )
  ) {
    return { created: false };
  }

  await ctx.runMutation(components.betterAuth.adapter.create, {
    input: {
      model: 'oauthClientResource',
      data: {
        ...desiredLink,
        createdAt: Date.now(),
      },
    },
  });
  return { created: true };
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
    // Better Auth applies the RFC 8252 loopback-port exception when the
    // requested URI has this exact scheme, host, path, and query.
    const callbackUrl = 'http://127.0.0.1/callback';
    const resource = await upsertPublicApiOAuthResource(ctx);
    const results = [];
    for (const descriptor of UNITY_NATIVE_OAUTH_CLIENTS) {
      const client = await upsertUnityOAuthClient(
        ctx,
        descriptor,
        callbackUrl
      );
      const resourceLink = await ensureUnityOAuthClientResourceLink(
        ctx,
        descriptor
      );
      results.push({ client, resourceLink });
    }
    return { resource, ensured: results };
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
