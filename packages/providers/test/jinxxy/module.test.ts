import { describe, expect, it } from 'bun:test';
import type { ProviderContext, ProviderRuntimeClient } from '../../src/contracts';
import {
  createJinxxyLicenseVerification,
  createJinxxyProviderModule,
} from '../../src/jinxxy/module';

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
});

describe('createJinxxyLicenseVerification', () => {
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
});
