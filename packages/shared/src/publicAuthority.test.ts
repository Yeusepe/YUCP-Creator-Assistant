import { describe, expect, it } from 'bun:test';
import {
  buildPublicAuthIssuer,
  normalizePublicApiBaseUrl,
  resolveConfiguredApiBaseUrl,
} from './publicAuthority';

describe('publicAuthority', () => {
  it('requires API_BASE_URL instead of falling back to SITE_URL', () => {
    expect(
      resolveConfiguredApiBaseUrl({
        API_BASE_URL: undefined,
        SITE_URL: 'https://dsktp.tailc472f7.ts.net',
      })
    ).toBe('');
  });

  it('normalizes a configured API_BASE_URL', () => {
    expect(
      resolveConfiguredApiBaseUrl({
        API_BASE_URL: 'https://api.creators.yucp.club/',
      })
    ).toBe('https://api.creators.yucp.club');
  });

  it('preserves configured base paths when building the public auth issuer', () => {
    expect(buildPublicAuthIssuer('https://api.creators.yucp.club/license-gate/')).toBe(
      'https://api.creators.yucp.club/license-gate/api/auth'
    );
  });

  it('rejects unsupported URL schemes', () => {
    expect(() => normalizePublicApiBaseUrl('ftp://api.creators.yucp.club')).toThrow(
      'API_BASE_URL must use http or https'
    );
  });
});
