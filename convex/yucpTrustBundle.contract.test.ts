import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const httpSource = readFileSync(resolve(__dirname, './http.ts'), 'utf8');

describe('yucp trust bundle HTTP contract', () => {
  it('advertises an authenticated trust bundle alongside the legacy key set', () => {
    expect(httpSource).toContain("path: '/v1/keys'");
    expect(httpSource).toContain('trustBundle');
    expect(httpSource).toContain('signYucpTrustBundleJwt');
    expect(httpSource).toContain('getConfiguredYucpJwkSet');
  });

  it('signs the trust-bundle issuer from the configured public API base URL', () => {
    expect(httpSource).toContain('resolveConfiguredPublicApiBaseUrl()');
    expect(httpSource).not.toContain('issuer: requestUrl.origin');
  });
});
