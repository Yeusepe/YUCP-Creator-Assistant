/**
 * Better Auth configuration for YUCP Creator Assistant.
 *
 * Convex owns browser auth, JWT issuance, API keys, and OAuth clients. The web
 * The web app proxies `/api/auth/*` to Convex.
 * Convex remains the canonical authorization server for native clients.
 */

import './polyfills';

import { apiKey } from '@better-auth/api-key';
import { oauthProvider } from '@better-auth/oauth-provider';
import { passkey } from '@better-auth/passkey';
import { createClient, type GenericCtx } from '@convex-dev/better-auth';
import { convex } from '@convex-dev/better-auth/plugins';
import { checkout, polar, portal, usage, webhooks } from '@polar-sh/better-auth';
import { Polar } from '@polar-sh/sdk';
import {
  DEFAULT_PUBLIC_API_KEY_SCOPES,
  PUBLIC_API_AUDIENCE,
  PUBLIC_API_KEY_PERMISSION_NAMESPACE,
  PUBLIC_API_KEY_PREFIX,
  verifyRecoveryPasskeyContext,
} from '@yucp/shared';
import type { BetterAuthOptions } from 'better-auth';
import { betterAuth } from 'better-auth';
import { emailOTP, jwt, twoFactor } from 'better-auth/plugins';
import { oneTimeToken } from 'better-auth/plugins/one-time-token';
import { components, internal } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import authConfig from './auth.config';
import { createJwtJwksAdapter } from './betterAuth/jwtAdapter';
import { OAUTH_PROVIDER_SCOPES } from './betterAuth/oauthProviderScopes';
import { betterAuthReservationBridge } from './betterAuth/reservationBridge';
import authSchema from './betterAuth/schema';
import { BETTER_AUTH_BACKUP_CODE_OPTIONS } from './lib/accountSecurityConfig';
import { sendEmailOtpEmail } from './lib/accountSecurityEmail';
import { buildBetterAuthUserLookupWhere } from './lib/betterAuthAdapter';
import { getCertificateBillingConfig } from './lib/certificateBillingConfig';
import {
  toCertificateBillingProjectionBenefitGrant,
  toCertificateBillingProjectionMeter,
  toCertificateBillingProjectionSubscription,
} from './lib/certificateBillingProjection';
import { resolveConfiguredPublicApiBaseUrl } from './lib/publicAuthIssuer';
import { completeRecoveryPasskeyEnrollmentOrThrow } from './lib/recoveryPasskeyCompletion';
import { buildTrustedBrowserOrigins, parseConfiguredTrustedOrigins } from './lib/trustedOrigins';
import { vrchat } from './plugins/vrchat';

let hasLoggedBetterAuthConfig = false;

const REMEMBERED_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const SESSION_REFRESH_AGE_SECONDS = 60 * 60 * 24;

function resolveConvexSiteUrl(): string {
  const explicit = process.env.CONVEX_SITE_URL?.replace(/\/$/, '');
  if (explicit) {
    return explicit;
  }

  const convexUrl = process.env.CONVEX_URL?.replace(/\/$/, '');
  if (convexUrl) {
    return convexUrl.replace('.convex.cloud', '.convex.site');
  }

  throw new Error('CONVEX_SITE_URL or CONVEX_URL is required');
}

