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

  it('adds explicit loopback origins instead of wildcard patterns when browser URLs are local', () => {
    const trustedOrigins = buildTrustedBrowserOrigins({
      siteUrl: 'http://localhost:3001',
      frontendUrl: 'http://localhost:3001',
    });

    expect(trustedOrigins).toContain('http://localhost:3000');
    expect(trustedOrigins).toContain('http://localhost:3001');
    expect(trustedOrigins).toContain('http://127.0.0.1:3000');
    expect(trustedOrigins).not.toContain('http://localhost:*');
    expect(trustedOrigins).not.toContain('https://localhost:*');
  });

  it('does not trust localhost in production browser-origin configs', () => {
    const trustedOrigins = buildTrustedBrowserOrigins({
      siteUrl: 'https://verify.creators.yucp.club',
      frontendUrl: 'https://verify.creators.yucp.club',
    });

    expect(trustedOrigins).toContain('https://verify.creators.yucp.club');
    expect(trustedOrigins).not.toContain('http://localhost:3000');
    expect(trustedOrigins).not.toContain('http://127.0.0.1:3000');
  });
});
