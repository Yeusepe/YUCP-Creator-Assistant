import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const queryMock = mock(
  async (
    ref: unknown,
    _args?: unknown
  ): Promise<
    | { _id: string; authUserId: string | null }
    | Array<{
        productId: string;
        catalogProductId: string;
        providerProductRef: string;
      }>
  > => {
    if (ref === 'internal.subjects.getSubjectIdentityById') {
      return {
        _id: 'buyer_subject_456',
        authUserId: 'buyer_auth_user_456',
      };
    }

    return [
      {
        productId: 'product_123',
        catalogProductId: 'catalog_123',
        providerProductRef: 'avatar_123',
      },
    ];
  }
);

const mutationMock = mock(async () => ({
  success: true,
  entitlementIds: ['ent_123'],
}));
const ensureSubjectAuthUserIdMock = mock(async (): Promise<string | null> => 'buyer_auth_user_456');

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    role_rules: {
      getVrchatCatalogProductsMatchingAvatars: 'role_rules.getVrchatCatalogProductsMatchingAvatars',
    },
    licenseVerification: {
      completeLicenseVerification: 'licenseVerification.completeLicenseVerification',
    },
  },
  internal: {
    subjects: {
      getSubjectIdentityById: 'internal.subjects.getSubjectIdentityById',
    },
  },
  components: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: queryMock,
    mutation: mutationMock,
  }),
}));

const subjectIdentityModule = await import('../lib/subjectIdentity');
spyOn(subjectIdentityModule, 'ensureSubjectAuthUserId').mockImplementation(
  ensureSubjectAuthUserIdMock
);
const { handleCompleteVrchat } = await import('./completeVrchat');

afterAll(() => {
  mock.restore();
});

describe('handleCompleteVrchat', () => {
  beforeEach(() => {
    queryMock.mockClear();
    mutationMock.mockClear();
    ensureSubjectAuthUserIdMock.mockClear();
    ensureSubjectAuthUserIdMock.mockResolvedValue('buyer_auth_user_456');
  });

  it('keeps catalog lookups on the creator while writing bindings under the buyer identity', async () => {
    const result = await handleCompleteVrchat(
      {
        convexUrl: 'https://convex.example',
        convexApiSecret: 'convex-secret',
      } as never,
      {
        authUserId: 'creator_auth_user_123',
        subjectId: 'buyer_subject_456',
        vrchatUserId: 'usr_123',
        displayName: 'Buyer Display',
        ownedAvatarIds: ['avatar_123'],
      }
    );

    expect(result.success).toBe(true);
    expect(ensureSubjectAuthUserIdMock).toHaveBeenCalledWith(
      expect.any(Object),
      'buyer_subject_456'
    );
    expect(queryMock.mock.calls[0]?.[0]).toBe('role_rules.getVrchatCatalogProductsMatchingAvatars');
    expect(queryMock.mock.calls[0]?.[1]).toEqual({
      apiSecret: 'convex-secret',
      authUserId: 'creator_auth_user_123',
      ownedAvatarIds: ['avatar_123'],
    });
    expect(mutationMock).toHaveBeenCalledWith(
      'licenseVerification.completeLicenseVerification',
      expect.objectContaining({
        creatorAuthUserId: 'creator_auth_user_123',
        buyerAuthUserId: 'buyer_auth_user_456',
        subjectId: 'buyer_subject_456',
      })
    );
  });

  it('continues legacy completion by materializing a light buyer account for an unlinked subject', async () => {
    ensureSubjectAuthUserIdMock.mockResolvedValueOnce('light_buyer_auth_user_789');

    const result = await handleCompleteVrchat(
      {
        convexUrl: 'https://convex.example',
        convexApiSecret: 'convex-secret',
      } as never,
      {
        authUserId: 'creator_auth_user_123',
        subjectId: 'buyer_subject_456',
        vrchatUserId: 'usr_123',
        displayName: 'Buyer Display',
        ownedAvatarIds: ['avatar_123'],
      }
    );

    expect(result.success).toBe(true);
    expect(mutationMock).toHaveBeenCalledWith(
      'licenseVerification.completeLicenseVerification',
      expect.objectContaining({
        creatorAuthUserId: 'creator_auth_user_123',
        buyerAuthUserId: 'light_buyer_auth_user_789',
        subjectId: 'buyer_subject_456',
      })
    );
  });
});
