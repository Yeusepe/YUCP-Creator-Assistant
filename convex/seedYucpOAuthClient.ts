/**
 * Ensure the first-party YUCP package broker OAuth2 public client exists.
 *
 * Manual repair:
 *   npx convex run seedYucpOAuthClient:seedPackageBrokerOAuthClient
 *
 * This is safe to run again. Run it after each Convex deployment.
 *
 * References:
 *   - Better Auth oauthProvider plugin docs:
 *     https://www.better-auth.com/docs/plugins/oauth-provider
 *   - RFC 8252 (OAuth 2.0 for Native Apps / loopback redirect):
 *     https://datatracker.ietf.org/doc/html/rfc8252
 */

import { PACKAGE_BROKER_AUDIENCE, PUBLIC_API_AUDIENCE, PUBLIC_API_SCOPES } from '@yucp/shared';
import { components } from './_generated/api';
import { internalMutation } from './_generated/server';
import {
  OAUTH_REFRESH_TOKEN_SCOPE,
  type OAuthProviderScope,
  PACKAGE_BROKER_OPERATION_SCOPE,
} from './betterAuth/oauthProviderScopes';
import { type BetterAuthPageResult, getBetterAuthPage } from './lib/betterAuthAdapter';

type PackageBrokerOAuthClientDescriptor = {
  clientId: string;
  name: string;
  scopes: OAuthProviderScope[];
  authDomain: 'user' | 'creator';
  /** RFC 8707 resource this client is linked to and requests tokens for. */
  resource: string;
};

/**
 * One public client per native application (RFC 8252 §8.4), each least-privileged
 * to a single RFC 8707 resource:
 *
 *   yucp-package-broker   consumer installer  → package operations
 *   yucp-package-exporter creator Unity tools → public API (certificate issuance)
 *
 * The exporter deliberately cannot request `package:operate`, and the broker
 * deliberately cannot request `cert:issue`.
 */
const PACKAGE_BROKER_OAUTH_CLIENTS: readonly PackageBrokerOAuthClientDescriptor[] = [
  {
    clientId: 'yucp-package-broker',
    name: 'YUCP Package Broker',
    scopes: [PACKAGE_BROKER_OPERATION_SCOPE, OAUTH_REFRESH_TOKEN_SCOPE],
    authDomain: 'user',
    resource: PACKAGE_BROKER_AUDIENCE,
  },
  {
    clientId: 'yucp-package-exporter',
    name: 'YUCP Package Exporter',
    // Exactly the scopes the Unity exporter's routes require:
    //   cert:issue        POST /v1/certificates, GET /v1/certificates/{me,devices}
    //   products:read     GET /v1/products
    //   verification:read GET /v1/me
    scopes: ['cert:issue', 'products:read', 'verification:read', OAUTH_REFRESH_TOKEN_SCOPE],
    authDomain: 'creator',
    resource: PUBLIC_API_AUDIENCE,
  },
] as const;
const SUPERSEDED_PACKAGE_OAUTH_CLIENT_IDS = ['yucp-unity-user', 'yucp-unity-creator'] as const;

export function getPackageBrokerOAuthClientDescriptors(): readonly PackageBrokerOAuthClientDescriptor[] {
  return PACKAGE_BROKER_OAUTH_CLIENTS;
}

export function getSupersededPackageOAuthClientIds(): readonly string[] {
  return SUPERSEDED_PACKAGE_OAUTH_CLIENT_IDS;
}

export function buildPackageBrokerOAuthClientMetadata(
  descriptor: PackageBrokerOAuthClientDescriptor
): string {
  return JSON.stringify({
    firstParty: true,
    credentialOwner: 'native-package-broker',
    platform: 'native',
    authDomain: descriptor.authDomain,
  });
}

export function buildPackageBrokerOAuthResourceRecord() {
  return {
    identifier: PACKAGE_BROKER_AUDIENCE,
    name: 'YUCP package operations',
    allowedScopes: [PACKAGE_BROKER_OPERATION_SCOPE, OAUTH_REFRESH_TOKEN_SCOPE],
    accessTokenTtl: 300,
    refreshTokenTtl: 30 * 24 * 60 * 60,
    dpopBoundAccessTokensRequired: true,
    disabled: false,
    policyVersion: 1,
  };
}

/**
 * The public API resource. `apps/api` injects this identifier into every token
 * exchange that omits `resource` (see `bindDefaultOAuthResource`), so the row
 * has to exist or `resolveResourcePolicy` rejects the exchange with
 * `invalid_target` — `cachedResources` is only a read cache, not a definition.
 *
 * DPoP is not required at the resource level: browser and API-key callers
 * present plain bearer tokens. Native clients opt in per client record instead.
 */
export function buildPublicApiOAuthResourceRecord() {
  return {
    identifier: PUBLIC_API_AUDIENCE,
    name: 'YUCP public API',
    allowedScopes: [...PUBLIC_API_SCOPES, OAUTH_REFRESH_TOKEN_SCOPE],
    accessTokenTtl: 3600,
    refreshTokenTtl: 30 * 24 * 60 * 60,
    dpopBoundAccessTokensRequired: false,
    disabled: false,
    policyVersion: 1,
  };
}

