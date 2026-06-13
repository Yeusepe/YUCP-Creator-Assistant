import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const apiMock = {
  subjects: {
    getSubjectByAuthId: 'subjects.getSubjectByAuthId',
  },
  verificationIntents: {
    getIntentRecord: 'verificationIntents.getIntentRecord',
  },
} as const;

const internalMock = {
  backgroundSync: {
    syncPastPurchasesForSubject: 'backgroundSync.syncPastPurchasesForSubject',
  },
  subjects: {
    getBuyerProviderLinkForSubject: 'subjects.getBuyerProviderLinkForSubject',
    getExternalAccountEmailHash: 'subjects.getExternalAccountEmailHash',
  },
  verificationIntents: {
    markIntentFailed: 'verificationIntents.markIntentFailed',
    markIntentVerified: 'verificationIntents.markIntentVerified',
  },
  yucpLicenses: {
    checkSubjectEntitlement: 'yucpLicenses.checkSubjectEntitlement',
  },
} as const;

let queryImpl: (ref: unknown, args?: unknown) => Promise<unknown>;
let mutationImpl: (ref: unknown, args?: unknown) => Promise<unknown>;
let actionImpl: (ref: unknown, args?: unknown) => Promise<unknown>;

const queryMock = mock((ref: unknown, args?: unknown) => queryImpl(ref, args));
const mutationMock = mock((ref: unknown, args?: unknown) => mutationImpl(ref, args));
const actionMock = mock((ref: unknown, args?: unknown) => actionImpl(ref, args));

const resolveBuyerVerificationStoreContextMock = mock(async () => ({
  ok: true as const,
  creatorAuthUserId: 'creator_1',
  creatorProductId: 'product_1',
  displayName: 'External Storefront Product',
}));

mock.module('../../../../../convex/_generated/api', () => ({
  api: apiMock,
  internal: internalMock,
  components: {},
}));

const buyerVerificationHelpersModule = await import('../../verification/buyerVerificationHelpers');
spyOn(buyerVerificationHelpersModule, 'resolveBuyerVerificationStoreContext').mockImplementation(
  resolveBuyerVerificationStoreContextMock
);

const { createGumroadBuyerLinkPlugin } = await import('./buyerLink');

function makeCtx() {
  return {
    convex: {
      query: queryMock,
      mutation: mutationMock,
      action: actionMock,
    },
    apiSecret: 'api-secret',
    encryptionSecret: 'encrypt-secret',
  } as never;
}

beforeEach(() => {
  queryMock.mockClear();
  mutationMock.mockClear();
  actionMock.mockClear();
  resolveBuyerVerificationStoreContextMock.mockReset();
  resolveBuyerVerificationStoreContextMock.mockResolvedValue({
    ok: true,
    creatorAuthUserId: 'creator_1',
    creatorProductId: 'product_1',
    displayName: 'External Storefront Product',
  });
  queryImpl = async () => null;
  mutationImpl = async () => null;
  actionImpl = async () => null;
});

afterAll(() => {
  mock.restore();
});

describe('gumroad buyer link plugin', () => {
  it('resolves creator product context for legacy Gumroad intents that only carry providerProductRef', async () => {
    queryMock.mockImplementation(async (ref) => {
      switch (ref) {
        case apiMock.verificationIntents.getIntentRecord:
          return {
            status: 'pending',
            expiresAt: Date.now() + 60_000,
            packageId: 'package_external',
            requirements: [
              {
                methodKey: 'gumroad-link',
                providerKey: 'gumroad',
                kind: 'buyer_provider_link',
                providerProductRef: 'https://store.example.com/l/external-product',
              },
            ],
          };
        case apiMock.subjects.getSubjectByAuthId:
          return {
            found: true,
            subject: { _id: 'subject_1' },
          };
        case internalMock.subjects.getBuyerProviderLinkForSubject:
          return {
            id: 'link_1',
            provider: 'gumroad',
            externalAccountId: 'external-account-1',
            providerUserId: 'gumroad-user-1',
            status: 'active',
          };
        case internalMock.subjects.getExternalAccountEmailHash:
          return {
            emailHash: 'email-hash-1',
          };
        case internalMock.yucpLicenses.checkSubjectEntitlement:
          return true;
        default:
          throw new Error(`Unhandled query ref ${String(ref)}`);
      }
    });

    const plugin = createGumroadBuyerLinkPlugin();
    if (!plugin.verifyHostedIntent) {
      throw new Error('Expected verifyHostedIntent to be defined for Gumroad');
    }

    const result = await plugin.verifyHostedIntent(
      {
        authUserId: 'buyer-auth-user',
        intentId: 'intent_legacy' as never,
        methodKey: 'gumroad-link',
      },
      makeCtx()
    );

    expect(result).toEqual({ success: true });
    expect(resolveBuyerVerificationStoreContextMock).toHaveBeenCalledWith(
      {
        providerId: 'gumroad',
        packageId: 'package_external',
        providerProductRef: 'https://store.example.com/l/external-product',
      },
      expect.objectContaining({
        apiSecret: 'api-secret',
        encryptionSecret: 'encrypt-secret',
      })
    );
    expect(actionMock).not.toHaveBeenCalled();
    expect(mutationMock).toHaveBeenCalledWith(
      internalMock.verificationIntents.markIntentVerified,
      expect.objectContaining({
        intentId: 'intent_legacy',
        methodKey: 'gumroad-link',
      })
    );
  });
});
