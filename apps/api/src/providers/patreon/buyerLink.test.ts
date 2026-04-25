import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { CredentialExpiredError } from '@yucp/providers/contracts';
import type { ConvexServerClient } from '../../lib/convex';

const apiMock = {
  verificationIntents: {
    getIntentRecord: 'verificationIntents.getIntentRecord',
  },
  subjects: {
    getSubjectByAuthId: 'subjects.getSubjectByAuthId',
  },
  identitySync: {
    getExternalAccountOAuthCredentials: 'identitySync.getExternalAccountOAuthCredentials',
    storeExternalAccountOAuthCredentials: 'identitySync.storeExternalAccountOAuthCredentials',
  },
  yucpLicenses: {
    lookupProductByProviderRef: 'yucpLicenses.lookupProductByProviderRef',
  },
  providerConnections: {
    listConnectionsForUser: 'providerConnections.listConnectionsForUser',
  },
  providerPlatform: {
    upsertProviderMembership: 'providerPlatform.upsertProviderMembership',
    upsertEntitlementEvidence: 'providerPlatform.upsertEntitlementEvidence',
  },
  entitlements: {
    grantEntitlement: 'entitlements.grantEntitlement',
    revokeEntitlementBySourceRef: 'entitlements.revokeEntitlementBySourceRef',
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
    checkSubjectEntitlement: 'yucpLicenses.checkSubjectEntitlement',
  },
} as const;

const encryptMock = mock(
  async (value: string, _secret: string, purpose: string) => `enc:${purpose}:${value}`
);
const decryptMock = mock(async (value: string) => value.replace(/^enc:[^:]+:/, ''));
const fetchBuyerIdentityMock = mock(async () => ({
  providerUserId: 'patreon-user-1',
  username: 'patron',
  email: 'patron@example.com',
  memberships: [
    {
      id: 'member_1',
      campaignId: 'campaign_1',
      entitledTierIds: ['tier_basic', 'tier_bonus'],
      patronStatus: 'active_patron',
      lastChargeStatus: 'Paid',
      lastChargeDate: '2026-04-24T18:23:04.691Z',
      pledgeRelationshipStart: '2026-04-20T18:23:04.691Z',
    },
  ],
}));

mock.module('../../../../../convex/_generated/api', () => ({
  api: apiMock,
  internal: internalMock,
  components: {},
}));

mock.module('@yucp/providers/patreon/module', () => ({
  PATREON_PURPOSES: {
    credential: 'patreon-oauth-access-token',
    refreshToken: 'patreon-oauth-refresh-token',
    buyerCredential: 'patreon-oauth-buyer-access-token',
    buyerRefreshToken: 'patreon-oauth-buyer-refresh-token',
  },
  fetchPatreonBuyerIdentity: fetchBuyerIdentityMock,
}));

mock.module('../../lib/encrypt', () => ({
  encrypt: encryptMock,
  decrypt: decryptMock,
}));

mock.module('../../verification/buyerVerificationHelpers', () => ({
  resolveBuyerVerificationStoreContext: mock(async () => ({
    ok: true as const,
    creatorAuthUserId: 'creator_1',
    creatorProductId: 'product_1',
    displayName: 'Campaign Alpha',
  })),
}));

const { createPatreonBuyerLinkPlugin } = await import('./buyerLink');

let queryImpl: (ref: unknown, args?: unknown) => Promise<unknown>;
let mutationImpl: (ref: unknown, args?: unknown) => Promise<unknown>;
const queryMock = mock((ref: unknown, args?: unknown) => queryImpl(ref, args));
const mutationMock = mock((ref: unknown, args?: unknown) => mutationImpl(ref, args));

