import { describe, expect, it } from 'bun:test';
import { resolvePublicRuntimeOrigins } from './publicRuntimeOrigins';

describe('resolvePublicRuntimeOrigins', () => {
  it('keeps the canonical API resource origin separate from the browser frontend origin', () => {
    expect(
      resolvePublicRuntimeOrigins({
        API_BASE_URL: 'https://api.creators.yucp.club/',
        FRONTEND_URL: 'https://verify.creators.yucp.club/',
        NODE_ENV: 'production',
        SITE_URL: 'https://verify.creators.yucp.club/',
      })
    ).toEqual({
      frontendUrl: 'https://verify.creators.yucp.club',
      publicApiBaseUrl: 'https://api.creators.yucp.club',
      siteUrl: 'https://verify.creators.yucp.club',
    });
  });

  it('refuses a production startup that would verify DPoP against localhost', () => {
    expect(() =>
      resolvePublicRuntimeOrigins({
        FRONTEND_URL: 'https://verify.creators.yucp.club',
        NODE_ENV: 'production',
        SITE_URL: 'https://verify.creators.yucp.club',
      })
    ).toThrow('API_BASE_URL must be configured in production');
  });

  it('keeps the local development fallback explicit', () => {
    expect(resolvePublicRuntimeOrigins({ NODE_ENV: 'development' })).toEqual({
      frontendUrl: 'http://localhost:3001',
      publicApiBaseUrl: 'http://localhost:3001',
      siteUrl: 'http://localhost:3001',
    });
  });
});