export function buildPackageBrokerOAuthResourceRecords() {
  return [buildPackageBrokerOAuthResourceRecord(), buildPublicApiOAuthResourceRecord()];
}

export function buildPackageBrokerOAuthClientResourceLink(
  descriptor: PackageBrokerOAuthClientDescriptor
) {
  return {
    clientId: descriptor.clientId,
    resourceId: descriptor.resource,
  };
}

export function buildPackageBrokerOAuthClientRecord(
  descriptor: PackageBrokerOAuthClientDescriptor,
  callbackUrl: string
) {
  /**
   * Better Auth supports DPoP-bound public clients through this client property.
   * https://better-auth.com/docs/plugins/oauth-provider#dynamic-registration-endpoint
   *
   * RFC 9449 requires the token endpoint proof key to bind public-client refresh tokens.
   * https://www.rfc-editor.org/rfc/rfc9449#section-8
   */
  return {
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
    dpopBoundAccessTokens: true,
    metadata: buildPackageBrokerOAuthClientMetadata(descriptor),
    updatedAt: Date.now(),
  };
}

async function upsertOAuthResource(
  ctx: any,
  record: ReturnType<typeof buildPackageBrokerOAuthResourceRecords>[number]
) {
  const desiredResource = {
    ...record,
    updatedAt: Date.now(),
  };
  const existingResult = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: 'oauthResource',
    where: [
      {
        field: 'identifier',
        value: record.identifier,
        operator: 'eq',
      },
    ],
    limit: 1,
    paginationOpts: { cursor: null, numItems: 1 },
  })) as BetterAuthPageResult<{ identifier: string }>;
  const existing = getBetterAuthPage(existingResult);

  if (existing.length > 0) {
    await ctx.runMutation(components.betterAuth.adapter.updateOne as any, {
      input: {
        model: 'oauthResource',
        where: [
          {
            field: 'identifier',
            value: record.identifier,
            operator: 'eq',
          },
        ],
        update: desiredResource,
      },
    });
    return { identifier: record.identifier, created: false, updated: true };
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
  return { identifier: record.identifier, created: true, updated: false };
}

async function ensurePackageBrokerOAuthClientResourceLink(
  ctx: any,
  descriptor: PackageBrokerOAuthClientDescriptor
) {
  const desiredLink = buildPackageBrokerOAuthClientResourceLink(descriptor);
  const existingResult = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: 'oauthClientResource',
    where: [
      {
        field: 'clientId',
        value: desiredLink.clientId,
        operator: 'eq',
      },
    ],
    paginationOpts: { cursor: null, numItems: 100 },
  })) as BetterAuthPageResult<{ clientId: string; resourceId: string }>;
  const existing = getBetterAuthPage(existingResult);

  if (existing.some((link) => link.resourceId === desiredLink.resourceId)) {
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

async function upsertPackageBrokerOAuthClient(
  ctx: any,
  descriptor: PackageBrokerOAuthClientDescriptor,
  callbackUrl: string
) {
  const desiredClient = buildPackageBrokerOAuthClientRecord(descriptor, callbackUrl);

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

    console.log(`Updated ${descriptor.clientId} package broker OAuth client:`, result);
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

  console.log(`Created ${descriptor.clientId} package broker OAuth client:`, result);
  return { clientId: descriptor.clientId, created: true, updated: false, result };
}

async function retireOAuthClient(ctx: any, clientId: string) {
  const existingResult = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: 'oauthClient',
    where: [{ field: 'clientId', value: clientId, operator: 'eq' }],
    limit: 1,
    paginationOpts: { cursor: null, numItems: 1 },
  })) as BetterAuthPageResult<{ clientId: string }>;
  if (getBetterAuthPage(existingResult).length === 0) {
    return { clientId, retired: false };
  }
  await ctx.runMutation(components.betterAuth.adapter.updateOne as any, {
    input: {
      model: 'oauthClient',
      where: [{ field: 'clientId', value: clientId, operator: 'eq' }],
      update: { disabled: true, updatedAt: Date.now() },
    },
  });
  return { clientId, retired: true };
}

export const seedPackageBrokerOAuthClient = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Better Auth applies the RFC 8252 loopback-port exception when the
    // requested URI has this exact scheme, host, path, and query.
    const callbackUrl = 'http://127.0.0.1/callback';
    const resource = [];
    for (const record of buildPackageBrokerOAuthResourceRecords()) {
      resource.push(await upsertOAuthResource(ctx, record));
    }
    const results = [];
    for (const descriptor of PACKAGE_BROKER_OAUTH_CLIENTS) {
      const client = await upsertPackageBrokerOAuthClient(ctx, descriptor, callbackUrl);
      const resourceLink = await ensurePackageBrokerOAuthClientResourceLink(ctx, descriptor);
      results.push({ client, resourceLink });
    }
    const retired = [];
    for (const clientId of SUPERSEDED_PACKAGE_OAUTH_CLIENT_IDS) {
      retired.push(await retireOAuthClient(ctx, clientId));
    }
    return { resource, ensured: results, retired };
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
