/**
 * Convex JWT bridge for Better Auth 1.7.
 *
 * This adapter preserves the supported Convex Better Auth 0.12.5 JWT contract.
 * It does not mount the removed Better Auth OIDC provider.
 *
 * Upstream source:
 * https://github.com/get-convex/better-auth/blob/v0.12.5/src/plugins/convex/index.ts
 * Better Auth migration:
 * https://better-auth.com/docs/guides/1-7-upgrade-guide
 *
 * The adapted upstream implementation is licensed under Apache-2.0.
 */
import type { BetterAuthPlugin, Session, User } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth/minimal';
import { createAuthEndpoint, createAuthMiddleware, sessionMiddleware } from 'better-auth/api';
import { bearer as bearerPlugin } from 'better-auth/plugins/bearer';
import { jwt as jwtPlugin } from 'better-auth/plugins/jwt';
import type { Jwk, JwtOptions } from 'better-auth/plugins/jwt';
import { omit } from 'convex-helpers';
import type { AuthConfig, AuthProvider } from 'convex/server';

export const CONVEX_JWT_COOKIE_NAME = 'convex_jwt';
const PLUGIN_VERSION = '0.12.5-yucp.1';

export interface ConvexBetterAuthPluginOptions {
  authConfig: AuthConfig;
  jwt?: {
    expirationSeconds?: number;
    definePayload?: (session: {
      user: User & Record<string, unknown>;
      session: Session & Record<string, unknown>;
    }) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  };
  jwtExpirationSeconds?: number;
  jwks?: string;
  jwksRotateOnTokenGenerationError?: boolean;
  options?: BetterAuthOptions;
}

function requireConvexSiteUrl(): string {
  const value = process.env.CONVEX_SITE_URL?.trim().replace(/\/$/, '');
  if (!value) {
    throw new Error('CONVEX_SITE_URL is required for the Convex Better Auth plugin');
  }
  return value;
}

function getJwksAlgorithm(authProvider: AuthProvider): 'EdDSA' | 'RS256' {
  const isCustomJwt = 'type' in authProvider && authProvider.type === 'customJwt';
  if (isCustomJwt && authProvider.algorithm !== 'RS256') {
    throw new Error('Only RS256 is supported for custom JWT with Better Auth');
  }
  return isCustomJwt ? 'RS256' : 'EdDSA';
}

function parseAuthProvider(
  authConfig: AuthConfig,
  options: Pick<ConvexBetterAuthPluginOptions, 'jwks'>
): AuthProvider {
  const providers = authConfig.providers.filter((provider) => provider.applicationID === 'convex');
  if (providers.length > 1) {
    throw new Error("Multiple auth providers with applicationID 'convex' detected");
  }
  const provider = providers[0];
  if (!provider) {
    throw new Error("No auth provider with applicationID 'convex' found");
  }
  if (!('type' in provider) || provider.type !== 'customJwt') {
    return provider;
  }

  const usesStaticJwks = provider.jwks?.startsWith('data:text/');
  if (usesStaticJwks && !options.jwks) {
    throw new Error('Static JWKS exists in auth config, but the Convex plugin has no JWKS');
  }
  if (!usesStaticJwks && options.jwks) {
    console.warn('Static JWKS was provided only to the Convex Better Auth plugin');
  }
  return provider;
}

function asDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function isJoseAlgorithmError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ERR_JOSE_NOT_SUPPORTED'
  );
}

