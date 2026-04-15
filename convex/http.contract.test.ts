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

  it('checks protected asset bounds before package registration and transparency writes', () => {
    const limitIndex = httpSource.indexOf(
      'if (body.protectedAssets && body.protectedAssets.length > MAX_PROTECTED_ASSETS_PER_REQUEST)'
    );
    const registrationIndex = httpSource.indexOf(
      'const regResult = await ctx.runMutation(internal.packageRegistry.registerPackage'
    );
    const logWriteIndex = httpSource.indexOf(
      'const logResult = await ctx.runMutation(internal.signingLog.writeEntry'
    );

    expect(limitIndex).toBeGreaterThan(-1);
    expect(registrationIndex).toBeGreaterThan(-1);
    expect(logWriteIndex).toBeGreaterThan(-1);
    expect(limitIndex).toBeLessThan(registrationIndex);
    expect(limitIndex).toBeLessThan(logWriteIndex);
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
