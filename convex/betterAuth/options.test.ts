import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { canonicalizeBetterAuthProxyRequest, createAuthOptions } from '../auth';
import {
  PUBLIC_API_AUDIENCE,
} from '@yucp/shared';
import { OAUTH_PROVIDER_SCOPES } from './oauthProviderScopes';
import { createSchemaAuthOptions } from './options';
import { tables } from './schema';

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe('createSchemaAuthOptions', () => {
  const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  const originalConvexSiteUrl = process.env.CONVEX_SITE_URL;
  const originalFrontendUrl = process.env.FRONTEND_URL;
  const originalSiteUrl = process.env.SITE_URL;
  const originalPolarAccessToken = process.env.POLAR_ACCESS_TOKEN;
  const originalPolarWebhookSecret = process.env.POLAR_WEBHOOK_SECRET;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = 'test-secret';
    process.env.CONVEX_SITE_URL = 'https://example.convex.site';
  });

  afterEach(() => {
    restoreEnvironment('BETTER_AUTH_SECRET', originalBetterAuthSecret);
    restoreEnvironment('CONVEX_SITE_URL', originalConvexSiteUrl);
    restoreEnvironment('FRONTEND_URL', originalFrontendUrl);
    restoreEnvironment('SITE_URL', originalSiteUrl);
    restoreEnvironment('POLAR_ACCESS_TOKEN', originalPolarAccessToken);
    restoreEnvironment('POLAR_WEBHOOK_SECRET', originalPolarWebhookSecret);
    globalThis.fetch = originalFetch;
  });

  it('aligns the Better Auth JWT plugin with Convex customJwt RS256 signing', () => {
    const options = createSchemaAuthOptions();
    const jwtPlugin = options.plugins?.find((plugin) => plugin.id === 'jwt') as
      | {
          options?: {
            jwks?: {
              keyPairConfig?: {
                alg?: string;
              };
            };
          };
        }
      | undefined;

    expect(jwtPlugin).toBeDefined();
    expect(jwtPlugin?.options?.jwks?.keyPairConfig?.alg).toBe('RS256');
  });

  it('configures the runtime auth entrypoint with RS256 and Convex JWKS rotation fallback', () => {
    const options = createAuthOptions({} as never);
    const jwtPlugin = options.plugins?.find((plugin) => plugin.id === 'jwt') as
      | {
          options?: {
            jwks?: {
              keyPairConfig?: {
                alg?: string;
              };
            };
            jwt?: {
              issuer?: string;
              audience?: string | string[];
            };
          };
        }
      | undefined;
    const convexPlugin = options.plugins?.find((plugin) => plugin.id === 'convex');

    expect(jwtPlugin?.options?.jwks?.keyPairConfig?.alg).toBe('RS256');
    expect(jwtPlugin?.options?.jwt?.issuer).toBe('https://example.convex.site/api/auth');
    expect(jwtPlugin?.options?.jwt?.audience).toBe(PUBLIC_API_AUDIENCE);
    expect(convexPlugin).toBeDefined();
  });

  it('allows the browser proxy and native auth server hosts', () => {
    process.env.FRONTEND_URL = 'http://localhost:3000';

    const options = createAuthOptions({} as never);
    const oauthPlugin = options.plugins?.find(
      (plugin) => plugin.id === 'oauth-provider'
    ) as
      | {
          options?: {
            consentPage?: string;
            loginPage?: string;
          };
        }
      | undefined;

    expect(options.baseURL).toEqual({
      allowedHosts: ['localhost:3000', 'example.convex.site'],
      fallback: 'https://example.convex.site/api/auth',
    });
    expect(options.advanced?.trustedProxyHeaders).toBeTrue();
    expect(oauthPlugin?.options?.loginPage).toBe('http://localhost:3000/oauth/login');
    expect(oauthPlugin?.options?.consentPage).toBe('http://localhost:3000/oauth/consent');
  });

  it('keeps remembered browser sessions on a sliding 30-day window', () => {
    const options = createAuthOptions({} as never);

    expect(options.session?.expiresIn).toBe(60 * 60 * 24 * 30);
    expect(options.session?.updateAge).toBe(60 * 60 * 24);
    expect(options.session?.disableSessionRefresh).not.toBe(true);
    expect(options.session?.storeSessionInDatabase).toBe(true);
  });

  it('restores the forwarded browser URL before request-bound proof validation', () => {
    const proxied = canonicalizeBetterAuthProxyRequest(
      new Request('https://example.convex.site/api/auth/oauth2/token', {
        method: 'POST',
        headers: {
          host: 'example.convex.site',
          'x-forwarded-host': 'localhost:3000',
          'x-forwarded-proto': 'http',
        },
        body: 'grant_type=authorization_code',
      })
    );
    const direct = canonicalizeBetterAuthProxyRequest(
      new Request('https://example.convex.site/api/auth/oauth2/token', {
        method: 'POST',
        headers: {
          host: 'example.convex.site',
        },
        body: 'grant_type=authorization_code',
      })
    );

    expect(proxied.url).toBe('http://localhost:3000/api/auth/oauth2/token');
    expect(direct.url).toBe('https://example.convex.site/api/auth/oauth2/token');
  });

  it('prefers the prefixed forwarded headers, which survive the Convex platform rewrite', () => {
    const canonical = canonicalizeBetterAuthProxyRequest(
      new Request('https://example.convex.site/v1/products', {
        method: 'GET',
        headers: {
          host: 'example.convex.site',
          'x-better-auth-forwarded-host': 'localhost:3000',
          'x-better-auth-forwarded-proto': 'http',
          'x-forwarded-host': 'example.convex.site',
          'x-forwarded-proto': 'https',
        },
      })
    );

    expect(canonical.url).toBe('http://localhost:3000/v1/products');
  });

  it('enforces the persisted RFC 8707 public API resource', () => {
    expect(new URL(PUBLIC_API_AUDIENCE).protocol).toBe('https:');

    for (const options of [
      createSchemaAuthOptions(),
      createAuthOptions({} as never),
    ]) {
      const oauthPlugin = options.plugins?.find(
        (plugin) => plugin.id === 'oauth-provider'
      ) as
        | {
            options?: {
              enforcePerClientResources?: boolean;
              resourceSeedMode?: string;
              resources?: unknown[];
              validAudiences?: readonly string[];
            };
          }
        | undefined;

      expect(oauthPlugin?.options?.validAudiences).toBeUndefined();
      expect(oauthPlugin?.options?.enforcePerClientResources).toBeTrue();
      expect(oauthPlugin?.options?.resources).toBeUndefined();
      expect(oauthPlugin?.options?.resourceSeedMode).toBeUndefined();
    }
  });

  it('registers refresh-token OAuth scopes in runtime and schema auth options', () => {
    const schemaOptions = createSchemaAuthOptions();
    const runtimeOptions = createAuthOptions({} as never);

    for (const options of [schemaOptions, runtimeOptions]) {
      const oauthPlugin = options.plugins?.find((plugin) => plugin.id === 'oauth-provider') as
        | {
            options?: {
              grantTypes?: readonly string[];
              refreshTokenReuseInterval?: number;
              scopes?: readonly string[];
            };
          }
        | undefined;

      expect(oauthPlugin?.options?.scopes).toEqual([...OAUTH_PROVIDER_SCOPES]);
      expect(oauthPlugin?.options?.scopes).toContain('offline_access');
      expect(oauthPlugin?.options?.grantTypes).toContain('refresh_token');
      expect(oauthPlugin?.options?.refreshTokenReuseInterval).toBe(30);
    }
  });

  it('publishes authorization-server time through Better Auth token response fields', async () => {
    const before = Math.floor(Date.now() / 1000);

    for (const options of [createSchemaAuthOptions(), createAuthOptions({} as never)]) {
      const oauthPlugin = options.plugins?.find(
        (plugin) => plugin.id === 'oauth-provider'
      ) as
        | {
            options?: {
              customTokenResponseFields?: (input: unknown) =>
                | Record<string, unknown>
                | Promise<Record<string, unknown>>;
            };
          }
        | undefined;

      expect(oauthPlugin?.options?.customTokenResponseFields).toBeFunction();
      const fields = await oauthPlugin!.options!.customTokenResponseFields!({});
      const after = Math.floor(Date.now() / 1000);

      expect(Number.isInteger(fields.authorization_server_time)).toBeTrue();
      expect(fields.authorization_server_time).toBeGreaterThanOrEqual(before);
      expect(fields.authorization_server_time).toBeLessThanOrEqual(after);
    }
  });

  it('adds the Polar billing plugin when certificate billing env is configured', () => {
    process.env.POLAR_ACCESS_TOKEN = 'polar-token';
    process.env.POLAR_WEBHOOK_SECRET = 'polar-webhook-secret';

    const options = createAuthOptions({} as never);
    const polarPlugin = options.plugins?.find((plugin) => plugin.id === 'polar');

    expect(polarPlugin).toBeDefined();
  });

  it('does not create a Polar customer on sign-up (customers are created at checkout)', async () => {
    process.env.POLAR_ACCESS_TOKEN = 'polar-token';
    process.env.POLAR_WEBHOOK_SECRET = 'polar-webhook-secret';

    const options = createAuthOptions({} as never);
    const polarPlugin = options.plugins?.find((plugin) => plugin.id === 'polar') as
      | {
          init?: () => {
            options?: {
              databaseHooks?: {
                user?: {
                  create?: {
                    before?: (
                      user: { email: string; name: string; id?: string },
                      context: { context: { logger: Console } }
                    ) => Promise<void>;
                  };
                };
              };
            };
          };
        }
      | undefined;
    const beforeCreateHook = polarPlugin?.init?.()?.options?.databaseHooks?.user?.create?.before;

    expect(beforeCreateHook).toBeDefined();

    let customerCreatePayload:
      | {
          email?: string;
          name?: string | null;
          metadata?: Record<string, unknown>;
        }
      | undefined;

    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const body = await request.text();

      if (
        request.method === 'GET' &&
        request.url.startsWith('https://api.polar.sh/v1/customers/?')
      ) {
        return new Response(
          JSON.stringify({
            items: [],
            pagination: {
              total_count: 0,
              max_page: 1,
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          }
        );
      }

      if (request.method === 'POST' && request.url === 'https://api.polar.sh/v1/customers/') {
        customerCreatePayload = JSON.parse(body) as typeof customerCreatePayload;

        return new Response(
          JSON.stringify({
            id: 'cust_123',
            created_at: '2024-01-01T00:00:00Z',
            modified_at: null,
            metadata: {
              certificate_billing: true,
            },
            external_id: null,
            email: 'person@example.com',
            email_verified: false,
            type: null,
            name: 'Person',
            billing_address: null,
            tax_id: null,
            locale: null,
            organization_id: 'org_123',
            deleted_at: null,
            avatar_url: 'https://example.com/avatar.png',
          }),
          {
            status: 201,
            headers: {
              'content-type': 'application/json',
            },
          }
        );
      }

      throw new Error(`Unexpected Polar request: ${request.method} ${request.url}`);
    };

    await beforeCreateHook!(
      {
        email: 'person@example.com',
        name: 'Person',
        id: undefined,
      },
      {
        context: {
          logger: console,
        },
      }
    );

    // The pair guarantee: sign-up with a synthetic email must never throw.
    await expect(
      beforeCreateHook!(
        {
          email: '123456789012345678@discord.invalid',
          name: 'Emailless Discord User',
          id: undefined,
        },
        {
          context: {
            logger: console,
          },
        }
      )
    ).resolves.toBeUndefined();

    // createCustomerOnSignUp is off: neither invocation may create a Polar
    // customer — creation moved to checkout (keyed on externalCustomerId).
    expect(customerCreatePayload).toBeUndefined();
  });

  it('stores jwks signing metadata in the schema mirror', () => {
    const jwksFields = (tables.jwks as { validator: { fields: Record<string, unknown> } }).validator
      .fields;

    expect(jwksFields.alg).toBeDefined();
    expect(jwksFields.crv).toBeDefined();
  });

  it('normalizes JWKS date fields from numeric Convex storage', async () => {
    const options = createSchemaAuthOptions();
    const jwtPlugin = options.plugins?.find((plugin) => plugin.id === 'jwt') as
      | {
          options?: {
            adapter?: {
              getJwks?: (ctx: {
                context: {
                  adapter: {
                    findMany: (args: { model: string }) => Promise<
                      Array<{
                        alg?: string;
                        createdAt: number;
                        expiresAt: number | null;
                        id: string;
                        privateKey: string;
                        publicKey: string;
                        crv?: string;
                      }>
                    >;
                  };
                };
              }) => Promise<Array<{ createdAt: Date; expiresAt: Date | null }>>;
            };
          };
        }
      | undefined;

    expect(jwtPlugin?.options?.adapter?.getJwks).toBeDefined();

    const keys = await jwtPlugin!.options!.adapter!.getJwks!({
      context: {
        adapter: {
          findMany: async () => [
            {
              alg: 'RS256',
              createdAt: 1_742_600_000_000,
              expiresAt: 1_742_700_000_000,
              id: 'jwk_123',
              privateKey: 'private',
              publicKey: 'public',
            },
          ],
        },
      },
    });

    expect(keys[0]?.alg).toBe('RS256');
    expect(keys[0]?.createdAt).toBeInstanceOf(Date);
    expect(keys[0]?.createdAt.getTime()).toBe(1_742_600_000_000);
    expect(keys[0]?.expiresAt).toBeInstanceOf(Date);
    expect(keys[0]?.expiresAt?.getTime()).toBe(1_742_700_000_000);
  });
});
