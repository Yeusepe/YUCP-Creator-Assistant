import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const connectRouteSource = readFileSync(resolve(import.meta.dir, './connect.ts'), 'utf8');
const sessionManagerSource = readFileSync(
  resolve(import.meta.dir, '../verification/sessionManager.ts'),
  'utf8'
);

describe('connect user-verify contracts', () => {
  it('supports OAuth-capable buyer-link providers through the shared verification begin route', () => {
    expect(connectRouteSource).toContain('getVerificationConfig(p.id) !== null');
    expect(connectRouteSource).toContain("const beginUrl = new URL('/api/verification/begin'");
    expect(connectRouteSource).toContain("beginUrl.searchParams.set('mode', providerKey);");
    expect(connectRouteSource).toContain(
      "beginUrl.searchParams.set('verificationMethod', 'account_link');"
    );
    expect(connectRouteSource).toContain(
      "beginUrl.searchParams.set('redirectUri', frontendReturnUrl);"
    );
  });

  it('stores buyer provider links after a successful account-link callback', () => {
    expect(sessionManagerSource).toContain("session.verificationMethod === 'account_link'");
    expect(sessionManagerSource).toContain('api.subjects.upsertBuyerProviderLink');
    expect(sessionManagerSource).toContain('verificationSessionId: session._id');
    expect(sessionManagerSource).toContain('verificationMethod: input.verificationMethod');
  });
});
