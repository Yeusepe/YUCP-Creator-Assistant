import { describe, expect, it } from 'bun:test';
import { applyPublicOriginForwardingHeaders } from './proxyForwardedOrigin';

describe('applyPublicOriginForwardingHeaders', () => {
  it('sends the prefixed pair the Convex component actually reads', () => {
    // Convex rewrites the standard x-forwarded-* headers before an httpAction
    // sees them, so only these survive to reach Better Auth. Sending just the
    // standard names is silently ineffective and leaves DPoP htu mismatched.
    const headers = applyPublicOriginForwardingHeaders(
      new Headers(),
      new URL('https://api.creators.yucp.club/api/auth/oauth2/token')
    );

    expect(headers.get('x-better-auth-forwarded-host')).toBe('api.creators.yucp.club');
    expect(headers.get('x-better-auth-forwarded-proto')).toBe('https');
  });

  it('also records the public origin on the standard names', () => {
    const headers = applyPublicOriginForwardingHeaders(
      new Headers(),
      new URL('https://api.creators.yucp.club/api/auth/oauth2/token')
    );

    expect(headers.get('x-forwarded-host')).toBe('api.creators.yucp.club');
    expect(headers.get('x-forwarded-proto')).toBe('https');
  });

  it('overwrites a client-supplied origin so a caller cannot choose its own DPoP audience', () => {
    const headers = applyPublicOriginForwardingHeaders(
      new Headers({
        'x-better-auth-forwarded-host': 'attacker.example.com',
        'x-better-auth-forwarded-proto': 'http',
        'x-forwarded-host': 'attacker.example.com',
        'x-forwarded-proto': 'http',
      }),
      new URL('https://api.creators.yucp.club/api/auth/oauth2/token')
    );

    expect(headers.get('x-better-auth-forwarded-host')).toBe('api.creators.yucp.club');
    expect(headers.get('x-better-auth-forwarded-proto')).toBe('https');
    expect(headers.get('x-forwarded-host')).toBe('api.creators.yucp.club');
    expect(headers.get('x-forwarded-proto')).toBe('https');
  });

  it('keeps a non-default port, which the loopback and local origins depend on', () => {
    const headers = applyPublicOriginForwardingHeaders(
      new Headers(),
      new URL('http://localhost:3000/api/auth/oauth2/token')
    );

    expect(headers.get('x-better-auth-forwarded-host')).toBe('localhost:3000');
    expect(headers.get('x-better-auth-forwarded-proto')).toBe('http');
  });
});
