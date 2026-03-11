import { afterEach, describe, expect, it } from 'bun:test';
import { resolveConvexSiteUrl, resolveSiteUrl } from './env';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveConvexSiteUrl', () => {
  it('prefers CONVEX_SITE_URL when provided', () => {
    expect(
      resolveConvexSiteUrl({
        CONVEX_SITE_URL: 'https://rare-squid-409.convex.site/',
        CONVEX_URL: 'https://ignored.convex.cloud',
      })
    ).toBe('https://rare-squid-409.convex.site');
  });

  it('derives the site host from CONVEX_URL', () => {
    expect(
      resolveConvexSiteUrl({
        CONVEX_URL: 'https://rare-squid-409.convex.cloud',
      })
    ).toBe('https://rare-squid-409.convex.site');
  });
});

describe('resolveSiteUrl', () => {
  it('prefers SITE_URL over legacy aliases', () => {
    expect(
      resolveSiteUrl({
        SITE_URL: 'https://creators.yucp.club/',
        FRONTEND_URL: 'https://legacy.example.com',
        BETTER_AUTH_URL: 'https://auth.example.com',
      })
    ).toBe('https://creators.yucp.club');
  });

  it('falls back to FRONTEND_URL and then legacy envs', () => {
    expect(
      resolveSiteUrl({
        FRONTEND_URL: 'https://frontend.example.com/',
      })
    ).toBe('https://frontend.example.com');

    expect(
      resolveSiteUrl({
        RENDER_EXTERNAL_URL: 'https://render.example.com/',
      })
    ).toBe('https://render.example.com');
  });
});
