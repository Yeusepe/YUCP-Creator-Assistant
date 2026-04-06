/**
 * Better Auth configuration for YUCP Creator Assistant.
 *
 * Convex owns browser auth, JWT issuance, API keys, and OAuth clients. The web
 * app proxies `/api/auth/*` to Convex, so this configuration intentionally
 * stays on the same-origin model and does not enable cross-domain auth
 * transport.
 */

import './polyfills';

import { apiKey } from '@better-auth/api-key';
import { oauthProvider } from '@better-auth/oauth-provider';
import type { GenericCtx } from '@convex-dev/better-auth';
import { createClient } from '@convex-dev/better-auth';
import { convex } from '@convex-dev/better-auth/plugins';
import { checkout, polar, portal, usage, webhooks } from '@polar-sh/better-auth';
import { Polar } from '@polar-sh/sdk';
import type { BetterAuthOptions } from 'better-auth';
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { components, internal } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import authConfig from './auth.config';
import { createJwtJwksAdapter } from './betterAuth/jwtAdapter';
import authSchema from './betterAuth/schema';
import { getCertificateBillingConfig } from './lib/certificateBillingConfig';
import {
  toCertificateBillingProjectionBenefitGrant,
  toCertificateBillingProjectionMeter,
  toCertificateBillingProjectionSubscription,
} from './lib/certificateBillingProjection';
import { buildTrustedBrowserOrigins } from './lib/trustedOrigins';
import { vrchat } from './plugins/vrchat';

const PUBLIC_API_AUDIENCE = 'yucp-public-api';
const PUBLIC_API_KEY_PREFIX = 'ypsk_';
const PUBLIC_API_KEY_PERMISSION_NAMESPACE = 'publicApi';
let hasLoggedBetterAuthConfig = false;

function resolveConvexSiteUrl(): string {
  const explicit = process.env.CONVEX_SITE_URL?.replace(/\/$/, '');
  if (explicit) {
    return explicit;
  }

  const convexUrl = process.env.CONVEX_URL?.replace(/\/$/, '');
  if (convexUrl) {
    return convexUrl.replace('.convex.cloud', '.convex.site');
  }

  throw new Error('CONVEX_SITE_URL is required');
}

export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: {
    schema: authSchema,
  },
});

