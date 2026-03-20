import { describe, expect, it } from 'bun:test';
import { buildAllowedBrowserOrigins, buildTrustedBrowserOrigins } from '../src/authOrigins';

describe('auth browser origins', () => {
  it('allows the local TanStack web origin when configured browser URLs are localhost', () => {
    expect(
      buildAllowedBrowserOrigins({
        siteUrl: 'http://localhost:3001',
        frontendUrl: 'http://localhost:3001',
      })
    ).toContain('http://localhost:3000');
  });

  it('adds localhost wildcard patterns for Better Auth when browser URLs are local', () => {
    expect(
      buildTrustedBrowserOrigins({
        siteUrl: 'http://localhost:3001',
        frontendUrl: 'http://localhost:3001',
      })
    ).toContain('http://localhost:*');
  });

  it('does not trust localhost in production browser-origin configs', () => {
    const trustedOrigins = buildTrustedBrowserOrigins({
      siteUrl: 'https://verify.creators.yucp.club',
      frontendUrl: 'https://verify.creators.yucp.club',
    });

    expect(trustedOrigins).toContain('https://verify.creators.yucp.club');
    expect(trustedOrigins).not.toContain('http://localhost:*');
  });
});
