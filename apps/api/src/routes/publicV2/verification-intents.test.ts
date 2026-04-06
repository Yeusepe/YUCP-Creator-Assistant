import { beforeEach, describe, expect, it, mock } from 'bun:test';

let actionImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  success: true,
  token: 'license.jwt',
  expiresAt: 123,
});

mock.module('../../../../../convex/_generated/api', () => ({
  api: {
    verificationIntents: {
      redeemVerificationIntent: 'verificationIntents.redeemVerificationIntent',
    },
  },
  internal: {},
  components: {},
}));

mock.module('../../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    action: (...args: unknown[]) => actionImpl(...args),
  }),
}));

mock.module('./auth', () => ({
  resolveAuth: async () => ({
    authUserId: 'user_abc',
    scopes: ['verification:read'],
  }),
}));

const { handleVerificationIntentsRoutes } = await import('./verification-intents');

const config = {
  convexUrl: 'https://test.convex.cloud',
  convexApiSecret: 'test-secret',
  convexSiteUrl: 'https://test.convex.site',
  encryptionSecret: 'test-encryption-secret',
  frontendBaseUrl: 'https://creators.test',
  apiBaseUrl: 'https://dsktp.tailc472f7.ts.net',
};

beforeEach(() => {
  actionImpl = async () => ({
    success: true,
    token: 'license.jwt',
    expiresAt: 123,
  });
});

describe('handleVerificationIntentsRoutes', () => {
  it('redeems verification intents against the canonical API authority instead of the request origin', async () => {
    const observedCalls: unknown[][] = [];
    actionImpl = async (...args: unknown[]) => {
      observedCalls.push(args);
      return {
        success: true,
        token: 'license.jwt',
        expiresAt: 123,
      };
    };

    const response = await handleVerificationIntentsRoutes(
      new Request('http://internal-proxy/api/public/v2/verification-intents/intent_123/redeem', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          codeVerifier: 'verifier',
          machineFingerprint: 'machine-fingerprint',
          grantToken: 'grant-token',
        }),
      }),
      '/verification-intents/intent_123/redeem',
      config
    );

    expect(observedCalls[0]?.[0]).toBe('verificationIntents.redeemVerificationIntent');
    expect(observedCalls[0]?.[1]).toMatchObject({
      apiSecret: 'test-secret',
      authUserId: 'user_abc',
      intentId: 'intent_123',
      codeVerifier: 'verifier',
      machineFingerprint: 'machine-fingerprint',
      grantToken: 'grant-token',
      issuerBaseUrl: 'https://dsktp.tailc472f7.ts.net',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      token: 'license.jwt',
      expiresAt: 123,
    });
  });
});
