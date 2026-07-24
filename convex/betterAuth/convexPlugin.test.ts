import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AuthConfig } from 'convex/server';
import { createConvexBetterAuthPlugin } from './convexPlugin';

describe('createConvexBetterAuthPlugin', () => {
  const originalConvexSiteUrl = process.env.CONVEX_SITE_URL;

  beforeEach(() => {
    process.env.CONVEX_SITE_URL = 'https://example.convex.site';
  });

  afterEach(() => {
    process.env.CONVEX_SITE_URL = originalConvexSiteUrl;
  });

  it('provides Convex JWT endpoints without mounting a second OAuth provider', () => {
    const authConfig = {
      providers: [
        {
          algorithm: 'RS256',
          applicationID: 'convex',
          issuer: 'https://example.convex.site',
          jwks: 'https://example.convex.site/api/auth/convex/jwks',
          type: 'customJwt',
        },
      ],
    } satisfies AuthConfig;

    const plugin = createConvexBetterAuthPlugin({
      authConfig,
      jwksRotateOnTokenGenerationError: true,
    });

    expect(plugin.id).toBe('convex');
    expect(Object.keys(plugin.endpoints ?? {}).sort()).toEqual([
      'getJwks',
      'getLatestJwks',
      'getOpenIdConfig',
      'getToken',
      'rotateKeys',
    ]);
    expect(Object.keys(plugin.schema ?? {})).toEqual(['user', 'jwks']);
    expect(Object.keys(plugin.schema ?? {})).not.toContain('oauthClient');
  });

  it('fails when the Convex JWT provider is absent', () => {
    expect(() =>
      createConvexBetterAuthPlugin({
        authConfig: { providers: [] },
      })
    ).toThrow("No auth provider with applicationID 'convex' found");
  });
});