function makeCtx(): {
  convex: ConvexServerClient;
  apiSecret: string;
  encryptionSecret: string;
} {
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

function buildPendingIntent(requirementOverrides: Record<string, unknown> = {}) {
  return {
    status: 'pending',
    expiresAt: Date.now() + 60_000,
    packageId: 'package_1',
    requirements: [
      {
        methodKey: 'patreon-link',
        providerKey: 'patreon',
        kind: 'buyer_provider_link',
        providerProductRef: 'campaign_1',
        creatorAuthUserId: 'creator_1',
        productId: 'product_1',
        ...requirementOverrides,
      },
    ],
  };
}

beforeEach(() => {
  queryMock.mockClear();
  mutationMock.mockClear();
  encryptMock.mockClear();
  decryptMock.mockClear();
  fetchBuyerIdentityMock.mockClear();

  queryImpl = async (ref) => {
    switch (ref) {
      case apiMock.yucpLicenses.lookupProductByProviderRef:
        return {
          authUserId: 'creator_1',
          productId: 'product_1',
          displayName: 'Campaign Alpha',
        };
      case apiMock.providerConnections.listConnectionsForUser:
        return [{ id: 'conn_1', provider: 'patreon' }];
      default:
        return null;
    }
  };

  mutationImpl = async (ref) => {
    switch (ref) {
      case apiMock.providerPlatform.upsertProviderMembership:
        return 'membership_record_1';
      default:
        return null;
    }
  };
});

afterAll(() => {
  mock.restore();
});

describe('patreon buyer link plugin', () => {
  it('uses the shared connect callback route for account linking', () => {
    const plugin = createPatreonBuyerLinkPlugin();

    expect(plugin.oauth.callbackPath).toBe('/api/connect/patreon/callback');
    expect(plugin.oauth.callbackHandler).toBe('connect-plugin');
  });

  it('stores encrypted buyer access and refresh tokens', async () => {
    const plugin = createPatreonBuyerLinkPlugin({
      encryptCredential: encryptMock,
    });
    if (!plugin.storeCredential) {
      throw new Error('Expected storeCredential to be defined for Patreon');
    }

    await plugin.storeCredential(
      {
        externalAccountId: 'external_1' as never,
        accessToken: 'buyer-access',
        refreshToken: 'buyer-refresh',
        expiresAt: 123,
      },
      makeCtx()
    );

    expect(encryptMock).toHaveBeenCalledWith(
      'buyer-access',
      'encrypt-secret',
      'patreon-oauth-buyer-access-token'
    );
    expect(encryptMock).toHaveBeenCalledWith(
      'buyer-refresh',
      'encrypt-secret',
      'patreon-oauth-buyer-refresh-token'
    );
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.identitySync.storeExternalAccountOAuthCredentials,
      expect.objectContaining({
        externalAccountId: 'external_1',
        oauthAccessTokenEncrypted: 'enc:patreon-oauth-buyer-access-token:buyer-access',
        oauthRefreshTokenEncrypted: 'enc:patreon-oauth-buyer-refresh-token:buyer-refresh',
        oauthTokenExpiresAt: 123,
      })
    );
  });

  it('syncs membership evidence after linking the buyer account', async () => {
    const plugin = createPatreonBuyerLinkPlugin({
      fetchBuyerIdentity: fetchBuyerIdentityMock,
    });
    if (!plugin.afterLink) {
      throw new Error('Expected afterLink to be defined for Patreon');
    }

    await plugin.afterLink(
      {
        authUserId: 'buyer_1',
        sessionId: 'session_1' as never,
        sessionMode: 'patreon',
        accessToken: 'buyer-access',
        subjectId: 'subject_1' as never,
        externalAccountId: 'external_1' as never,
        identity: {
          providerUserId: 'patreon-user-1',
        },
      },
      makeCtx()
    );

    expect(fetchBuyerIdentityMock).toHaveBeenCalledWith('buyer-access', {});
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.providerPlatform.upsertProviderMembership,
      expect.objectContaining({
        providerKey: 'patreon',
        externalMembershipId: 'member_1',
        externalProductId: 'campaign_1',
        externalVariantId: 'tier_basic',
        externalCustomerId: 'patreon-user-1',
        metadata: expect.objectContaining({
          activeTierRefs: ['tier_basic', 'tier_bonus'],
        }),
      })
    );
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.providerPlatform.upsertEntitlementEvidence,
      expect.objectContaining({
        subjectId: 'subject_1',
        providerKey: 'patreon',
        productId: 'product_1',
        metadata: expect.objectContaining({
          activeTierRefs: ['tier_basic', 'tier_bonus'],
          campaignId: 'campaign_1',
        }),
      })
    );
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.entitlements.grantEntitlement,
      expect.objectContaining({
        authUserId: 'creator_1',
        productId: 'product_1',
        evidence: expect.objectContaining({
          provider: 'patreon',
          sourceReference: 'patreon:member:member_1:campaign:campaign_1',
          rawEvidence: expect.objectContaining({
            entitledTierIds: ['tier_basic', 'tier_bonus'],
          }),
        }),
      })
    );
  });

  it('verifies a hosted intent after re-syncing the required campaign', async () => {
    let entitlementChecks = 0;
    queryImpl = async (ref, _args) => {
      switch (ref) {
        case apiMock.verificationIntents.getIntentRecord:
          return buildPendingIntent();
        case apiMock.subjects.getSubjectByAuthId:
          return {
            found: true,
            subject: { _id: 'subject_1' },
          };
        case internalMock.yucpLicenses.checkSubjectEntitlement:
          entitlementChecks += 1;
          return entitlementChecks > 1;
        case internalMock.subjects.getBuyerProviderLinkForSubject:
          return {
            id: 'link_1',
            status: 'active',
            externalAccountId: 'external_1',
          };
        case apiMock.identitySync.getExternalAccountOAuthCredentials:
          return {
            oauthAccessTokenEncrypted: 'enc:patreon-oauth-buyer-access-token:buyer-access',
          };
        case apiMock.yucpLicenses.lookupProductByProviderRef:
          return {
            authUserId: 'creator_1',
            productId: 'product_1',
            displayName: 'Campaign Alpha',
          };
        case apiMock.providerConnections.listConnectionsForUser:
          return [{ id: 'conn_1', provider: 'patreon' }];
        default:
          return null;
      }
    };

    const plugin = createPatreonBuyerLinkPlugin({
      fetchBuyerIdentity: fetchBuyerIdentityMock,
      decryptCredential: decryptMock,
    });
    if (!plugin.verifyHostedIntent) {
      throw new Error('Expected verifyHostedIntent to be defined for Patreon');
    }

    const result = await plugin.verifyHostedIntent(
      {
        authUserId: 'buyer_1',
        intentId: 'intent_1' as never,
        methodKey: 'patreon-link',
      },
      makeCtx()
    );

    expect(result).toEqual({ success: true });
    expect(fetchBuyerIdentityMock).toHaveBeenCalledWith('buyer-access', {});
    expect(mutationMock).toHaveBeenCalledWith(internalMock.verificationIntents.markIntentVerified, {
      intentId: 'intent_1',
      methodKey: 'patreon-link',
    });
  });

  it('marks the buyer link expired when Patreon says the credential is no longer valid', async () => {
    queryImpl = async (ref) => {
      switch (ref) {
        case apiMock.verificationIntents.getIntentRecord:
          return buildPendingIntent();
        case apiMock.subjects.getSubjectByAuthId:
          return {
            found: true,
            subject: { _id: 'subject_1' },
          };
        case internalMock.yucpLicenses.checkSubjectEntitlement:
          return false;
        case internalMock.subjects.getBuyerProviderLinkForSubject:
          return {
            id: 'link_1',
            status: 'active',
            externalAccountId: 'external_1',
          };
        case apiMock.identitySync.getExternalAccountOAuthCredentials:
          return {
            oauthAccessTokenEncrypted: 'enc:patreon-oauth-buyer-access-token:buyer-access',
          };
        default:
          return null;
      }
    };

    const plugin = createPatreonBuyerLinkPlugin({
      decryptCredential: decryptMock,
      fetchBuyerIdentity: mock(async () => {
        throw new CredentialExpiredError('expired');
      }),
    });
    if (!plugin.verifyHostedIntent) {
      throw new Error('Expected verifyHostedIntent to be defined for Patreon');
    }

    const result = await plugin.verifyHostedIntent(
      {
        authUserId: 'buyer_1',
        intentId: 'intent_1' as never,
        methodKey: 'patreon-link',
      },
      makeCtx()
    );

    expect(result).toEqual({
      success: false,
      errorCode: 'provider_link_expired',
      errorMessage: 'The linked Patreon account must be reconnected before it can be used.',
    });
    expect(mutationMock).toHaveBeenCalledWith(internalMock.subjects.markBuyerProviderLinkExpired, {
      linkId: 'link_1',
    });
    expect(mutationMock).toHaveBeenCalledWith(
      internalMock.verificationIntents.markIntentFailed,
      expect.objectContaining({
        intentId: 'intent_1',
        errorCode: 'provider_link_expired',
      })
    );
  });
});
