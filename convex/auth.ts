/**
 * Better Auth configuration for YUCP Creator Assistant
 * Runs on Convex with Discord OAuth and cross-domain support.
 *
 * The cross-domain plugin is required because the Bun API server (localhost:3001)
 * is on a different domain than Convex (.convex.site). It handles:
 * - Custom cookie headers (Set-Better-Auth-Cookie / Better-Auth-Cookie)
 * - One-time-token (OTT) pattern for OAuth callbacks
 * - State verification via database instead of cookies
 */

import './polyfills';

import { oauthProvider } from '@better-auth/oauth-provider';
import { createClient } from '@convex-dev/better-auth';
import type { GenericCtx } from '@convex-dev/better-auth';
import { convex, crossDomain } from '@convex-dev/better-auth/plugins';
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { apiKey, jwt } from 'better-auth/plugins';
import { components } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import authConfig from './auth.config';
import authSchema from './betterAuth/schema';
import { vrchat } from './plugins/vrchat';

const PUBLIC_API_AUDIENCE = 'yucp-public-api';
const PUBLIC_API_KEY_PREFIX = 'ypsk_';
const PUBLIC_API_KEY_PERMISSION_NAMESPACE = 'publicApi';
let hasLoggedIgnoredBetterAuthUrl = false;
let hasLoggedBetterAuthConfig = false;

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

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

export const createAuthOptions = (ctx: GenericCtx<DataModel>): BetterAuthOptions => {
  const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
  if (!betterAuthSecret) {
    throw new Error('BETTER_AUTH_SECRET is required');
  }

  const convexSiteUrl = resolveConvexSiteUrl();
  const siteUrl =
    process.env.SITE_URL?.replace(/\/$/, '') ??
    process.env.FRONTEND_URL?.replace(/\/$/, '') ??
    'http://localhost:3001';
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

  const trustedOrigins = Array.from(
    new Set(
      [
        siteUrl,
        process.env.FRONTEND_URL,
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173',
      ]
        .map(normalizeOrigin)
        .filter((origin): origin is string => Boolean(origin))
    )
  );

  const legacyBetterAuthOrigin = normalizeOrigin(process.env.BETTER_AUTH_URL);
  const authOrigin = normalizeOrigin(convexSiteUrl);
  if (
    legacyBetterAuthOrigin &&
    legacyBetterAuthOrigin !== authOrigin &&
    !hasLoggedIgnoredBetterAuthUrl
  ) {
    hasLoggedIgnoredBetterAuthUrl = true;
    console.warn(
      `BETTER_AUTH_URL (${legacyBetterAuthOrigin}) is ignored; Better Auth runs on ${authOrigin}`
    );
  }

  if (!hasLoggedBetterAuthConfig) {
    hasLoggedBetterAuthConfig = true;
    console.log('Better Auth config', {
      siteUrl,
      authBaseUrl: `${convexSiteUrl}/api/auth`,
      betterAuthUrl: process.env.BETTER_AUTH_URL ?? null,
      frontendUrl: process.env.FRONTEND_URL ?? null,
      trustedOrigins,
    });
  }

  const authBaseUrl = `${convexSiteUrl}/api/auth`;
  const cachedTrustedClients = parseCachedTrustedClients(
    process.env.PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON
  );

  return {
    secret: betterAuthSecret,
    baseURL: convexSiteUrl,
    trustedOrigins,
    database: authComponent.adapter(ctx),
    socialProviders: discordConfig,
    plugins: [
      crossDomain({ siteUrl }),
      convex({ authConfig }),
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
      jwt({
        jwks: {
          keyPairConfig: { alg: 'ES256' },
        },
        jwt: {
          issuer: authBaseUrl,
          audience: PUBLIC_API_AUDIENCE,
        },
        disableSettingJwtHeader: true,
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
        customAccessTokenClaims: async ({ user, scopes }) => ({
          scope: scopes.join(' '),
          auth_user_id: user?.id,
          // Include stable profile data so clients can read identity from
          // the token itself — no extra /v1/me round-trip needed.
          // Industry standard: Auth0, Okta, etc. all embed name/email in
          // first-party access tokens via custom claims.
          name: user?.name ?? null,
          email: user?.email ?? null,
        }),
      }),
      vrchat(),
    ],
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // 1 day
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

export const createAuth = (ctx: GenericCtx<DataModel>) => betterAuth(createAuthOptions(ctx));
