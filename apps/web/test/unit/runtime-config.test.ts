import { describe, expect, it } from 'vitest';
import { resolveBrowserAuthBaseUrl } from '@/lib/runtimeConfig';

describe('resolveBrowserAuthBaseUrl', () => {
  it('prefers SITE_URL over FRONTEND_URL and normalizes to origin', () => {
    expect(
      resolveBrowserAuthBaseUrl({
        siteUrl: 'https://verify.creators.yucp.club/sign-in?redirectTo=%2Fdashboard',
        frontendUrl: 'http://localhost:3000',
      })
    ).toBe('https://verify.creators.yucp.club');
  });

  it('falls back to FRONTEND_URL when SITE_URL is missing or invalid', () => {
    expect(
      resolveBrowserAuthBaseUrl({
        siteUrl: 'not-a-url',
        frontendUrl: 'http://localhost:3001/dashboard',
      })
    ).toBe('http://localhost:3001');
  });

  it('uses the provided fallback when no configured origin is valid', () => {
    expect(
      resolveBrowserAuthBaseUrl({
        siteUrl: undefined,
        frontendUrl: undefined,
        fallback: 'http://localhost:4321/path',
      })
    ).toBe('http://localhost:4321');
  });
});
