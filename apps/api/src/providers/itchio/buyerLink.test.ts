import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
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
  yucpLicenses: {
    getProductByProviderRef: 'yucpLicenses.getProductByProviderRef',
    checkSubjectEntitlement: 'yucpLicenses.checkSubjectEntitlement',
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
const resolveBuyerVerificationStoreContextMock = mock(async () => ({
  ok: true as const,
  creatorAuthUserId: 'creator_1',
  creatorProductId: 'product_1',
  displayName: 'Creator Product',
}));

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

const buyerVerificationHelpersModule = await import('../../verification/buyerVerificationHelpers');
spyOn(buyerVerificationHelpersModule, 'resolveBuyerVerificationStoreContext').mockImplementation(
  resolveBuyerVerificationStoreContextMock
);

const { createItchioBuyerLinkPlugin } = await import('./buyerLink');

beforeEach(() => {
  queryMock.mockClear();
  mutationMock.mockClear();
  fetchCurrentUserMock.mockClear();
  fetchOwnedKeysMock.mockClear();
  encryptMock.mockClear();
  decryptMock.mockClear();
  resolveBuyerVerificationStoreContextMock.mockReset();
  resolveBuyerVerificationStoreContextMock.mockResolvedValue({
    ok: true,
    creatorAuthUserId: 'creator_1',
    creatorProductId: 'product_1',
    displayName: 'Creator Product',
  });
  queryImpl = async () => null;
  mutationImpl = async () => null;
});

afterEach(() => {
  fetchCurrentUserMock.mockReset();
  fetchOwnedKeysMock.mockReset();
  encryptMock.mockReset();
  decryptMock.mockReset();
  resolveBuyerVerificationStoreContextMock.mockReset();

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
  resolveBuyerVerificationStoreContextMock.mockResolvedValue({
    ok: true,
    creatorAuthUserId: 'creator_1',
    creatorProductId: 'product_1',
    displayName: 'Creator Product',
  });
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

function buildActiveBuyerProviderLink(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function buildPendingIntent(
  requirementOverrides: Record<string, unknown> = {},
  options: { packageId?: string } = {}
) {
  return {
    status: 'pending',
    expiresAt: Date.now() + 60_000,
    packageId: options.packageId ?? 'package_1',
    requirements: [
      {
        methodKey: 'itchio-link',
        providerKey: 'itchio',
        kind: 'buyer_provider_link',
        ...requirementOverrides,
      },
    ],
  };
}

function mockHostedVerificationQueries(options: {
  intentRequirement: Record<string, unknown>;
  packageId?: string;
  buyerProviderLink?: Record<string, unknown> | null;
  credentials?: Record<string, unknown> | null;
  subjectResult?: Record<string, unknown>;
}) {
  const subjectResult = options.subjectResult ?? {
    found: true,
    subject: { _id: 'subject_1' },
  };
  const buyerProviderLink =
    options.buyerProviderLink === undefined
      ? buildActiveBuyerProviderLink()
      : options.buyerProviderLink;
  const credentials =
    options.credentials === undefined
      ? {
          oauthAccessTokenEncrypted: 'enc:buyer-access-token',
        }
      : options.credentials;

  queryMock.mockImplementation(async (ref) => {
    switch (ref) {
      case apiMock.verificationIntents.getIntentRecord:
        return buildPendingIntent(options.intentRequirement, {
          packageId: options.packageId,
        });
      case apiMock.subjects.getSubjectByAuthId:
        return subjectResult;
      case internalMock.subjects.getBuyerProviderLinkForSubject:
        return buyerProviderLink;
      case apiMock.identitySync.getExternalAccountOAuthCredentials:
        return credentials;
      case internalMock.yucpLicenses.getProductByProviderRef:
        return {
          authUserId: 'creator_1',
          productId: 'product_1',
          displayName: 'Volcanic Sinkhole Battlemap',
        };
      case internalMock.yucpLicenses.checkSubjectEntitlement:
        return false;
      default:
        throw new Error(`Unhandled query ref ${String(ref)}`);
    }
  });
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

  it('backfills entitlements for owned itch.io games when account linking completes', async () => {
    queryMock.mockImplementation(async (ref, args) => {
      switch (ref) {
        case internalMock.yucpLicenses.getProductByProviderRef:
          return (args as { providerProductRef?: string }).providerProductRef === '42'
            ? {
                authUserId: 'creator_1',
                productId: 'product_1',
                displayName: 'Volcanic Sinkhole Battlemap',
              }
            : null;
        default:
          throw new Error(`Unhandled query ref ${String(ref)}`);
      }
    });
    fetchOwnedKeysMock.mockResolvedValueOnce([
      {
        ownedKeyId: 'owned-1',
        gameId: '42',
        purchaseId: 'purchase-1',
        gameTitle: 'Volcanic Sinkhole Battlemap',
        gameUrl: 'https://creator.itch.io/volcanic-sinkhole-battlemap',
      },
      {
        ownedKeyId: 'owned-2',
        gameId: '999',
        purchaseId: 'purchase-2',
        gameTitle: 'Other Game',
        gameUrl: 'https://other.itch.io/other-game',
      },
    ]);

    const plugin = createItchioBuyerLinkPlugin();
    if (!plugin.afterLink) {
      throw new Error('Expected afterLink to be defined for itch.io');
    }

    await plugin.afterLink(
      {
        authUserId: 'buyer-auth-user',
        sessionId: 'verification-session-1' as never,
        sessionMode: 'itchio',
        verificationMethod: 'account_link',
        accessToken: 'buyer-access-token',
        identity: {
          providerUserId: 'itch-user-1',
          username: 'itch-buyer',
          profileUrl: 'https://itch-buyer.itch.io',
        },
        subjectId: 'subject_1' as never,
        externalAccountId: 'external-account-1' as never,
      },
      makeCtx()
    );

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
  });

  it('grants entitlement from the linked owned library and marks the intent verified', async () => {
    const entitlementChecks = [false, true];
    mockHostedVerificationQueries({
      intentRequirement: {
        creatorAuthUserId: 'creator_1',
        productId: 'product_1',
        providerProductRef: '42',
      },
    });
    mutationMock.mockImplementation(async (_ref) => {
      return null;
    });
    queryMock.mockImplementation(async (ref, args) => {
      switch (ref) {
        case apiMock.verificationIntents.getIntentRecord:
          return buildPendingIntent(
            {
              creatorAuthUserId: 'creator_1',
              productId: 'product_1',
              providerProductRef: '42',
            },
            { packageId: 'package_1' }
          );
        case apiMock.subjects.getSubjectByAuthId:
          return {
            found: true,
            subject: { _id: 'subject_1' },
          };
        case internalMock.subjects.getBuyerProviderLinkForSubject:
          return buildActiveBuyerProviderLink();
        case apiMock.identitySync.getExternalAccountOAuthCredentials:
          return {
            oauthAccessTokenEncrypted: 'enc:buyer-access-token',
          };
        case internalMock.yucpLicenses.getProductByProviderRef:
          return {
            authUserId: 'creator_1',
            productId: 'product_1',
            displayName: 'Volcanic Sinkhole Battlemap',
          };
        case internalMock.yucpLicenses.checkSubjectEntitlement:
          return entitlementChecks.length > 1
            ? (entitlementChecks.shift() ?? false)
            : (entitlementChecks[0] ?? false);
        default:
          throw new Error(`Unhandled query ref ${String(ref)} ${JSON.stringify(args)}`);
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

  it('marks the hosted intent verified from account-link backfill without re-reading owned keys', async () => {
    mockHostedVerificationQueries({
      intentRequirement: {
        creatorAuthUserId: 'creator_1',
        productId: 'product_1',
        providerProductRef: '42',
      },
    });
    queryMock.mockImplementation(async (ref) => {
      switch (ref) {
        case apiMock.verificationIntents.getIntentRecord:
          return buildPendingIntent(
            {
              creatorAuthUserId: 'creator_1',
              productId: 'product_1',
              providerProductRef: '42',
            },
            { packageId: 'package_1' }
          );
        case apiMock.subjects.getSubjectByAuthId:
          return {
            found: true,
            subject: { _id: 'subject_1' },
          };
        case internalMock.subjects.getBuyerProviderLinkForSubject:
          return buildActiveBuyerProviderLink();
        case internalMock.yucpLicenses.checkSubjectEntitlement:
          return true;
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
        intentId: 'intent_backfilled' as never,
        methodKey: 'itchio-link',
      },
      makeCtx()
    );

    expect(result).toEqual({ success: true });
    expect(fetchOwnedKeysMock).not.toHaveBeenCalled();
    expect(mutationMock).toHaveBeenCalledWith(
      internalMock.verificationIntents.markIntentVerified,
      expect.objectContaining({
        intentId: 'intent_backfilled',
        methodKey: 'itchio-link',
      })
    );
  });

  it('marks the link expired when the buyer token is no longer valid', async () => {
    fetchOwnedKeysMock.mockRejectedValueOnce(new CredentialExpiredError('itchio'));
    mockHostedVerificationQueries({
      intentRequirement: {
        creatorAuthUserId: 'creator_1',
        productId: 'product_1',
        providerProductRef: '42',
      },
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

  it('resolves creator product context for legacy itch intents that only carry providerProductRef', async () => {
    const entitlementChecks = [false, true];
    queryMock.mockImplementation(async (ref) => {
      switch (ref) {
        case apiMock.verificationIntents.getIntentRecord:
          return buildPendingIntent(
            {
              providerProductRef: '42',
            },
            { packageId: 'package_legacy' }
          );
        case apiMock.subjects.getSubjectByAuthId:
          return {
            found: true,
            subject: { _id: 'subject_1' },
          };
        case internalMock.subjects.getBuyerProviderLinkForSubject:
          return buildActiveBuyerProviderLink();
        case apiMock.identitySync.getExternalAccountOAuthCredentials:
          return {
            oauthAccessTokenEncrypted: 'enc:buyer-access-token',
          };
        case internalMock.yucpLicenses.getProductByProviderRef:
          return {
            authUserId: 'creator_1',
            productId: 'product_1',
            displayName: 'Creator Product',
          };
        case internalMock.yucpLicenses.checkSubjectEntitlement:
          return entitlementChecks.length > 1
            ? (entitlementChecks.shift() ?? false)
            : (entitlementChecks[0] ?? false);
        default:
          throw new Error(`Unhandled query ref ${String(ref)}`);
      }
    });
    mutationMock.mockImplementation(async () => null);

    const plugin = createItchioBuyerLinkPlugin();
    if (!plugin.verifyHostedIntent) {
      throw new Error('Expected verifyHostedIntent to be defined for itch.io');
    }

    const result = await plugin.verifyHostedIntent(
      {
        authUserId: 'buyer-auth-user',
        intentId: 'intent_legacy' as never,
        methodKey: 'itchio-link',
      },
      makeCtx()
    );

    expect(result).toEqual({ success: true });
    expect(resolveBuyerVerificationStoreContextMock).toHaveBeenCalledWith(
      {
        providerId: 'itchio',
        packageId: 'package_legacy',
        providerProductRef: '42',
      },
      expect.objectContaining({
        apiSecret: 'api-secret',
        encryptionSecret: 'encrypt-secret',
      })
    );
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.entitlements.grantEntitlement,
      expect.objectContaining({
        authUserId: 'creator_1',
        subjectId: 'subject_1',
        productId: 'product_1',
      })
    );
  });

  it('enforces providerProductRef ownership invariants across current and legacy intent shapes', async () => {
    const cases = [
      {
        name: 'current shape keeps creator context inline',
        intentRequirement: {
          creatorAuthUserId: 'creator_1',
          productId: 'product_1',
          providerProductRef: '42',
        },
        expectedResolverCalls: 0,
      },
      {
        name: 'legacy shape resolves creator context from providerProductRef',
        intentRequirement: {
          providerProductRef: '42',
        },
        expectedResolverCalls: 1,
      },
    ] as const;

    for (const testCase of cases) {
      const entitlementChecks = [false, true];
      queryMock.mockClear();
      mutationMock.mockClear();
      resolveBuyerVerificationStoreContextMock.mockClear();
      mutationMock.mockImplementation(async () => null);
      queryMock.mockImplementation(async (ref) => {
        switch (ref) {
          case apiMock.verificationIntents.getIntentRecord:
            return buildPendingIntent(testCase.intentRequirement, { packageId: 'package_1' });
          case apiMock.subjects.getSubjectByAuthId:
            return {
              found: true,
              subject: { _id: 'subject_1' },
            };
          case internalMock.subjects.getBuyerProviderLinkForSubject:
            return buildActiveBuyerProviderLink();
          case apiMock.identitySync.getExternalAccountOAuthCredentials:
            return {
              oauthAccessTokenEncrypted: 'enc:buyer-access-token',
            };
          case internalMock.yucpLicenses.getProductByProviderRef:
            return {
              authUserId: 'creator_1',
              productId: 'product_1',
              displayName: 'Creator Product',
            };
          case internalMock.yucpLicenses.checkSubjectEntitlement:
            return entitlementChecks.length > 1
              ? (entitlementChecks.shift() ?? false)
              : (entitlementChecks[0] ?? false);
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
          intentId: 'intent_shape' as never,
          methodKey: 'itchio-link',
        },
        makeCtx()
      );

      expect(result, testCase.name).toEqual({ success: true });
      expect(resolveBuyerVerificationStoreContextMock.mock.calls.length, testCase.name).toBe(
        testCase.expectedResolverCalls
      );
      expect(mutationMock).toHaveBeenCalledWith(
        apiMock.entitlements.grantEntitlement,
        expect.objectContaining({
          authUserId: 'creator_1',
          productId: 'product_1',
          subjectId: 'subject_1',
        })
      );
    }
  });

  it('matches owned itch library entries by exact game id only', async () => {
    const cases = [
      {
        name: 'grants access when an owned key game id matches the providerProductRef',
        providerProductRef: '42',
        ownedKeys: [
          {
            ownedKeyId: 'owned-1',
            gameId: '42',
            purchaseId: 'purchase-1',
            gameTitle: 'Volcanic Sinkhole Battlemap',
            gameUrl: 'https://creator.itch.io/volcanic-sinkhole-battlemap',
          },
        ],
        expected: { success: true as const },
        shouldGrantEntitlement: true,
      },
      {
        name: 'does not match the owned key id when the game id differs',
        providerProductRef: 'owned-1',
        ownedKeys: [
          {
            ownedKeyId: 'owned-1',
            gameId: '42',
            purchaseId: 'purchase-1',
            gameTitle: 'Volcanic Sinkhole Battlemap',
            gameUrl: 'https://creator.itch.io/volcanic-sinkhole-battlemap',
          },
        ],
        expected: {
          success: false as const,
          errorCode: 'purchase_not_found',
          errorMessage:
            'No purchase was found for this itch.io account. If you just bought, please try again in a moment.',
        },
        shouldGrantEntitlement: false,
      },
      {
        name: 'does not match the purchase id when the game id differs',
        providerProductRef: 'purchase-1',
        ownedKeys: [
          {
            ownedKeyId: 'owned-1',
            gameId: '42',
            purchaseId: 'purchase-1',
            gameTitle: 'Volcanic Sinkhole Battlemap',
            gameUrl: 'https://creator.itch.io/volcanic-sinkhole-battlemap',
          },
        ],
        expected: {
          success: false as const,
          errorCode: 'purchase_not_found',
          errorMessage:
            'No purchase was found for this itch.io account. If you just bought, please try again in a moment.',
        },
        shouldGrantEntitlement: false,
      },
    ] as const;

    for (const testCase of cases) {
      const entitlementChecks = testCase.shouldGrantEntitlement ? [false, true] : [false];
      queryMock.mockClear();
      mutationMock.mockClear();
      fetchOwnedKeysMock.mockResolvedValueOnce([...testCase.ownedKeys]);
      mutationMock.mockImplementation(async () => null);
      queryMock.mockImplementation(async (ref) => {
        switch (ref) {
          case apiMock.verificationIntents.getIntentRecord:
            return buildPendingIntent({
              creatorAuthUserId: 'creator_1',
              productId: 'product_1',
              providerProductRef: testCase.providerProductRef,
            });
          case apiMock.subjects.getSubjectByAuthId:
            return {
              found: true,
              subject: { _id: 'subject_1' },
            };
          case internalMock.subjects.getBuyerProviderLinkForSubject:
            return buildActiveBuyerProviderLink();
          case apiMock.identitySync.getExternalAccountOAuthCredentials:
            return {
              oauthAccessTokenEncrypted: 'enc:buyer-access-token',
            };
          case internalMock.yucpLicenses.getProductByProviderRef:
            return {
              authUserId: 'creator_1',
              productId: 'product_1',
              displayName: 'Volcanic Sinkhole Battlemap',
            };
          case internalMock.yucpLicenses.checkSubjectEntitlement:
            return entitlementChecks.length > 1
              ? (entitlementChecks.shift() ?? false)
              : (entitlementChecks[0] ?? false);
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
          intentId: 'intent_owned_key' as never,
          methodKey: 'itchio-link',
        },
        makeCtx()
      );

      expect(result, testCase.name).toEqual(testCase.expected);
      expect(
        mutationMock.mock.calls.some(([ref]) => ref === apiMock.entitlements.grantEntitlement),
        testCase.name
      ).toBe(testCase.shouldGrantEntitlement);
    }
  });

  it('rejects malformed itch account-link intents that are missing the providerProductRef', async () => {
    const cases = [
      {
        name: 'current shape with creator context but no provider product reference',
        intentRequirement: {
          creatorAuthUserId: 'creator_1',
          productId: 'product_1',
        },
      },
      {
        name: 'legacy shape with neither creator context nor provider product reference',
        intentRequirement: {},
      },
    ] as const;

    for (const testCase of cases) {
      queryMock.mockClear();
      mutationMock.mockClear();
      resolveBuyerVerificationStoreContextMock.mockClear();
      mockHostedVerificationQueries({
        intentRequirement: testCase.intentRequirement,
      });

      const plugin = createItchioBuyerLinkPlugin();
      if (!plugin.verifyHostedIntent) {
        throw new Error('Expected verifyHostedIntent to be defined for itch.io');
      }

      const result = await plugin.verifyHostedIntent(
        {
          authUserId: 'buyer-auth-user',
          intentId: 'intent_missing_ref' as never,
          methodKey: 'itchio-link',
        },
        makeCtx()
      );

      expect(result, testCase.name).toEqual({
        success: false,
        errorCode: 'invalid_method',
        errorMessage:
          'Verification method is missing the itch.io product reference required for linked account verification.',
      });
      expect(resolveBuyerVerificationStoreContextMock).not.toHaveBeenCalled();
      expect(mutationMock).toHaveBeenCalledWith(
        internalMock.verificationIntents.markIntentFailed,
        expect.objectContaining({
          intentId: 'intent_missing_ref',
          errorCode: 'invalid_method',
        })
      );
    }
  });
});
