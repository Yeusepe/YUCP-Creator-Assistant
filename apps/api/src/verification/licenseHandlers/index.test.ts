import { describe, expect, it, mock } from 'bun:test';
import { readdirSync } from 'node:fs';

const verificationPlugin = {
  verifyLicense: mock(async () => ({
    valid: true,
    externalOrderId: 'order_123',
    providerProductId: 'provider_product_123',
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
      mutation: mock(async () => ({
        success: true,
        entitlementIds: ['ent_123'],
      })),
    } as never;

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
      convex
    );

    expect(verificationPlugin.verifyLicense).toHaveBeenCalled();
    expect(getProviderRuntime).toHaveBeenCalledWith('with-verification');
    expect(result).toEqual({
      success: true,
      provider: 'with-verification',
      entitlementIds: ['ent_123'],
      error: 'License verification failed',
    });
  });

  it('returns null when a provider does not expose a verification plugin', () => {
    expect(getHandler('without-verification')).toBeNull();
  });
});
