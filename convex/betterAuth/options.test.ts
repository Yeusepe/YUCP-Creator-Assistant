import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createAuthOptions } from '../auth';
import { createSchemaAuthOptions } from './options';
import { tables } from './schema';

describe('createSchemaAuthOptions', () => {
  const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  const originalConvexSiteUrl = process.env.CONVEX_SITE_URL;
  const originalPolarAccessToken = process.env.POLAR_ACCESS_TOKEN;
  const originalPolarWebhookSecret = process.env.POLAR_WEBHOOK_SECRET;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = 'test-secret';
    process.env.CONVEX_SITE_URL = 'https://example.convex.site';
  });

  afterEach(() => {
    process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
    process.env.CONVEX_SITE_URL = originalConvexSiteUrl;
    process.env.POLAR_ACCESS_TOKEN = originalPolarAccessToken;
    process.env.POLAR_WEBHOOK_SECRET = originalPolarWebhookSecret;
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
    expect(jwtPlugin?.options?.jwt?.audience).toBe('yucp-public-api');
    expect(convexPlugin).toBeDefined();
  });

  it('adds the Polar billing plugin when certificate billing env is configured', () => {
    process.env.POLAR_ACCESS_TOKEN = 'polar-token';
    process.env.POLAR_WEBHOOK_SECRET = 'polar-webhook-secret';

    const options = createAuthOptions({} as never);
    const polarPlugin = options.plugins?.find((plugin) => plugin.id === 'polar');

    expect(polarPlugin).toBeDefined();
  });

  it('omits yucp_user_id metadata until Better Auth has created the user id', async () => {
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

    expect(customerCreatePayload).toMatchObject({
      email: 'person@example.com',
      name: 'Person',
      metadata: {
        certificate_billing: true,
      },
    });
    expect(customerCreatePayload?.metadata?.yucp_user_id).toBeUndefined();
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
