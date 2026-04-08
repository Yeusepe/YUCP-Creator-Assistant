import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { CredentialExpiredError } from '@yucp/providers/contracts';
import type { ConvexServerClient } from '../../lib/convex';

const apiMock = {
  subjects: {
    getSubjectByAuthId: 'subjects.getSubjectByAuthId',
  },
  identitySync: {
    getExternalAccountOAuthCredentials: 'identitySync.getExternalAccountOAuthCredentials',
    storeExternalAccountOAuthCredentials: 'identitySync.storeExternalAccountOAuthCredentials',
  },
  verificationIntents: {
    getIntentRecord: 'verificationIntents.getIntentRecord',
  },
  entitlements: {
    grantEntitlement: 'entitlements.grantEntitlement',
  },
} as const;

const internalMock = {
  subjects: {
    getBuyerProviderLinkForSubject: 'subjects.getBuyerProviderLinkForSubject',
    markBuyerProviderLinkExpired: 'subjects.markBuyerProviderLinkExpired',
  },
  verificationIntents: {
    markIntentFailed: 'verificationIntents.markIntentFailed',
    markIntentVerified: 'verificationIntents.markIntentVerified',
  },
} as const;

let queryImpl: (ref: unknown, args?: unknown) => Promise<unknown>;
let mutationImpl: (ref: unknown, args?: unknown) => Promise<unknown>;
const queryMock = mock((ref: unknown, args?: unknown) => queryImpl(ref, args));
const mutationMock = mock((ref: unknown, args?: unknown) => mutationImpl(ref, args));

const fetchCurrentUserMock = mock(async () => ({
  id: 'itch-user-1',
  username: 'itch-buyer',
  displayName: 'Itch Buyer',
  profileUrl: 'https://itch-buyer.itch.io',
}));
const fetchOwnedKeysMock = mock(async () => [
  {
    ownedKeyId: 'owned-1',
    gameId: '42',
    purchaseId: 'purchase-1',
    gameTitle: 'Volcanic Sinkhole Battlemap',
    gameUrl: 'https://creator.itch.io/volcanic-sinkhole-battlemap',
  },
]);
const encryptMock = mock(async (value: string) => `enc:${value}`);
const decryptMock = mock(async (value: string) => value.replace(/^enc:/, ''));

mock.module('../../../../../convex/_generated/api', () => ({
  api: apiMock,
  internal: internalMock,
  components: {},
}));

mock.module('@yucp/providers/itchio/module', () => ({
  ITCHIO_PURPOSES: {
    credential: 'itchio-oauth-access-token',
    buyerCredential: 'itchio-oauth-buyer-access-token',
  },
  fetchItchioCurrentUser: fetchCurrentUserMock,
  fetchItchioOwnedKeys: fetchOwnedKeysMock,
}));

mock.module('../../lib/encrypt', () => ({
  encrypt: encryptMock,
  decrypt: decryptMock,
}));

const { createItchioBuyerLinkPlugin } = await import('./buyerLink');

beforeEach(() => {
  queryMock.mockClear();
  mutationMock.mockClear();
  fetchCurrentUserMock.mockClear();
  fetchOwnedKeysMock.mockClear();
  encryptMock.mockClear();
  decryptMock.mockClear();
  queryImpl = async () => null;
  mutationImpl = async () => null;
});

afterEach(() => {
  fetchCurrentUserMock.mockReset();
  fetchOwnedKeysMock.mockReset();
  encryptMock.mockReset();
  decryptMock.mockReset();

  fetchCurrentUserMock.mockResolvedValue({
    id: 'itch-user-1',
    username: 'itch-buyer',
    displayName: 'Itch Buyer',
    profileUrl: 'https://itch-buyer.itch.io',
  });
  fetchOwnedKeysMock.mockResolvedValue([
    {
      ownedKeyId: 'owned-1',
      gameId: '42',
      purchaseId: 'purchase-1',
      gameTitle: 'Volcanic Sinkhole Battlemap',
      gameUrl: 'https://creator.itch.io/volcanic-sinkhole-battlemap',
    },
  ]);
  encryptMock.mockImplementation(async (value: string) => `enc:${value}`);
  decryptMock.mockImplementation(async (value: string) => value.replace(/^enc:/, ''));
});

afterAll(() => {
  mock.restore();
});

function makeCtx() {
  return {
    convex: {
      query: queryMock,
      mutation: mutationMock,
      action: mock(async () => null),
    } satisfies ConvexServerClient,
    apiSecret: 'api-secret',
    encryptionSecret: 'encrypt-secret',
  };
}

