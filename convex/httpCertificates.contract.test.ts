import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const httpSource = readFileSync(resolve(__dirname, './http.ts'), 'utf8');

describe('/v1/certificates issuance contract', () => {
  it('maps devPublicKey ownership conflicts to a 409 with an actionable message', () => {
    expect(httpSource).toContain("raw.includes('already registered to a different user')");
    expect(httpSource).toContain('This dev key is already registered to another YUCP account.');
    expect(httpSource).toContain('return errorResponse(');
    expect(httpSource).toContain('409');
  });

  it('logs hidden issuance conflicts before returning an error response', () => {
    expect(httpSource).toContain('Certificate issuance conflict');
  });

  it('returns the raw issuance error in the 500 response for temporary debugging', () => {
    expect(httpSource).toContain("const raw = err instanceof Error ? err.message : ''");
    expect(httpSource).toContain("return errorResponse(raw || String(err), 500)");
  });
});