export function createConvexBetterAuthPlugin(
  options: ConvexBetterAuthPluginOptions
): BetterAuthPlugin {
  const siteUrl = requireConvexSiteUrl();
  const basePath = options.options?.basePath ?? '/api/auth';
  const provider = parseAuthProvider(options.authConfig, options);
  const algorithm = getJwksAlgorithm(provider);
  const jwtExpirationSeconds =
    options.jwt?.expirationSeconds ?? options.jwtExpirationSeconds ?? 15 * 60;
  const parsedStaticJwks = options.jwks ? JSON.parse(options.jwks) : undefined;
  const jwtOptions = {
    jwt: {
      audience: 'convex',
      definePayload: async ({ user, session }) => ({
        ...(options.jwt?.definePayload
          ? await options.jwt.definePayload({ user, session })
          : omit(user, ['id', 'image'])),
        iat: Math.floor(Date.now() / 1000),
        sessionId: session.id,
      }),
      expirationTime: `${jwtExpirationSeconds}s`,
      issuer: siteUrl,
    },
    jwks: {
      keyPairConfig: {
        alg: algorithm,
      },
    },
  } satisfies JwtOptions;

  const jwt = jwtPlugin({
    ...jwtOptions,
    adapter: {
      createJwk: async (webKey, ctx) => {
        if (options.jwks) {
          throw new Error('Static JWKS cannot create a new key');
        }
        return ctx.context.adapter.create<Omit<Jwk, 'id'>, Jwk>({
          data: {
            ...webKey,
            createdAt: new Date(),
          },
          model: 'jwks',
        });
      },
      getJwks: async (ctx) => {
        if (options.jwks) {
          return parsedStaticJwks;
        }
        const keys = await ctx.context.adapter.findMany<Jwk>({
          model: 'jwks',
          sortBy: {
            direction: 'desc',
            field: 'createdAt',
          },
        });
        return keys.map((key) => ({
          ...key,
          createdAt: asDate(key.createdAt),
          ...(key.expiresAt ? { expiresAt: asDate(key.expiresAt) } : {}),
        }));
      },
    },
  });
  const bearer = bearerPlugin();

  const latestJwk = async (ctx: {
    context: {
      adapter: {
        findMany: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
      };
    };
  }): Promise<Array<Record<string, unknown>>> => {
    const keys = await ctx.context.adapter.findMany({
      limit: 1,
      model: 'jwks',
      sortBy: {
        direction: 'desc',
        field: 'createdAt',
      },
    });
    const key = keys[0];
    if (!key) {
      throw new Error('Better Auth did not create a JWKS entry');
    }
    key.alg = algorithm;
    return keys;
  };

  const createJwkIfMissing = async (ctx: Parameters<typeof latestJwk>[0]): Promise<void> => {
    await jwtPlugin(jwtOptions).endpoints.getJwks({
      ...ctx,
      asResponse: false,
      method: 'GET',
      returnHeaders: false,
      returnStatus: false,
    } as never);
  };

  const schema = {
    user: {
      fields: {
        userId: {
          input: false,
          required: false,
          type: 'string',
        },
      },
    },
    ...jwt.schema,
  } as const;

  return {
    id: 'convex',
    version: PLUGIN_VERSION,
    init: (ctx) => {
      if (ctx.options.basePath !== '/api/auth' && !options.options?.basePath) {
        console.warn('Better Auth basePath differs from the Convex plugin default');
      }
      if (options.options?.basePath && ctx.options.basePath !== options.options.basePath) {
        console.warn('Better Auth basePath does not match the Convex plugin basePath');
      }
    },
    hooks: {
      before: [
        ...bearer.hooks.before,
        {
          matcher: (ctx) => !ctx.context.adapter.options?.isRunMutationCtx,
          handler: createAuthMiddleware(async (ctx) => {
            ctx.query = { ...ctx.query, disableRefresh: true };
            ctx.context.internalAdapter.deleteSession = async () => undefined;
            const knownSafePaths = ['/api-key/list', '/api-key/get'];
            const skipWrite = (method: string) => async () => {
              if (ctx.path && !knownSafePaths.includes(ctx.path)) {
                console.warn(
                  `[convex-better-auth] Write operation "${method}" skipped in query context for ${ctx.path}`
                );
              }
              return 0;
            };
            ctx.context.adapter.create = skipWrite('create') as never;
            ctx.context.adapter.update = skipWrite('update') as never;
            ctx.context.adapter.updateMany = skipWrite('updateMany') as never;
            ctx.context.adapter.delete = skipWrite('delete') as never;
            ctx.context.adapter.deleteMany = skipWrite('deleteMany') as never;
            return { context: ctx };
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            Boolean(
              ctx.path?.startsWith('/sign-in') ||
                ctx.path?.startsWith('/sign-up') ||
                ctx.path?.startsWith('/callback') ||
                ctx.path?.startsWith('/oauth2/callback') ||
                ctx.path?.startsWith('/magic-link/verify') ||
                ctx.path?.startsWith('/email-otp/verify-email') ||
                ctx.path?.startsWith('/phone-number/verify') ||
                ctx.path?.startsWith('/siwe/verify') ||
                ctx.path?.startsWith('/update-session') ||
                (ctx.path?.startsWith('/get-session') && ctx.context.session)
            ),
          handler: createAuthMiddleware(async (ctx) => {
            const originalSession = ctx.context.session;
            try {
              ctx.context.session = ctx.context.session ?? ctx.context.newSession;
              const { token } = await jwt.endpoints.getToken({
                ...ctx,
                asResponse: false,
                headers: {},
                method: 'GET',
                returnHeaders: false,
                returnStatus: false,
              });
              const cookie = ctx.context.createAuthCookie(CONVEX_JWT_COOKIE_NAME, {
                maxAge: jwtExpirationSeconds,
              });
              ctx.setCookie(cookie.name, token, cookie.attributes);
            } catch {
              // Some sign-in calls require another verification step.
            }
            ctx.context.session = originalSession;
          }),
        },
        {
          matcher: (ctx) =>
            Boolean(
              ctx.path?.startsWith('/sign-out') ||
                ctx.path?.startsWith('/delete-user') ||
                (ctx.path?.startsWith('/get-session') && !ctx.context.session)
            ),
          handler: createAuthMiddleware(async (ctx) => {
            const cookie = ctx.context.createAuthCookie(CONVEX_JWT_COOKIE_NAME, {
              maxAge: 0,
            });
            ctx.setCookie(cookie.name, '', cookie.attributes);
          }),
        },
      ],
    },
    endpoints: {
      getOpenIdConfig: createAuthEndpoint(
        '/convex/.well-known/openid-configuration',
        {
          metadata: {
            isAction: false,
          },
          method: 'GET',
        },
        async (ctx) => {
          const authBaseUrl = ctx.context.baseURL.replace(/\/$/, '');
          return {
            authorization_endpoint: `${authBaseUrl}/oauth2/authorize`,
            claims_supported: [
              'sub',
              'iss',
              'aud',
              'exp',
              'iat',
              'email',
              'email_verified',
              'name',
            ],
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            id_token_signing_alg_values_supported: [algorithm],
            issuer: siteUrl,
            jwks_uri: `${siteUrl}${basePath}/convex/jwks`,
            response_types_supported: ['code'],
            scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
            subject_types_supported: ['public'],
            token_endpoint: `${authBaseUrl}/oauth2/token`,
            token_endpoint_auth_methods_supported: [
              'client_secret_basic',
              'client_secret_post',
              'none',
            ],
            userinfo_endpoint: `${authBaseUrl}/oauth2/userinfo`,
          };
        }
      ),
      getJwks: createAuthEndpoint(
        '/convex/jwks',
        {
          metadata: {
            openapi: {
              description: 'Get the JSON Web Key Set',
            },
          },
          method: 'GET',
        },
        async (ctx) =>
          jwt.endpoints.getJwks({
            ...ctx,
            asResponse: false,
            returnHeaders: false,
            returnStatus: false,
          })
      ),
      getLatestJwks: createAuthEndpoint(
        '/convex/latest-jwks',
        {
          isAction: true,
          metadata: {
            SERVER_ONLY: true,
            openapi: {
              description: 'Create and return the latest JWKS',
            },
          },
          method: 'POST',
        },
        async (ctx) => {
          await createJwkIfMissing(ctx as never);
          return latestJwk(ctx as never);
        }
      ),
      rotateKeys: createAuthEndpoint(
        '/convex/rotate-keys',
        {
          isAction: true,
          metadata: {
            SERVER_ONLY: true,
            openapi: {
              description: 'Rotate and return the latest JWKS',
            },
          },
          method: 'POST',
        },
        async (ctx) => {
          await ctx.context.adapter.deleteMany({
            model: 'jwks',
            where: [],
          });
          await createJwkIfMissing(ctx as never);
          return latestJwk(ctx as never);
        }
      ),
      getToken: createAuthEndpoint(
        '/convex/token',
        {
          metadata: {
            openapi: {
              description: 'Get a Convex JWT token',
            },
          },
          method: 'GET',
          requireHeaders: true,
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const runEndpoint = async () => {
            const response = await jwt.endpoints.getToken({
              ...ctx,
              asResponse: false,
              returnHeaders: false,
              returnStatus: false,
            });
            const cookie = ctx.context.createAuthCookie(CONVEX_JWT_COOKIE_NAME, {
              maxAge: jwtExpirationSeconds,
            });
            ctx.setCookie(cookie.name, response.token, cookie.attributes);
            return response;
          };

          try {
            return await runEndpoint();
          } catch (error) {
            if (!options.jwks && isJoseAlgorithmError(error)) {
              if (options.jwksRotateOnTokenGenerationError) {
                await ctx.context.adapter.deleteMany({
                  model: 'jwks',
                  where: [],
                });
                return runEndpoint();
              }
              console.error('Set jwksRotateOnTokenGenerationError during a signing algorithm change');
            }
            throw error;
          }
        }
      ),
    },
    schema,
  } satisfies BetterAuthPlugin;
}
