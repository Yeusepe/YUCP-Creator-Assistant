import { describe, expect, it } from 'bun:test';
import {
  shouldResolveLinkedEntitlementRequirements,
  type HostedVerificationIntentRecord,
} from './hostedIntents';

function createIntent(
  requirements: HostedVerificationIntentRecord['requirements']
): HostedVerificationIntentRecord {
  return {
    _id: 'intent_1' as never,
    _creationTime: Date.now(),
    authUserId: 'buyer-auth-user',
    subjectId: undefined,
    packageId: 'pkg_1',
    packageName: 'Package',
    machineFingerprint: 'machine',
    codeChallenge: 'challenge',
    returnUrl: 'http://localhost:3000/access/catalog_1',
    requirements,
    status: 'pending',
    idempotencyKey: undefined,
    verifiedMethodKey: undefined,
    verificationGrantJti: undefined,
    verificationGrantExpiresAt: undefined,
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
