import { describe, expect, it } from 'bun:test';
import { applyPublicOriginForwardingHeaders } from './proxyForwardedOrigin';

describe('applyPublicOriginForwardingHeaders', () => {
  it('records the public origin the client called', () => {
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
        'x-forwarded-host': 'attacker.example.com',
        'x-forwarded-proto': 'http',
      }),
      new URL('https://api.creators.yucp.club/api/auth/oauth2/token')
    );

    expect(headers.get('x-forwarded-host')).toBe('api.creators.yucp.club');
    expect(headers.get('x-forwarded-proto')).toBe('https');
  });

  it('keeps a non-default port, which the loopback and local origins depend on', () => {
    const headers = applyPublicOriginForwardingHeaders(
      new Headers(),
      new URL('http://localhost:3000/api/auth/oauth2/token')
    );

    expect(headers.get('x-forwarded-host')).toBe('localhost:3000');
    expect(headers.get('x-forwarded-proto')).toBe('http');
  });
});