describe('itchio buyer link plugin', () => {
  it('stores the encrypted buyer token on the linked external account', async () => {
    const plugin = createItchioBuyerLinkPlugin();
    if (!plugin.storeCredential) {
      throw new Error('Expected storeCredential to be defined for itch.io');
    }

    const identity = await plugin.fetchIdentity('buyer-access-token', makeCtx());
    await plugin.storeCredential(
      {
        externalAccountId: 'external-account-1' as never,
        accessToken: 'buyer-access-token',
      },
      makeCtx()
    );

    expect(identity).toEqual({
      providerUserId: 'itch-user-1',
      username: 'itch-buyer',
      profileUrl: 'https://itch-buyer.itch.io',
    });
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.identitySync.storeExternalAccountOAuthCredentials,
      expect.objectContaining({
        externalAccountId: 'external-account-1',
        oauthAccessTokenEncrypted: 'enc:buyer-access-token',
      })
    );
  });

  it('grants entitlement from the linked owned library and marks the intent verified', async () => {
    queryMock.mockImplementation(async (ref) => {
      switch (ref) {
        case apiMock.verificationIntents.getIntentRecord:
          return {
            status: 'pending',
            expiresAt: Date.now() + 60_000,
            packageId: 'package_1',
            requirements: [
              {
                methodKey: 'itchio-link',
                providerKey: 'itchio',
                kind: 'buyer_provider_link',
                creatorAuthUserId: 'creator_1',
                productId: 'product_1',
                providerProductRef: '42',
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
            provider: 'itchio',
            externalAccountId: 'external-account-1',
            providerUserId: 'itch-user-1',
            label: 'itch-buyer',
            status: 'active',
            linkedAt: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        case apiMock.identitySync.getExternalAccountOAuthCredentials:
          return {
            oauthAccessTokenEncrypted: 'enc:buyer-access-token',
          };
        default:
          throw new Error(`Unhandled query ref ${String(ref)}`);
      }
    });

    const plugin = createItchioBuyerLinkPlugin();
    if (!plugin.verifyHostedIntent) {
      throw new Error('Expected verifyHostedIntent to be defined for itch.io');
    }
    const result = await plugin.verifyHostedIntent(
      {
        authUserId: 'buyer-auth-user',
        intentId: 'intent_1' as never,
        methodKey: 'itchio-link',
      },
      makeCtx()
    );

    expect(result).toEqual({ success: true });
    expect(fetchOwnedKeysMock).toHaveBeenCalledWith('buyer-access-token', {});
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.entitlements.grantEntitlement,
      expect.objectContaining({
        authUserId: 'creator_1',
        subjectId: 'subject_1',
        productId: 'product_1',
        evidence: expect.objectContaining({
          provider: 'itchio',
          sourceReference: 'owned-1',
        }),
      })
    );
    expect(mutationMock).toHaveBeenCalledWith(
      internalMock.verificationIntents.markIntentVerified,
      expect.objectContaining({
        intentId: 'intent_1',
        methodKey: 'itchio-link',
      })
    );
  });

  it('marks the link expired when the buyer token is no longer valid', async () => {
    fetchOwnedKeysMock.mockRejectedValueOnce(new CredentialExpiredError('itchio'));
    queryMock.mockImplementation(async (ref) => {
      switch (ref) {
        case apiMock.verificationIntents.getIntentRecord:
          return {
            status: 'pending',
            expiresAt: Date.now() + 60_000,
            packageId: 'package_1',
            requirements: [
              {
                methodKey: 'itchio-link',
                providerKey: 'itchio',
                kind: 'buyer_provider_link',
                creatorAuthUserId: 'creator_1',
                productId: 'product_1',
                providerProductRef: '42',
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
            provider: 'itchio',
            externalAccountId: 'external-account-1',
            providerUserId: 'itch-user-1',
            label: 'itch-buyer',
            status: 'active',
            linkedAt: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        case apiMock.identitySync.getExternalAccountOAuthCredentials:
          return {
            oauthAccessTokenEncrypted: 'enc:buyer-access-token',
          };
        default:
          throw new Error(`Unhandled query ref ${String(ref)}`);
      }
    });

    const plugin = createItchioBuyerLinkPlugin();
    if (!plugin.verifyHostedIntent) {
      throw new Error('Expected verifyHostedIntent to be defined for itch.io');
    }
    const result = await plugin.verifyHostedIntent(
      {
        authUserId: 'buyer-auth-user',
        intentId: 'intent_1' as never,
        methodKey: 'itchio-link',
      },
      makeCtx()
    );

    expect(result).toEqual({
      success: false,
      errorCode: 'provider_link_expired',
      errorMessage: 'The linked itch.io account must be reconnected before it can be used.',
    });
    expect(mutationMock).toHaveBeenCalledWith(
      internalMock.subjects.markBuyerProviderLinkExpired,
      expect.objectContaining({
        linkId: 'link_1',
      })
    );
    expect(mutationMock).toHaveBeenCalledWith(
      internalMock.verificationIntents.markIntentFailed,
      expect.objectContaining({
        intentId: 'intent_1',
        errorCode: 'provider_link_expired',
      })
    );
  });
});
