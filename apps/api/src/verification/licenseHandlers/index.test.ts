import { describe, expect, it, mock } from 'bun:test';
import { readdirSync } from 'node:fs';

const verificationPlugin = {
  verifyLicense: mock(async () => ({
    valid: true,
    externalOrderId: 'order_123',
    externalLicenseId: 'license_abc',
    providerProductId: 'provider_product_123',
    providerTierRef: 'version_advanced',
  })),
};

const getProviderRuntime = mock((providerId: string) => {
  if (providerId === 'with-verification') {
    return {
      id: providerId,
      verification: verificationPlugin,
    };
  }

  if (providerId === 'without-verification') {
    return {
      id: providerId,
    };
  }

  return undefined;
});

mock.module('../../../../../convex/_generated/api', () => ({
  api: {
    licenseVerification: {
      completeLicenseVerification: 'licenseVerification.completeLicenseVerification',
    },
    yucpLicenses: {
      lookupProductByProviderRefForCreator: 'yucpLicenses.lookupProductByProviderRefForCreator',
    },
  },
  internal: {},
  components: {},
}));

mock.module('../../providers/index', () => ({
  getProviderRuntime,
}));

const { getHandler } = await import('./index');

describe('license verification handler registry', () => {
  it('keeps licenseHandlers limited to the registry adapter', () => {
    const productionEntries = readdirSync(import.meta.dir)
      .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
      .sort();

    expect(productionEntries).toEqual(['index.ts']);
  });

  it('derives handlers directly from the provider runtime registry', async () => {
    const convex = {
      query: mock(async (_reference: string, args: { providerProductRef: string }) => ({
        authUserId: 'auth_user_123',
        productId: 'logical_product_123',
        catalogProductId: 'catalog_product_123',
        providerProductRef: args.providerProductRef,
      })),
      mutation: mock(async () => ({
        success: true,
        entitlementIds: ['ent_123'],
      })),
    };

    const handler = getHandler('with-verification');
    expect(handler).not.toBeNull();

    const result = await handler?.verify(
      {
        licenseKey: 'license_123',
        productId: 'product_123',
        authUserId: 'auth_user_123',
        subjectId: 'subject_123',
      },
      {
        convexApiSecret: 'convex-api-secret',
        convexUrl: 'https://convex.example',
        encryptionSecret: 'encryption-secret',
      } as never,
      convex as never
    );

    expect(verificationPlugin.verifyLicense).toHaveBeenCalled();
    expect(getProviderRuntime).toHaveBeenCalledWith('with-verification');
    expect(result).toEqual({
      success: true,
      provider: 'with-verification',
      entitlementIds: ['ent_123'],
      error: 'License verification failed',
    });

    expect(convex.mutation).toHaveBeenCalledWith(
      'licenseVerification.completeLicenseVerification',
      expect.objectContaining({
        licenseSubjectLink: {
          licenseSubject: expect.stringMatching(/^[0-9a-f]{64}$/),
          licenseKeyEncrypted: expect.any(String),
          providerProductId: 'provider_product_123',
        },
        productsToGrant: [
          {
            catalogProductId: 'catalog_product_123',
            productId: 'logical_product_123',
            sourceReference: 'with-verification:order_123:license_abc',
            providerTierRefs: ['version_advanced'],
          },
        ],
      })
    );
  });

  it('uses creator identity for license lookup and buyer identity for account linking', async () => {
    const convex = {
      query: mock(async () => ({
        authUserId: 'creator_auth_user_123',
        productId: 'logical_product_456',
        catalogProductId: 'catalog_product_456',
      })),
      mutation: mock(async () => ({
        success: true,
        entitlementIds: ['ent_123'],
      })),
    };

    const handler = getHandler('with-verification');
    expect(handler).not.toBeNull();

    await handler?.verify(
      {
        licenseKey: 'license_456',
        productId: 'product_456',
        creatorAuthUserId: 'creator_auth_user_123',
        buyerAuthUserId: 'buyer_auth_user_456',
        buyerSubjectId: 'buyer_subject_456',
      } as never,
      {
        convexApiSecret: 'convex-api-secret',
        convexUrl: 'https://convex.example',
        encryptionSecret: 'encryption-secret',
      } as never,
      convex as never
    );

    expect(verificationPlugin.verifyLicense).toHaveBeenCalledWith(
      'license_456',
      'product_456',
      'creator_auth_user_123',
      expect.objectContaining({
        authUserId: 'creator_auth_user_123',
      })
    );
    expect(convex.mutation).toHaveBeenCalledWith(
      'licenseVerification.completeLicenseVerification',
      expect.objectContaining({
        creatorAuthUserId: 'creator_auth_user_123',
        buyerAuthUserId: 'buyer_auth_user_456',
        subjectId: 'buyer_subject_456',
      })
    );
  });

  it('rejects a verified license for another creator product', async () => {
    const convex = {
      query: mock(async (_reference: string, args: { providerProductRef: string }) => ({
        authUserId: 'creator_auth_user_123',
        productId:
          args.providerProductRef === 'product_123'
            ? 'logical_product_123'
            : 'logical_product_other',
        catalogProductId:
          args.providerProductRef === 'product_123'
            ? 'catalog_product_123'
            : 'catalog_product_other',
      })),
      mutation: mock(async () => ({
        success: true,
        entitlementIds: ['ent_123'],
      })),
    };

    const handler = getHandler('with-verification');
    const result = await handler?.verify(
      {
        licenseKey: 'license_for_other_product',
        productId: 'product_123',
        creatorAuthUserId: 'creator_auth_user_123',
        buyerAuthUserId: 'buyer_auth_user_456',
        buyerSubjectId: 'buyer_subject_456',
      } as never,
      {
        convexApiSecret: 'convex-api-secret',
        convexUrl: 'https://convex.example',
        encryptionSecret: 'encryption-secret',
      } as never,
      convex as never
    );

    expect(result).toEqual({
      success: false,
      error: 'License does not belong to the requested product',
    });
    expect(convex.mutation).not.toHaveBeenCalled();
  });

  it('returns null when a provider does not expose a verification plugin', () => {
    expect(getHandler('without-verification')).toBeNull();
  });
});
