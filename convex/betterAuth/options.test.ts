import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createAuthOptions } from '../auth';
import { createSchemaAuthOptions } from './options';
import { tables } from './schema';

describe('createSchemaAuthOptions', () => {
  const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  const originalConvexSiteUrl = process.env.CONVEX_SITE_URL;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = 'test-secret';
    process.env.CONVEX_SITE_URL = 'https://example.convex.site';
  });

  afterEach(() => {
    process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
    process.env.CONVEX_SITE_URL = originalConvexSiteUrl;
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
