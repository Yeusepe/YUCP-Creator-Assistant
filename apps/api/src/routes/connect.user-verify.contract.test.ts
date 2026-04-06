import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const connectRouteSource = readFileSync(resolve(import.meta.dir, './connect.ts'), 'utf8');
const connectUserVerificationSource = readFileSync(
  resolve(import.meta.dir, './connectUserVerification.ts'),
  'utf8'
);
const providerDisplaySource = readFileSync(
  resolve(import.meta.dir, '../providers/display.ts'),
  'utf8'
);
const sessionManagerSource = readFileSync(
  resolve(import.meta.dir, '../verification/sessionManager.ts'),
  'utf8'
);

describe('connect user-verify contracts', () => {
  it('supports OAuth-capable buyer-link providers through the shared verification begin route', () => {
    expect(connectRouteSource).toContain('createConnectUserVerificationRoutes({');
    expect(connectUserVerificationSource).toContain('listUserLinkProviderDisplays()');
    expect(providerDisplaySource).toContain('createApplicationServices({');
    expect(providerDisplaySource).toContain(
      'isVerificationAvailable: (providerKey) => getVerificationConfig(providerKey) !== null'
    );
    expect(connectUserVerificationSource).toContain(
      "const beginUrl = new URL('/api/verification/begin'"
    );
    expect(connectUserVerificationSource).toContain(
      "beginUrl.searchParams.set('mode', providerKey);"
    );
    expect(connectUserVerificationSource).toContain(
      "beginUrl.searchParams.set('verificationMethod', 'account_link');"
    );
    expect(connectUserVerificationSource).toContain(
      "beginUrl.searchParams.set('redirectUri', frontendReturnUrl);"
    );
  });

  it('preserves buyer account response shaping in the extracted route module', () => {
    expect(connectUserVerificationSource).toContain("connectionType: 'verification'");
    expect(connectUserVerificationSource).toContain(
      'providerDisplay: getConnectedAccountProviderDisplay(link.provider)'
    );
    expect(connectUserVerificationSource).toContain(
      'verificationMethod: link.verificationMethod ?? null'
    );
  });

  it('stores buyer provider links after a successful account-link callback', () => {
    expect(sessionManagerSource).not.toContain("session.verificationMethod === 'account_link'");
    expect(sessionManagerSource).toContain('api.subjects.upsertBuyerProviderLink');
    expect(sessionManagerSource).toContain('verificationSessionId: session._id');
    expect(sessionManagerSource).toContain('verificationMethod: input.verificationMethod');
  });
});
