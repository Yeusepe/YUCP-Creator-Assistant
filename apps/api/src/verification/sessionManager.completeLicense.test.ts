import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { VerificationConfig } from './verificationConfig';

const handleCompleteLicenseMock = mock(async (_config?: unknown, _input?: unknown) => ({
  success: true,
  provider: 'gumroad',
  entitlementIds: ['ent_123'],
}));
const resolveSubjectAuthUserIdMock = mock(async (): Promise<string | null> => 'buyer_auth_user_456');

mock.module('./completeLicense', () => ({
  handleCompleteLicense: handleCompleteLicenseMock,
}));

const providersMock = {
  getBuyerLinkPluginByMode: mock(() => undefined),
  listBuyerLinkPlugins: mock(() => []),
  getProviderRuntime: mock(() => undefined),
};

mock.module('../providers', () => providersMock);
mock.module('../providers/index', () => providersMock);
mock.module('../providers/index.ts', () => providersMock);

const subjectIdentityModule = await import('../lib/subjectIdentity');
spyOn(subjectIdentityModule, 'resolveSubjectAuthUserId').mockImplementation(
  resolveSubjectAuthUserIdMock
);
const { createVerificationRoutes } = await import('./sessionManager');

const testConfig: VerificationConfig = {
  baseUrl: 'https://api.example.com',
  frontendUrl: 'https://app.example.com',
  convexUrl: 'https://convex.example',
  convexApiSecret: 'api-secret',
  gumroadClientId: 'gumroad-client-id',
  gumroadClientSecret: 'gumroad-client-secret',
};

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  handleCompleteLicenseMock.mockReset();
  handleCompleteLicenseMock.mockResolvedValue({
    success: true,
    provider: 'gumroad',
    entitlementIds: ['ent_123'],
  });
  resolveSubjectAuthUserIdMock.mockReset();
  resolveSubjectAuthUserIdMock.mockResolvedValue('buyer_auth_user_456');
});

describe('complete-license verification route', () => {
  it('forwards the creator lookup actor separately from the buyer link actor', async () => {
    const routes = createVerificationRoutes(testConfig);

    const response = await routes.completeLicenseVerification(
      new Request('https://api.example.com/api/verification/complete-license', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          apiSecret: 'api-secret',
          licenseKey: 'license_123',
          provider: 'gumroad',
          productId: 'product_123',
          creatorAuthUserId: 'creator_auth_user_123',
          buyerAuthUserId: 'buyer_auth_user_456',
          buyerSubjectId: 'buyer_subject_456',
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      provider: 'gumroad',
      entitlementIds: ['ent_123'],
    });

    expect(handleCompleteLicenseMock).toHaveBeenCalledWith(testConfig, {
      licenseKey: 'license_123',
      provider: 'gumroad',
      productId: 'product_123',
      creatorAuthUserId: 'creator_auth_user_123',
      buyerAuthUserId: 'buyer_auth_user_456',
      buyerSubjectId: 'buyer_subject_456',
    });

    const forwardedBody = handleCompleteLicenseMock.mock.calls[0]?.[1];
    expect(forwardedBody).toBeDefined();
    expect(forwardedBody).not.toHaveProperty('authUserId');
    expect(forwardedBody).not.toHaveProperty('subjectId');
  });

  it('resolves the buyer actor from the subject before forwarding legacy input', async () => {
    const routes = createVerificationRoutes(testConfig);

    await routes.completeLicenseVerification(
      new Request('https://api.example.com/api/verification/complete-license', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          apiSecret: 'api-secret',
          licenseKey: 'license_legacy',
          provider: 'gumroad',
          productId: 'product_legacy',
          authUserId: 'legacy_auth_user',
          subjectId: 'legacy_subject',
        }),
      })
    );

    expect(handleCompleteLicenseMock).toHaveBeenCalledWith(testConfig, {
      licenseKey: 'license_legacy',
      provider: 'gumroad',
      productId: 'product_legacy',
      creatorAuthUserId: 'legacy_auth_user',
      buyerAuthUserId: 'buyer_auth_user_456',
      buyerSubjectId: 'legacy_subject',
    });

    const forwardedBody = handleCompleteLicenseMock.mock.calls[0]?.[1];
    expect(forwardedBody).toBeDefined();
    expect(forwardedBody).not.toHaveProperty('authUserId');
    expect(forwardedBody).not.toHaveProperty('subjectId');
  });

  it('rejects legacy input when the buyer subject is not linked to a YUCP account', async () => {
    resolveSubjectAuthUserIdMock.mockResolvedValueOnce(null);
    const routes = createVerificationRoutes(testConfig);

    const response = await routes.completeLicenseVerification(
      new Request('https://api.example.com/api/verification/complete-license', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          apiSecret: 'api-secret',
          licenseKey: 'license_unlinked',
          provider: 'gumroad',
          productId: 'product_unlinked',
          authUserId: 'legacy_auth_user',
          subjectId: 'legacy_subject',
        }),
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Verification subject must be linked to a YUCP account before completion',
    });
    expect(handleCompleteLicenseMock).not.toHaveBeenCalled();
  });
});
