import { describe, expect, it } from 'bun:test';
import { getConfiguredConvexSiteUrlForProxy } from './convexSiteProxy';

describe('getConfiguredConvexSiteUrlForProxy', () => {
  it('uses the resolved env value instead of raw process.env state', () => {
    const original = process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_SITE_URL;

    try {
      expect(
        getConfiguredConvexSiteUrlForProxy({
          CONVEX_SITE_URL: 'https://rare-squid-409.convex.site/',
        })
      ).toBe('https://rare-squid-409.convex.site');
    } finally {
      if (original === undefined) {
        delete process.env.CONVEX_SITE_URL;
      } else {
        process.env.CONVEX_SITE_URL = original;
      }
    }
  });

  it('throws when the resolved env does not include a Convex site URL', () => {
    expect(() => getConfiguredConvexSiteUrlForProxy({ CONVEX_SITE_URL: undefined })).toThrow(
      'CONVEX_SITE_URL must be set for Convex auth proxying'
    );
  });
});
