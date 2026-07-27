import { beforeEach, describe, expect, it, mock } from 'bun:test';

let actionImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  success: true,
  token: 'license.jwt',
  expiresAt: 123,
});
let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  intentId: 'intent_123',
});
let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;

mock.module('../../../../../convex/_generated/api', () => ({
  api: {
    packageRegistry: {
      getBuyerAccessContextByPackageId: 'packageRegistry.getBuyerAccessContextByPackageId',
    },
    verificationIntents: {
      createVerificationIntent: 'verificationIntents.createVerificationIntent',
      getVerificationIntent: 'verificationIntents.getVerificationIntent',
      redeemVerificationIntent: 'verificationIntents.redeemVerificationIntent',
    },
  },
  internal: {},
  components: {},
}));

mock.module('../../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    action: (...args: unknown[]) => actionImpl(...args),
    mutation: (...args: unknown[]) => mutationImpl(...args),
    query: (...args: unknown[]) => queryImpl(...args),
  }),
}));

mock.module('../../verification/verificationConfig', () => ({
  getVerificationConfig: () => ({ clientId: 'configured' }),
}));

mock.module('./auth', () => ({
  resolveAuth: async () => ({
    authUserId: 'user_abc',
    actorBinding: {
      payload: 'test-payload',
      signature: 'test-signature',
    },
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
  apiBaseUrl: 'https://public-api.test.example',
};

beforeEach(() => {
  actionImpl = async () => ({
    success: true,
    token: 'license.jwt',
    expiresAt: 123,
  });
  mutationImpl = async () => ({
    intentId: 'intent_123',
  });
  queryImpl = async () => null;
});

describe('handleVerificationIntentsRoutes', () => {
  it('derives every supported storefront verification method from the bound package identity', async () => {
    const observedMutations: unknown[][] = [];
    queryImpl = async (reference: unknown) => {
      expect(reference).toBe('packageRegistry.getBuyerAccessContextByPackageId');
      return {
        aliasId: 'com.yucp.jammr',
        catalogProductId: 'catalog_gumroad',
        catalogProductIds: ['catalog_gumroad', 'catalog_jinxxy'],
        creatorAuthUserId: 'creator_123',
        displayName: 'JAMMR',
        packageId: 'com.yucp.jammr',
        productId: 'gumroad_jammr',
        provider: 'gumroad',
        providerProductRef: 'jammr-gumroad',
        status: 'active',
        storefronts: [
          {
            catalogProductId: 'catalog_gumroad',
            productId: 'gumroad_jammr',
            provider: 'gumroad',
            providerProductRef: 'jammr-gumroad',
          },
          {
            catalogProductId: 'catalog_jinxxy',
            productId: 'jinxxy_jammr',
            provider: 'jinxxy',
            providerProductRef: 'jammr-jinxxy',
          },
        ],
      };
    };
    mutationImpl = async (...args: unknown[]) => {
      observedMutations.push(args);
      return { intentId: 'intent_123' };
    };
    actionImpl = async () => ({
      _id: 'intent_123',
      authUserId: 'user_abc',
      packageId: 'com.yucp.jammr',
      packageName: 'JAMMR',
      requirements: [],
      status: 'pending',
      returnUrl: 'http://127.0.0.1:42123/callback',
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const response = await handleVerificationIntentsRoutes(
      new Request(
        'https://public-api.test.example/api/public/v2/verification-intents/package-access',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            packageAliasId: 'com.yucp.jammr',
            packageName: 'Untrusted client label',
            machineFingerprint: 'machine-fingerprint',
            codeChallenge: 'code-challenge',
            returnUrl: 'http://127.0.0.1:42123/callback',
            idempotencyKey: 'idempotency-key',
            requirements: [
              {
                kind: 'manual_license',
                methodKey: 'attacker-method',
                providerKey: 'attacker',
              },
            ],
          }),
        }
      ),
      '/verification-intents/package-access',
      config
    );

    expect(response.status).toBe(200);
    expect(observedMutations).toHaveLength(1);
    expect(observedMutations[0]?.[0]).toBe('verificationIntents.createVerificationIntent');
    expect(observedMutations[0]?.[1]).toMatchObject({
      authUserId: 'user_abc',
      packageId: 'com.yucp.jammr',
      packageName: 'JAMMR',
    });
    const requirements = (
      observedMutations[0]?.[1] as {
        requirements: Array<{
          kind: string;
          methodKey: string;
          providerKey: string;
        }>;
      }
    ).requirements;
    expect(requirements.map(({ kind, providerKey }) => `${providerKey}:${kind}`).sort()).toEqual([
      'gumroad:buyer_provider_link',
      'gumroad:manual_license',
      'jinxxy:manual_license',
      'yucp:existing_entitlement',
      'yucp:existing_entitlement',
    ]);
    expect(requirements.some(({ methodKey }) => methodKey === 'attacker-method')).toBe(false);
  });

  it('fails closed when the requested package identity resolves across packages', async () => {
    let mutationCalls = 0;
    queryImpl = async () => ({
      aliasId: 'com.yucp.other',
      catalogProductId: 'catalog_other',
      catalogProductIds: ['catalog_other'],
      creatorAuthUserId: 'creator_123',
      displayName: 'Other',
      packageId: 'com.yucp.other',
      productId: 'other',
      provider: 'jinxxy',
      providerProductRef: 'other',
      status: 'active',
      storefronts: [],
    });
    mutationImpl = async () => {
      mutationCalls++;
      return { intentId: 'intent_123' };
    };

    const response = await handleVerificationIntentsRoutes(
      new Request(
        'https://public-api.test.example/api/public/v2/verification-intents/package-access',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            packageAliasId: 'com.yucp.jammr',
            machineFingerprint: 'machine-fingerprint',
            codeChallenge: 'code-challenge',
            returnUrl: 'http://127.0.0.1:42123/callback',
          }),
        }
      ),
      '/verification-intents/package-access',
      config
    );

    expect(response.status).toBe(404);
    expect(mutationCalls).toBe(0);
  });

  it('fails closed when the package identity has no explicit binding', async () => {
    let mutationCalls = 0;
    queryImpl = async () => null;
    mutationImpl = async () => {
      mutationCalls++;
      return { intentId: 'intent_123' };
    };

    const response = await handleVerificationIntentsRoutes(
      new Request(
        'https://public-api.test.example/api/public/v2/verification-intents/package-access',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            packageAliasId: 'com.yucp.missing',
            machineFingerprint: 'machine-fingerprint',
            codeChallenge: 'code-challenge',
            returnUrl: 'http://127.0.0.1:42123/callback',
          }),
        }
      ),
      '/verification-intents/package-access',
      config
    );

    expect(response.status).toBe(404);
    expect(mutationCalls).toBe(0);
  });

  it('keeps the existing caller-supplied intent route strict', async () => {
    const response = await handleVerificationIntentsRoutes(
      new Request('https://public-api.test.example/api/public/v2/verification-intents', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          packageId: 'com.yucp.jammr',
          machineFingerprint: 'machine-fingerprint',
          codeChallenge: 'code-challenge',
          returnUrl: 'http://127.0.0.1:42123/callback',
        }),
      }),
      '/verification-intents',
      config
    );

    expect(response.status).toBe(400);
  });

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
      issuerBaseUrl: 'https://public-api.test.example',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      token: 'license.jwt',
      expiresAt: 123,
    });
  });
});
