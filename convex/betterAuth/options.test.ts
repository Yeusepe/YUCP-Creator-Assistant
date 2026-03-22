import { describe, expect, it } from 'bun:test';
import { createSchemaAuthOptions } from './options';

describe('createSchemaAuthOptions', () => {
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
                        createdAt: number;
                        expiresAt: number | null;
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
              createdAt: 1_742_600_000_000,
              expiresAt: 1_742_700_000_000,
            },
          ],
        },
      },
    });

    expect(keys[0]?.createdAt).toBeInstanceOf(Date);
    expect(keys[0]?.createdAt.getTime()).toBe(1_742_600_000_000);
    expect(keys[0]?.expiresAt).toBeInstanceOf(Date);
    expect(keys[0]?.expiresAt?.getTime()).toBe(1_742_700_000_000);
  });
});
