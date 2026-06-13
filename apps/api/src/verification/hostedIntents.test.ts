import { describe, expect, it, mock } from 'bun:test';
import type { HostedVerificationIntentRecord } from './hostedIntents';

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    verificationIntents: {
      verifyIntentWithBuyerProviderLink: 'verificationIntents.verifyIntentWithBuyerProviderLink',
      verifyIntentWithManualLicense: 'verificationIntents.verifyIntentWithManualLicense',
    },
  },
  internal: {},
  components: {},
}));

const {
  shouldResolveLinkedEntitlementRequirements,
  verifyHostedBuyerProviderLinkIntent,
  verifyHostedManualLicenseIntent,
} = await import('./hostedIntents');

function createIntent(
  requirements: HostedVerificationIntentRecord['requirements']
): HostedVerificationIntentRecord {
  return {
    _id: 'intent_1' as never,
    authUserId: 'buyer-auth-user',
    packageId: 'pkg_1',
    packageName: 'Package',
    returnUrl: 'http://localhost:3000/access/catalog_1',
    requirements,
    status: 'pending',
    verifiedMethodKey: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('shouldResolveLinkedEntitlementRequirements', () => {
  it('skips derived requirement resolution when the provider already has a buyer link method', () => {
    const intent = createIntent([
      {
        methodKey: 'gumroad-link',
        providerKey: 'gumroad',
        kind: 'buyer_provider_link',
        title: 'Gumroad account',
        description: undefined,
        providerProductRef: 'gumroad-product',
      },
      {
        methodKey: 'gumroad-license',
        providerKey: 'gumroad',
        kind: 'manual_license',
        title: 'Gumroad license',
        description: undefined,
        providerProductRef: 'gumroad-product',
      },
    ]);

    expect(shouldResolveLinkedEntitlementRequirements(intent)).toBe(false);
  });

  it('requests derived requirement resolution when only manual-license proof exists for an account-link capable provider', () => {
    const intent = createIntent([
      {
        methodKey: 'itchio-license',
        providerKey: 'itchio',
        kind: 'manual_license',
        title: 'itch.io download key',
        description: undefined,
        providerProductRef: 'itchio-product',
      },
    ]);

    expect(shouldResolveLinkedEntitlementRequirements(intent)).toBe(true);
  });
});

describe('verifyHostedManualLicenseIntent', () => {
  it('delegates to the public Convex manual-license action instead of mutating internal verification state directly', async () => {
    const actionMock = mock(async () => ({ success: true }));

    const result = await verifyHostedManualLicenseIntent({
      convex: {
        query: mock(async () => null),
        mutation: mock(async () => null),
        action: actionMock,
      },
      apiSecret: 'convex-secret',
      encryptionSecret: 'encryption-secret',
      authUserId: 'buyer-auth-user',
      intentId: 'intent_123' as never,
      methodKey: 'gumroad-license',
      licenseKey: 'license_123',
    });

    expect(result).toEqual({ success: true });
    expect(actionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        apiSecret: 'convex-secret',
        authUserId: 'buyer-auth-user',
        intentId: 'intent_123',
        methodKey: 'gumroad-license',
        licenseKey: 'license_123',
      })
    );
  });
});

describe('verifyHostedBuyerProviderLinkIntent', () => {
  it('delegates to the public Convex buyer-provider-link action instead of provider hooks or API-side internal mutations', async () => {
    const actionMock = mock(async () => ({ success: true }));

    const result = await verifyHostedBuyerProviderLinkIntent({
      convex: {
        query: mock(async () => null),
        mutation: mock(async () => null),
        action: actionMock,
      },
      apiSecret: 'convex-secret',
      encryptionSecret: 'encryption-secret',
      authUserId: 'buyer-auth-user',
      intentId: 'intent_123' as never,
      methodKey: 'gumroad-link',
    });

    expect(result).toEqual({ success: true });
    expect(actionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        apiSecret: 'convex-secret',
        authUserId: 'buyer-auth-user',
        intentId: 'intent_123',
        methodKey: 'gumroad-link',
      })
    );
  });
});
