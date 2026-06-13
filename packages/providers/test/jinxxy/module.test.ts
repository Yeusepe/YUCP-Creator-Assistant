import { describe, expect, it } from 'bun:test';
import type { ProviderContext, ProviderRuntimeClient } from '../../src/contracts';
import {
  createJinxxyLicenseVerification,
  createJinxxyProviderModule,
} from '../../src/jinxxy/module';
import { JinxxyApiError } from '../../src/jinxxy/types';

function makeCtx(): ProviderContext<ProviderRuntimeClient> {
  return {
    convex: {
      query: async <_QueryRef, _Args, Result>() => null as Result,
      mutation: async <_MutationRef, _Args, Result>() => null as Result,
    },
    apiSecret: 'api-secret',
    authUserId: 'user-1',
    encryptionSecret: 'enc-secret',
  };
}

const logger = {
  warn() {},
};

describe('createJinxxyProviderModule', () => {
  it('deduplicates owner and collaborator products by id', async () => {
    const module = createJinxxyProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-owner';
      },
      async decryptCredential(encryptedCredential) {
        return encryptedCredential === 'encrypted-owner' ? 'owner-key' : 'collab-key';
      },
      async listCollaboratorConnections() {
        return [
          {
            id: 'collab-1',
            provider: 'jinxxy',
            credentialEncrypted: 'encrypted-collab',
            collaboratorDisplayName: 'Collab',
          },
        ];
      },
      createClient(apiKey) {
        return {
          async getProducts({ page }) {
            if (apiKey === 'owner-key') {
              return {
                products:
                  page === 1
                    ? [
                        { id: 'a', name: 'Owner Product' },
                        { id: 'b', name: 'Shared Product' },
                      ]
                    : [],
                pagination: { has_next: false },
              };
            }
            return {
              products: [
                { id: 'b', name: 'Shared Product' },
                { id: 'c', name: 'Collab Product' },
              ],
              pagination: { has_next: false },
            };
          },
          async getProduct() {
            return null;
          },
          async verifyLicenseByKey() {
            return { valid: false };
          },
        };
      },
    });

    const products = await module.fetchProducts('owner-key', makeCtx());
    expect(products).toEqual([
      { id: 'a', name: 'Owner Product' },
      { id: 'b', name: 'Shared Product' },
      { id: 'c', name: 'Collab Product', collaboratorName: 'Collab' },
    ]);
  });

  it('hydrates Jinxxy product URLs and canonical slugs from the product detail endpoint', async () => {
    const module = createJinxxyProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-owner';
      },
      async decryptCredential() {
        return 'owner-key';
      },
      async listCollaboratorConnections() {
        return [];
      },
      createClient() {
        return {
          async getProducts() {
            return {
              products: [{ id: 'song-1', name: 'Song Thing' }],
              pagination: { has_next: false },
            };
          },
          async getProduct(productId) {
            expect(productId).toBe('song-1');
            return {
              id: 'song-1',
              name: 'Song Thing',
              url: 'https://jinxxy.com/song-thing',
              thumbnail_url: 'https://jinxxy-cdn.com/song-thing.png',
            };
          },
          async verifyLicenseByKey() {
            return { valid: false };
          },
        };
      },
    });

    const products = await module.fetchProducts('owner-key', makeCtx());
    expect(products).toEqual([
      {
        id: 'song-1',
        name: 'Song Thing',
        canonicalSlug: 'song-thing',
        productUrl: 'https://jinxxy.com/song-thing',
        thumbnailUrl: 'https://jinxxy-cdn.com/song-thing.png',
      },
    ]);
  });

  it('treats Jinxxy version prices as already-scaled cents', async () => {
    const module = createJinxxyProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-owner';
      },
      async decryptCredential() {
        return 'owner-key';
      },
      async listCollaboratorConnections() {
        return [];
      },
      createClient() {
        return {
          async getProducts() {
            return { products: [], pagination: { has_next: false } };
          },
          async getProduct() {
            return {
              id: 'product-1',
              visibility: 'PUBLIC',
              currency_code: 'USD',
              versions: [
                { id: 'version-1', name: 'Regular License', price: 999 },
                { id: 'version-2', name: 'Commercial License', price: 9999 },
              ],
            };
          },
          async verifyLicenseByKey() {
            return { valid: false };
          },
        };
      },
    });

    await expect(
      module.tiers?.listProductTiers('owner-key', 'product-1', makeCtx())
    ).resolves.toEqual([
      {
        id: 'version-1',
        productId: 'product-1',
        name: 'Regular License',
        amountCents: 999,
        currency: 'USD',
        active: true,
        metadata: { provider: 'jinxxy' },
      },
      {
        id: 'version-2',
        productId: 'product-1',
        name: 'Commercial License',
        amountCents: 9999,
        currency: 'USD',
        active: true,
        metadata: { provider: 'jinxxy' },
      },
    ]);
  });

  it('loads tiers with a collaborator credential when the owner credential cannot access the product', async () => {
    const calls: Array<{ apiKey: string; productId: string }> = [];
    const module = createJinxxyProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-owner';
      },
      async decryptCredential(encryptedCredential) {
        return encryptedCredential === 'encrypted-owner' ? 'owner-key' : 'collab-key';
      },
      async listCollaboratorConnections() {
        return [
          {
            id: 'collab-1',
            provider: 'jinxxy',
            credentialEncrypted: 'encrypted-collab',
            collaboratorDisplayName: 'Collab',
          },
        ];
      },
      createClient(apiKey) {
        return {
          async getProducts() {
            return { products: [], pagination: { has_next: false } };
          },
          async getProduct(productId) {
            calls.push({ apiKey, productId });
            if (apiKey === 'owner-key') {
              throw new JinxxyApiError('Forbidden', 403, 'Forbidden');
            }
            return {
              id: productId,
              visibility: 'PUBLIC',
              currency_code: 'USD',
              versions: [{ id: 'collab-version', name: 'Collab License', price: 1200 }],
            };
          },
          async verifyLicenseByKey() {
            return { valid: false };
          },
        };
      },
    });

    await expect(
      module.tiers?.listProductTiers('owner-key', 'collab-product', makeCtx())
    ).resolves.toEqual([
      {
        id: 'collab-version',
        productId: 'collab-product',
        name: 'Collab License',
        amountCents: 1200,
        currency: 'USD',
        active: true,
        metadata: { provider: 'jinxxy' },
      },
    ]);
    expect(calls).toEqual([
      { apiKey: 'owner-key', productId: 'collab-product' },
      { apiKey: 'collab-key', productId: 'collab-product' },
    ]);
  });
});