function toHostOrNull(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * Every host this auth server legitimately answers on: the frontend origin, the
 * Convex site itself, and the public API origin clients reach it through.
 *
 * Single source of truth for both `baseURL.allowedHosts` and the proxy
 * canonicalization allowlist, so the two cannot drift apart and leave a host
 * that one accepts and the other rejects.
 */
export function resolveAllowedAuthHosts(
  env: Record<string, string | undefined> = process.env
): string[] {
  // Total by construction: this runs on every proxied auth request, so missing
  // configuration has to yield an empty allowlist rather than throw. An empty
  // allowlist simply means no forwarded host is honored.
  const convexSiteUrl =
    env.CONVEX_SITE_URL?.replace(/\/$/, '') ??
    env.CONVEX_URL?.replace(/\/$/, '').replace('.convex.cloud', '.convex.site');

  // Mirrors the siteUrl default in createAuthOptions so the allowlist stays
  // identical to the one Better Auth resolves against.
  const siteUrl =
    env.FRONTEND_URL?.replace(/\/$/, '') ??
    env.SITE_URL?.replace(/\/$/, '') ??
    'http://localhost:3000';

  return [
    ...new Set(
      [
        toHostOrNull(siteUrl),
        toHostOrNull(convexSiteUrl),
        toHostOrNull(resolveConfiguredPublicApiBaseUrl(env)),
      ].filter((host): host is string => Boolean(host))
    ),
  ];
}

/**
 * Restores a trusted proxy URL before Better Auth validates request-bound proofs.
 *
 * Better Auth validates the DPoP `htu` claim against `Request.url`.
 * RFC 9449 requires that URL to identify the endpoint used by the client.
 *
 * `x-forwarded-host` is attacker-controlled input: the Convex site is reachable
 * directly, so anyone can send this header without passing through the proxy.
 * It is honored only for a host this server actually answers on, per the OWASP
 * guidance to validate forwarded hosts against an allowlist. An unrecognized
 * value is ignored rather than rejected, leaving the real request URL in place.
 *
 * References:
 * https://better-auth.com/docs/guides/1-7-upgrade-guide
 * https://better-auth.com/docs/guides/dynamic-base-url
 * https://www.rfc-editor.org/rfc/rfc9449#section-4.3
 * https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/17-Testing_for_Host_Header_Injection
 */
export function canonicalizeBetterAuthProxyRequest(request: Request): Request {
  const requestUrl = new URL(request.url);
  // Convex rewrites the standard x-forwarded-* headers before an httpAction
  // sees them, so on routes the Better Auth component has not preprocessed the
  // proxy's origin only survives under the prefixed names. Prefer those; the
  // standard names still work for requests the component already restored.
  const forwardedHost = (
    request.headers.get('x-better-auth-forwarded-host') ?? request.headers.get('x-forwarded-host')
  )?.trim();
  const forwardedProtocol = (
    request.headers.get('x-better-auth-forwarded-proto') ?? request.headers.get('x-forwarded-proto')
  )?.trim();
  if (!forwardedHost) {
    return request;
  }
  if (!resolveAllowedAuthHosts().includes(forwardedHost)) {
    return request;
  }
  if (
    forwardedProtocol !== undefined &&
    forwardedProtocol !== 'http' &&
    forwardedProtocol !== 'https'
  ) {
    throw new Error('Better Auth proxy protocol is invalid');
  }
  const publicOrigin = `${forwardedProtocol ?? requestUrl.protocol.replace(/:$/, '')}://${forwardedHost}`;
  const canonicalUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, publicOrigin);
  if (canonicalUrl.username || canonicalUrl.password || canonicalUrl.origin !== publicOrigin) {
    throw new Error('Better Auth proxy host is invalid');
  }
  const headers = new Headers(request.headers);
  headers.set('host', canonicalUrl.host);

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }

  return new Request(canonicalUrl, init);
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

