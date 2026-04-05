import { describe, expect, it, mock } from 'bun:test';
import {
  createPayhipLicenseVerification,
  createPayhipProviderModule,
} from '../../src/payhip/module';

const logger = {
  info: mock(() => {}),
  warn: mock(() => {}),
};

const baseCtx = {
  convex: {
    query: mock(async () => {
      throw new Error('query not configured');
    }),
    mutation: mock(async () => {
      throw new Error('mutation not configured');
    }),
  },
  apiSecret: 'api-secret',
  authUserId: 'user-1',
  encryptionSecret: 'encryption-secret',
};

describe('createPayhipProviderModule', () => {
  it('maps stored product entries into provider product records', async () => {
    const module = createPayhipProviderModule({
      logger,
      async listProducts() {
        return [
          {
            permalink: 'RGsF',
            displayName: 'Starter Pack',
            productPermalink: undefined,
            hasSecretKey: true,
          },
        ];
      },
      async upsertProductName() {},
      async listProductSecretKeys() {
        return [];
      },
      async decryptProductSecretKey() {
        throw new Error('not used');
      },
      async verifyLicenseKey() {
        throw new Error('not used');
      },
    });

    const products = await module.fetchProducts(null, baseCtx);
    expect(products).toEqual([
      {
        id: 'RGsF',
        name: 'Starter Pack',
        productUrl: 'https://payhip.com/b/RGsF',
        hasSecretKey: true,
      },
    ]);
  });
});

describe('createPayhipLicenseVerification', () => {
  it('normalizes full Payhip URLs to canonical permalinks', async () => {
    const verification = createPayhipLicenseVerification({
      logger,
      async listProducts() {
        return [];
      },
      async upsertProductName() {},
      async listProductSecretKeys() {
        return [
          {
            permalink: 'https://payhip.com/b/KZFw0',
            encryptedSecretKey: 'enc-1',
          },
        ];
      },
      async decryptProductSecretKey() {
        return 'secret-key';
      },
      async verifyLicenseKey(_licenseKey, productKeys) {
        return {
          valid: true,
          matchedProductPermalink: productKeys[0]?.permalink,
        };
      },
    });

    const result = await verification.verifyLicense('TEST-KEY', undefined, 'user-1', baseCtx);

    expect(result).toEqual({
      valid: true,
      error: undefined,
      providerProductId: 'KZFw0',
    });
  });
});