function parseCachedTrustedClients(value: string | undefined): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON must be a JSON array of client IDs');
    }

    return new Set(
      parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
    );
  } catch (error) {
    throw new Error(
      `Failed to parse PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function extractWebhookCustomerRef(payload: unknown): {
  authUserId?: string;
  polarCustomerId?: string;
} {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const record = payload as {
    data?: {
      customer?: { externalId?: string | null; id?: string | null };
    };
  };

  const authUserId = record.data?.customer?.externalId?.trim() ?? undefined;
  const polarCustomerId = record.data?.customer?.id?.trim() ?? undefined;
  return { authUserId, polarCustomerId };
}

async function scheduleCustomerReconciliation(ctx: GenericCtx<DataModel>, payload: unknown) {
  const { authUserId, polarCustomerId } = extractWebhookCustomerRef(payload);
  if (!authUserId || !('runMutation' in ctx)) {
    return;
  }

  await ctx.runMutation(internal.certificateBillingSync.scheduleReconciliationTarget, {
    authUserId,
    polarCustomerId,
    delayMs: 0,
  });
}

export const createAuthOptions = (ctx: GenericCtx<DataModel>): BetterAuthOptions => {
  const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
  if (!betterAuthSecret) {
    throw new Error('BETTER_AUTH_SECRET is required');
  }

  const convexSiteUrl = resolveConvexSiteUrl();
  const siteUrl =
    process.env.FRONTEND_URL?.replace(/\/$/, '') ??
    process.env.SITE_URL?.replace(/\/$/, '') ??
    'http://localhost:3000';
  const discordClientId = process.env.DISCORD_CLIENT_ID?.trim();
  const discordClientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();

  if ((discordClientId && !discordClientSecret) || (!discordClientId && discordClientSecret)) {
    throw new Error(
      'DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET must both be set to enable Discord sign-in'
    );
  }

  const discordConfig =
    discordClientId && discordClientSecret
      ? {
          discord: {
            clientId: discordClientId,
            clientSecret: discordClientSecret,
          },
        }
      : {};

  const trustedOrigins = buildTrustedBrowserOrigins({
    siteUrl,
    frontendUrl: process.env.FRONTEND_URL ?? siteUrl,
  });

  if (!hasLoggedBetterAuthConfig) {
    hasLoggedBetterAuthConfig = true;
  }

  const authBaseUrl = `${convexSiteUrl}/api/auth`;
  const cachedTrustedClients = parseCachedTrustedClients(
    process.env.PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON
  );
  const certificateBillingConfig = getCertificateBillingConfig();
  const polarPlugins =
    certificateBillingConfig.enabled && certificateBillingConfig.polarAccessToken
      ? [
          polar({
            client: new Polar({
              accessToken: certificateBillingConfig.polarAccessToken,
              ...(certificateBillingConfig.polarServer
                ? { server: certificateBillingConfig.polarServer }
                : {}),
            }),
            createCustomerOnSignUp: true,
            getCustomerCreateParams: async () => ({
              metadata: {
                certificate_billing: true,
              },
            }),
            use: [
              checkout({
                successUrl: `${siteUrl.replace(/\/$/, '')}/dashboard/certificates?checkout_id={CHECKOUT_ID}`,
                returnUrl: `${siteUrl.replace(/\/$/, '')}/dashboard/certificates`,
                authenticatedUsersOnly: true,
              }),
              portal({
                returnUrl: `${siteUrl.replace(/\/$/, '')}/dashboard/certificates`,
              }),
              usage(),
              webhooks({
                secret: certificateBillingConfig.polarWebhookSecret ?? '',
                onCustomerStateChanged: async (payload) => {
                  const authUserId = payload.data.externalId?.trim();
                  if (!authUserId) return;
                  if (!('runMutation' in ctx)) {
                    throw new Error(
                      'Polar webhook projection requires mutation-capable auth context'
                    );
                  }

                  await ctx.runMutation(internal.certificateBilling.projectCustomerStateChanged, {
                    authUserId,
                    polarCustomerId: payload.data.id,
                    customerEmail: payload.data.email,
                    activeSubscriptions: payload.data.activeSubscriptions.map(
                      toCertificateBillingProjectionSubscription
                    ),
                    grantedBenefits: payload.data.grantedBenefits.map(
                      toCertificateBillingProjectionBenefitGrant
                    ),
                    activeMeters: payload.data.activeMeters.map(
                      toCertificateBillingProjectionMeter
                    ),
                  });
                },
                onOrderPaid: async (payload) => scheduleCustomerReconciliation(ctx, payload),
                onOrderRefunded: async (payload) => scheduleCustomerReconciliation(ctx, payload),
                onRefundCreated: async (payload) => scheduleCustomerReconciliation(ctx, payload),
                onSubscriptionCanceled: async (payload) =>
                  scheduleCustomerReconciliation(ctx, payload),
                onSubscriptionRevoked: async (payload) =>
                  scheduleCustomerReconciliation(ctx, payload),
                onSubscriptionUncanceled: async (payload) =>
                  scheduleCustomerReconciliation(ctx, payload),
                onBenefitGrantCreated: async (payload) =>
                  scheduleCustomerReconciliation(ctx, payload),
                onBenefitGrantUpdated: async (payload) =>
                  scheduleCustomerReconciliation(ctx, payload),
                onBenefitGrantRevoked: async (payload) =>
                  scheduleCustomerReconciliation(ctx, payload),
                onProductUpdated: async () => {
                  if (!('runMutation' in ctx)) return;
                  await ctx.runMutation(internal.certificateBillingSync.scheduleCatalogSync, {
                    reason: 'product.updated',
                  });
                },
                onBenefitCreated: async () => {
                  if (!('runMutation' in ctx)) return;
                  await ctx.runMutation(internal.certificateBillingSync.scheduleCatalogSync, {
                    reason: 'benefit.created',
                  });
                },
                onBenefitUpdated: async () => {
                  if (!('runMutation' in ctx)) return;
                  await ctx.runMutation(internal.certificateBillingSync.scheduleCatalogSync, {
                    reason: 'benefit.updated',
                  });
                },
              }),
            ],
          }),
        ]
      : [];

  return {
    secret: betterAuthSecret,
    baseURL: siteUrl,
    trustedOrigins,
    database: authComponent.adapter(ctx),
    socialProviders: discordConfig,
    plugins: [
      // oauthProvider depends on the standalone JWT plugin for OAuth/OIDC tokens,
      // while convex() adds the /convex/* JWT endpoints used by the web app.
      // Mount jwt() first so both surfaces stay registered.
      jwt({
        adapter: createJwtJwksAdapter(),
        jwks: {
          keyPairConfig: {
            alg: 'RS256',
          },
        },
        jwt: {
          issuer: authBaseUrl,
          audience: PUBLIC_API_AUDIENCE,
        },
        disableSettingJwtHeader: true,
      }),
      convex({
        authConfig,
        jwksRotateOnTokenGenerationError: true,
      }),
      apiKey({
        defaultPrefix: PUBLIC_API_KEY_PREFIX,
        enableMetadata: true,
        requireName: true,
        enableSessionForAPIKeys: false,
        permissions: {
          defaultPermissions: {
            [PUBLIC_API_KEY_PERMISSION_NAMESPACE]: ['verification:read', 'subjects:read'],
          },
        },
      }),
      oauthProvider({
        loginPage: `${siteUrl.replace(/\/$/, '')}/oauth/login`,
        consentPage: `${siteUrl.replace(/\/$/, '')}/oauth/consent`,
        scopes: ['verification:read', 'cert:issue'],
        validAudiences: [PUBLIC_API_AUDIENCE],
        cachedTrustedClients,
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        grantTypes: ['authorization_code', 'refresh_token'],
        silenceWarnings: {
          oauthAuthServerConfig: true,
        },
        customAccessTokenClaims: async ({ user, scopes }) => ({
          scope: scopes.join(' '),
          auth_user_id: user?.id,
          // Include stable profile data so clients can read identity from
          // the token itself, no extra /v1/me round-trip needed.
          // Industry standard: Auth0, Okta, etc. all embed name/email in
          // first-party access tokens via custom claims.
          name: user?.name ?? null,
          email: user?.email ?? null,
        }),
      }),
      ...polarPlugins,
      vrchat(),
    ],
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // 1 day
      storeSessionInDatabase: true,
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
    advanced: {
      cookiePrefix: 'yucp',
    },
  } satisfies BetterAuthOptions;
};

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  // Cast needed: better-auth 1.5.5 widened baseURL to BaseURLConfig (string | function),
  // but @convex-dev/better-auth@0.11.2 registerRoutes expects string. We always pass a string.
  return betterAuth(createAuthOptions(ctx)) as ReturnType<typeof betterAuth> & {
    options: { baseURL?: string };
  };
};
