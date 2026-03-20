import { describe, expect, it } from 'vitest';
import { resolveBrowserAuthBaseUrl } from '@/lib/runtimeConfig';

describe('resolveBrowserAuthBaseUrl', () => {
  it('prefers the current SSR request origin over configured env origins', () => {
    expect(
      resolveBrowserAuthBaseUrl({
        requestUrl: 'http://localhost:3000/sign-in?redirectTo=%2Fdashboard',
        siteUrl: 'http://localhost:3001',
        frontendUrl: 'http://localhost:3001',
      })
    ).toBe('http://localhost:3000');
  });

  it('falls back to FRONTEND_URL when the request URL and SITE_URL are missing or invalid', () => {
    expect(
      resolveBrowserAuthBaseUrl({
        requestUrl: 'not-a-url',
        siteUrl: 'not-a-url',
        frontendUrl: 'http://localhost:3001/dashboard',
      })
    ).toBe('http://localhost:3001');
  });

  it('uses the provided fallback when no configured origin is valid', () => {
    expect(
      resolveBrowserAuthBaseUrl({
        requestUrl: undefined,
        siteUrl: undefined,
        frontendUrl: undefined,
        fallback: 'http://localhost:4321/path',
      })
    ).toBe('http://localhost:4321');
  });
});
