import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const handlerVerifyMock = mock(async () => ({
  success: true,
  provider: 'gumroad',
  entitlementIds: ['ent_123'],
}));

const getHandlerMock = mock(() => ({
  verify: handlerVerifyMock,
}));

const ensureSubjectAuthUserIdMock = mock(async (): Promise<string | null> => 'buyer_auth_user_456');

mock.module('../../../../convex/_generated/api', () => ({
  api: {},
  internal: {
    subjects: {
      getSubjectIdentityById: 'internal.subjects.getSubjectIdentityById',
    },
  },
  components: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: mock(async () => null),
    mutation: mock(async () => null),
  }),
}));

const licenseHandlersModule = await import('./licenseHandlers/index');
spyOn(licenseHandlersModule, 'getHandler').mockImplementation(getHandlerMock);
const subjectIdentityModule = await import('../lib/subjectIdentity');
spyOn(subjectIdentityModule, 'ensureSubjectAuthUserId').mockImplementation(
  ensureSubjectAuthUserIdMock
);

const { handleCompleteLicense } = await import('./completeLicense');

afterAll(() => {
  mock.restore();
});

describe('handleCompleteLicense', () => {
  beforeEach(() => {
    handlerVerifyMock.mockClear();
    getHandlerMock.mockClear();
    ensureSubjectAuthUserIdMock.mockClear();
    ensureSubjectAuthUserIdMock.mockResolvedValue('buyer_auth_user_456');
  });

  it('resolves buyer identity from the buyer subject before delegating the write path', async () => {
    const result = await handleCompleteLicense(
      {
        convexUrl: 'https://convex.example',
        convexApiSecret: 'convex-secret',
      } as never,
      {
        licenseKey: 'license_123',
        provider: 'gumroad',
        productId: 'product_123',
        authUserId: 'creator_auth_user_123',
        subjectId: 'buyer_subject_456',
      }
    );

    expect(result.success).toBe(true);
    expect(ensureSubjectAuthUserIdMock).toHaveBeenCalledWith(
      expect.any(Object),
      'buyer_subject_456'
    );
    expect(handlerVerifyMock).toHaveBeenCalledWith(
      {
        licenseKey: 'license_123',
        provider: 'gumroad',
        productId: 'product_123',
        creatorAuthUserId: 'creator_auth_user_123',
        buyerAuthUserId: 'buyer_auth_user_456',
        buyerSubjectId: 'buyer_subject_456',
      },
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('continues legacy completion by materializing a light buyer account for an unlinked subject', async () => {
    ensureSubjectAuthUserIdMock.mockResolvedValueOnce('light_buyer_auth_user_789');

    const result = await handleCompleteLicense(
      {
        convexUrl: 'https://convex.example',
        convexApiSecret: 'convex-secret',
      } as never,
      {
        licenseKey: 'license_123',
        provider: 'gumroad',
        productId: 'product_123',
        authUserId: 'creator_auth_user_123',
        subjectId: 'buyer_subject_456',
      }
    );

    expect(result.success).toBe(true);
    expect(handlerVerifyMock).toHaveBeenCalledWith(
      {
        licenseKey: 'license_123',
        provider: 'gumroad',
        productId: 'product_123',
        creatorAuthUserId: 'creator_auth_user_123',
        buyerAuthUserId: 'light_buyer_auth_user_789',
        buyerSubjectId: 'buyer_subject_456',
      },
      expect.any(Object),
      expect.any(Object)
    );
  });
});