describe('createJinxxyLicenseVerification', () => {
  it('falls back to collaborator API keys when the owner key cannot verify the license', async () => {
    const verification = createJinxxyLicenseVerification({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-owner';
      },
      async decryptCredential(encryptedCredential) {
        return encryptedCredential === 'encrypted-owner' ? 'owner-key' : 'collab-key';
      },
      async listCollaboratorConnections() {
        return [
          {
            id: 'collab-1',
            provider: 'jinxxy',
            credentialEncrypted: 'encrypted-collab',
            collaboratorDisplayName: 'Collab',
          },
        ];
      },
      createClient(apiKey) {
        return {
          async getProducts() {
            return { products: [], pagination: { has_next: false } };
          },
          async getProduct() {
            return null;
          },
          async verifyLicenseByKey() {
            return apiKey === 'owner-key'
              ? {
                  valid: false,
                  error: 'Owner key could not verify license',
                }
              : {
                  valid: true,
                  license: {
                    id: 'license-collab',
                    customer_id: 'customer-collab',
                    order_id: 'order-collab',
                    product_id: 'product-collab',
                  },
                };
          },
          async verifyLicenseWithBuyerByKey() {
            return apiKey === 'owner-key'
              ? {
                  valid: false,
                  error: 'Owner key could not verify license',
                }
              : {
                  valid: true,
                  license: {
                    id: 'license-collab',
                    customer_id: 'customer-collab',
                    order_id: 'order-collab',
                    product_id: 'product-collab',
                  },
                };
          },
        };
      },
    });

    expect(await verification.verifyLicense('KEY', undefined, 'user-1', makeCtx())).toEqual({
      valid: true,
      externalOrderId: 'order-collab',
      providerUserId: 'customer-collab',
      providerProductId: 'product-collab',
      error: undefined,
    });
  });

  it('maps Jinxxy verification results into provider verification output', async () => {
    const verification = createJinxxyLicenseVerification({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-key';
      },
      async decryptCredential() {
        return 'api-key';
      },
      async listCollaboratorConnections() {
        return [];
      },
      createClient() {
        return {
          async getProducts() {
            return { products: [], pagination: { has_next: false } };
          },
          async getProduct() {
            return null;
          },
          async verifyLicenseByKey() {
            return {
              valid: true,
              license: {
                id: 'license-1',
                customer_id: 'customer-1',
                order_id: 'order-1',
                product_id: 'product-1',
              },
            };
          },
          async verifyLicenseWithBuyerByKey() {
            return {
              valid: true,
              license: {
                id: 'license-1',
                customer_id: 'customer-1',
                order_id: 'order-1',
                product_id: 'product-1',
              },
            };
          },
        };
      },
    });

    expect(await verification.verifyLicense('KEY', undefined, 'user-1', makeCtx())).toEqual({
      valid: true,
      externalOrderId: 'order-1',
      providerUserId: 'customer-1',
      providerProductId: 'product-1',
      error: undefined,
    });
  });

  it('verifies collaborator-owned licenses with collaborator credentials when the owner key cannot find the license', async () => {
    const calls: Array<{ apiKey: string; licenseKey: string }> = [];
    const verification = createJinxxyLicenseVerification({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-owner';
      },
      async decryptCredential(encryptedCredential) {
        return encryptedCredential === 'encrypted-owner' ? 'owner-key' : 'collab-key';
      },
      async listCollaboratorConnections() {
        return [
          {
            id: 'collab-1',
            provider: 'jinxxy',
            credentialEncrypted: 'encrypted-collab',
            collaboratorDisplayName: 'Collab',
          },
        ];
      },
      createClient(apiKey) {
        return {
          async getProducts() {
            return { products: [], pagination: { has_next: false } };
          },
          async getProduct() {
            return null;
          },
          async verifyLicenseByKey(licenseKey) {
            calls.push({ apiKey, licenseKey });
            if (apiKey === 'owner-key') {
              return {
                valid: false,
                license: null,
                error: 'License not found',
              };
            }
            return {
              valid: true,
              license: {
                id: 'license-collab',
                customer_id: 'customer-collab',
                order_id: 'order-collab',
                product_id: 'collab-product',
              },
            };
          },
          async verifyLicenseWithBuyerByKey(licenseKey) {
            calls.push({ apiKey, licenseKey });
            if (apiKey === 'owner-key') {
              return {
                valid: false,
                license: null,
                error: 'License not found',
              };
            }
            return {
              valid: true,
              license: {
                id: 'license-collab',
                customer_id: 'customer-collab',
                order_id: 'order-collab',
                product_id: 'collab-product',
              },
              providerUserId: 'customer-collab',
              externalOrderId: 'order-collab',
              providerProductId: 'collab-product',
            };
          },
        };
      },
    });

    await expect(
      verification.verifyLicense('KEY', 'collab-product', 'user-1', makeCtx())
    ).resolves.toEqual({
      valid: true,
      externalOrderId: 'order-collab',
      providerUserId: 'customer-collab',
      providerProductId: 'collab-product',
      error: undefined,
    });
    expect(calls).toEqual([
      { apiKey: 'owner-key', licenseKey: 'KEY' },
      { apiKey: 'collab-key', licenseKey: 'KEY' },
    ]);
  });
});
