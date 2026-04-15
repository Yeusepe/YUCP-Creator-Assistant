import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const httpSource = readFileSync(resolve(__dirname, './http.ts'), 'utf8');

describe('http surface hardening contract', () => {
  it('sanitizes package hash responses so owner identifiers and raw cert envelopes stay private', () => {
    expect(httpSource).not.toContain('registeredOwnerYucpUserId');
    expect(httpSource).not.toContain('signingYucpUserId');
    expect(httpSource).not.toContain('certData: cert ?');
  });

  it('returns a generic namespace-conflict error instead of disclosing the owning creator id', () => {
    expect(httpSource).not.toContain('registeredOwnerYucpUserId: regResult.ownedBy');
    expect(httpSource).toContain("message: 'Package ownership conflict detected.'");
  });

  it('proxies only an explicit request-header allowlist to the public API bridge', () => {
    expect(httpSource).toContain('PROXY_REQUEST_HEADER_ALLOWLIST');
    expect(httpSource).toContain('copyAllowedHeaders');
    expect(httpSource).not.toContain('const headers = new Headers(request.headers);');
  });

  it('applies shared rate limits to the public hash lookup, signature registration, and runtime token routes', () => {
    expect(httpSource).toContain("await applyHttpRateLimit(ctx, request, 'packages-by-hash'");
    expect(httpSource).toContain("await applyHttpRateLimit(ctx, request, 'signature-register'");
    expect(httpSource).toContain(
      "await applyHttpRateLimit(_ctx, request, 'runtime-package-token'"
    );
  });
});
