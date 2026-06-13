import { afterEach, describe, expect, it } from 'bun:test';
import {
  normalizeOAuthScopes,
  normalizePublicApiScopes,
  normalizeRedirectUris,
} from './connectApiAccessShared';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
    return;
  }
  process.env.NODE_ENV = originalNodeEnv;
});

describe('normalizeRedirectUris', () => {
  it('allows loopback http redirects during development', () => {
    process.env.NODE_ENV = 'development';

    expect(normalizeRedirectUris(['http://localhost:3000/callback'])).toEqual([
      'http://localhost:3000/callback',
    ]);
  });

  it('rejects non-http loopback schemes during development', () => {
    process.env.NODE_ENV = 'development';

    expect(() => normalizeRedirectUris(['myapp://localhost/callback'])).toThrow(
      'Redirect URI must use HTTPS or target localhost over HTTP'
    );
  });

  it('accepts HTTPS redirect URIs in development and production', () => {
    process.env.NODE_ENV = 'development';
    expect(normalizeRedirectUris(['https://example.com/callback'])).toEqual([
      'https://example.com/callback',
    ]);

    process.env.NODE_ENV = 'production';
    expect(normalizeRedirectUris(['https://example.com/callback'])).toEqual([
      'https://example.com/callback',
    ]);
  });

  it('rejects non-HTTPS redirect URIs in production', () => {
    process.env.NODE_ENV = 'production';

    expect(() => normalizeRedirectUris(['http://localhost:3000/callback'])).toThrow(
      'Redirect URI must use HTTPS in production: http://localhost:3000/callback'
    );
  });
});

describe('public API scope normalization', () => {
  it('accepts product read scope for Unity package delivery', () => {
    expect(normalizePublicApiScopes(['verification:read', 'products:read'])).toEqual([
      'verification:read',
      'products:read',
    ]);
    expect(normalizeOAuthScopes(['verification:read', 'products:read'])).toEqual([
      'verification:read',
      'products:read',
    ]);
  });

  it('rejects unknown scopes instead of passing them into Better Auth', () => {
    expect(() => normalizePublicApiScopes(['verification:read', 'unknown:scope'])).toThrow(
      'Invalid API key scopes'
    );
    expect(() => normalizeOAuthScopes(['verification:read', 'unknown:scope'])).toThrow(
      'Invalid OAuth scopes'
    );
  });
});
