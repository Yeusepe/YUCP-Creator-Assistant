import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const httpSource = readFileSync(resolve(__dirname, './http.ts'), 'utf8');

describe('convex HTTP security contracts', () => {
  it('uses one root-key precedence order across trust and signature endpoints', () => {
    expect(httpSource).toContain('process.env.YUCP_ROOT_KEY_ID ?? process.env.YUCP_KEY_ID ?? null');
    expect(httpSource).not.toContain('process.env.YUCP_KEY_ID ?? process.env.YUCP_ROOT_KEY_ID ?? null');
  });

  it('does not trust caller-controlled forwarded IP headers for rate limiting', () => {
    expect(httpSource).toContain("request.headers.get('cf-connecting-ip')");
    expect(httpSource).not.toContain("request.headers.get('x-real-ip')");
    expect(httpSource).not.toContain("request.headers.get('x-forwarded-for')");
  });

  it('does not accept protected material or content keys through the public signature route', () => {
    expect(httpSource).not.toContain('contentKeyBase64');
    expect(httpSource).not.toContain('wrappedContentKey');
    expect(httpSource).not.toContain('body.protectedAssets');
  });

  it('verifies bearer certs against configured trusted roots instead of only the active signing root', () => {
    expect(httpSource).toContain('verifyCertEnvelopeAgainstPinnedRoots');
    expect(httpSource).not.toContain('parseBearerCert(request, signingRoot.publicKeyBase64)');
  });

  it('builds manifest certificate chains with the active signing root key id', () => {
    expect(httpSource).toContain('rootKeyId: string');
    expect(httpSource).toContain('signingRoot.keyId');
    expect(httpSource).not.toContain('const rootKeyId = envelope.signature.keyId');
  });
});