function getRecoveryPasskeySecret(): string {
  const secret =
    process.env.ACCOUNT_RECOVERY_CONTEXT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error('BETTER_AUTH_SECRET is required');
  }
  return secret;
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
    additionalOrigins: parseConfiguredTrustedOrigins(
      process.env.BETTER_AUTH_ADDITIONAL_TRUSTED_ORIGINS_JSON
    ),
  });

  if (!hasLoggedBetterAuthConfig) {
    hasLoggedBetterAuthConfig = true;
  }

  const authBaseUrl = `${convexSiteUrl}/api/auth`;
  const reservationBridge = betterAuthReservationBridge({
    reserve: async (input) => {
      if (!('runMutation' in ctx)) {
        throw new Error('Better Auth reservations require a mutation-capable context');
      }
      return await ctx.runMutation(internal.betterAuthReservations.reserve, input);
    },
    find: async (reservationId) => {
      if (!('runQuery' in ctx)) {
        throw new Error('Better Auth reservations require a query-capable context');
      }
      return await ctx.runQuery(internal.betterAuthReservations.find, {
        reservationId,
      });
    },
  });
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
                successUrl: `${siteUrl.replace(/\/$/, '')}/account/billing?checkout_id={CHECKOUT_ID}`,
                returnUrl: `${siteUrl.replace(/\/$/, '')}/account/billing`,
                authenticatedUsersOnly: true,
              }),
              portal({
                returnUrl: `${siteUrl.replace(/\/$/, '')}/account/billing`,
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
    baseURL: {
      // Shared with the proxy canonicalization allowlist. The public API host has
      // to be here because clients reach the auth server through it: Better Auth
      // throws rather than falling back when a resolved host is not listed.
      allowedHosts: resolveAllowedAuthHosts(),
      // Better Auth fallback contract:
      // https://better-auth.com/docs/guides/dynamic-base-url#choosing-a-fallback
      // Direct Convex calls have no request host, so they use the canonical auth server.
      fallback: authBaseUrl,
    },
    trustedOrigins,
    database: authComponent.adapter(ctx),
    user: {
      additionalFields: {
        userId: {
          type: 'string',
          required: false,
          input: false,
          returned: false,
        },
      },
    },
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
      reservationBridge,
      apiKey({
        defaultPrefix: PUBLIC_API_KEY_PREFIX,
        enableMetadata: true,
        requireName: true,
        enableSessionForAPIKeys: false,
        permissions: {
          defaultPermissions: {
            [PUBLIC_API_KEY_PERMISSION_NAMESPACE]: [...DEFAULT_PUBLIC_API_KEY_SCOPES],
          },
        },
      }),
      oauthProvider({
        loginPage: `${siteUrl.replace(/\/$/, '')}/oauth/login`,
        consentPage: `${siteUrl.replace(/\/$/, '')}/oauth/consent`,
        scopes: [...OAUTH_PROVIDER_SCOPES],
        cachedResources: new Set([PUBLIC_API_AUDIENCE]),
        enforcePerClientResources: true,
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
      // Better Auth one-time token reference:
      // https://better-auth.com/docs/plugins/one-time-token
      oneTimeToken({
        expiresIn: 1,
        storeToken: 'hashed',
      }),
      emailOTP({
        expiresIn: 5 * 60,
        allowedAttempts: 3,
        storeOTP: 'hashed',
        rateLimit: {
          window: 60,
          max: 3,
        },
        disableSignUp: true,
        sendVerificationOTP: async ({ email, otp, type }) => {
          await sendEmailOtpEmail({
            email,
            otp,
            type,
          });
        },
      }),
      twoFactor({
        allowPasswordless: true,
        skipVerificationOnEnable: true,
        issuer: 'Creator Assistant',
        backupCodeOptions: BETTER_AUTH_BACKUP_CODE_OPTIONS,
      }),
      passkey({
        origin: trustedOrigins,
        rpID: new URL(siteUrl).hostname,
        rpName: 'Creator Assistant',
        registration: {
          requireSession: false,
          resolveUser: async ({ context }) => {
            if (!context) {
              throw new Error('Recovery passkey context is required');
            }

            const payload = await verifyRecoveryPasskeyContext(
              context,
              getRecoveryPasskeySecret(),
              Date.now()
            );
            if (!payload) {
              throw new Error('Invalid or expired recovery passkey context');
            }

            const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
              model: 'user',
              where: buildBetterAuthUserLookupWhere(payload.authUserId),
              select: ['id', 'name'],
            })) as { id?: string; _id?: string; name?: string | null } | null;

            const userId = user?.id ?? user?._id ?? null;
            if (!userId || typeof userId !== 'string') {
              throw new Error('Recovery user not found');
            }

            return {
              id: userId,
              name: user?.name?.trim() || 'Recovered account',
            };
          },
          afterVerification: async ({ context, user }) => {
            if (!context) {
              return;
            }

            const payload = await verifyRecoveryPasskeyContext(
              context,
              getRecoveryPasskeySecret(),
              Date.now()
            );
            if (!payload) {
              return;
            }

            if (!('runMutation' in ctx)) {
              throw new Error(
                'Recovery passkey completion requires a mutation-capable auth context'
              );
            }

            await completeRecoveryPasskeyEnrollmentOrThrow(
              (args) =>
                ctx.runMutation(internal.accountSecurity.completeRecoveryPasskeyEnrollment, args),
              {
                authUserId: user.id,
                contextNonce: payload.nonce,
                method: payload.method,
                completedAt: Date.now(),
              }
            );
          },
        },
      }),
      ...polarPlugins,
      vrchat(),
    ],
    session: {
      // Better Auth session renewal contract:
      // https://better-auth.com/docs/concepts/session-management#session-expiration
      expiresIn: REMEMBERED_SESSION_TTL_SECONDS,
      updateAge: SESSION_REFRESH_AGE_SECONDS,
      storeSessionInDatabase: true,
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
    advanced: {
      cookiePrefix: 'yucp',
      trustedProxyHeaders: true,
    },
  } satisfies BetterAuthOptions;
};

export const createAuth = (ctx: GenericCtx<DataModel>): ReturnType<typeof betterAuth> => {
  const options = createAuthOptions(ctx);
  const auth = betterAuth(options);
  const handler = (request: Request) => auth.handler(canonicalizeBetterAuthProxyRequest(request));

  return {
    ...auth,
    handler,
    fetch: handler,
  } as ReturnType<typeof betterAuth>;
};
