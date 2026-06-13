import { describe, expect, it } from 'bun:test';
import type { ProviderContext, ProviderRuntimeClient } from '../../src/contracts';
import {
  createLemonSqueezyLicenseVerification,
  createLemonSqueezyProviderModule,
} from '../../src/lemonsqueezy/module';

const logger = {
  warn() {},
  error() {},
};

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

describe('createLemonSqueezyProviderModule', () => {
  it('deduplicates owner and collaborator product lists by product id', async () => {
    const module = createLemonSqueezyProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'owner-encrypted';
      },
      async decryptCredential(encryptedCredential) {
        return encryptedCredential === 'owner-encrypted' ? 'owner-token' : 'collab-token';
      },
      async listCollaboratorConnections() {
        return [
          {
            id: 'collab-1',
            provider: 'lemonsqueezy',
            credentialEncrypted: 'collab-encrypted',
            collaboratorDisplayName: 'Collaborator A',
          },
        ];
      },
      createClient(apiToken) {
        return {
          async getProducts({ page }) {
            if (apiToken === 'owner-token') {
              return {
                products:
                  page === 1
                    ? [
                        { id: '1', name: 'Owner Product' },
                        { id: '2', name: 'Shared Product' },
                      ]
                    : [],
                pagination: { nextPage: null },
              };
            }
            return {
              products: [
                { id: '2', name: 'Shared Product' },
                { id: '3', name: 'Collab Product' },
              ],
              pagination: { nextPage: null },
            };
          },
          async getStores() {
            return { stores: [{ id: 'store-1' }] };
          },
          async getVariants() {
            return [];
          },
          async validateLicenseKey() {
            return { valid: false };
          },
        };
      },
    });

    const products = await module.fetchProducts('owner-token', makeCtx());
    expect(products).toEqual([
      { id: '1', name: 'Owner Product' },
      { id: '2', name: 'Shared Product' },
      { id: '3', name: 'Collab Product', collaboratorName: 'Collaborator A' },
    ]);
  });

  it('preserves Lemon Squeezy product slugs as canonical slugs for catalog identity', async () => {
    const module = createLemonSqueezyProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'owner-encrypted';
      },
      async decryptCredential() {
        return 'owner-token';
      },
      async listCollaboratorConnections() {
        return [];
      },
      createClient() {
        return {
          async getProducts() {
            return {
              products: [
                {
                  id: '1',
                  name: 'Owner Product',
                  slug: 'owner-product',
                  url: 'https://store.example.com/products/owner-product',
                },
              ],
              pagination: { nextPage: null },
            };
          },
          async getStores() {
            return { stores: [{ id: 'store-1' }] };
          },
          async getVariants() {
            return [];
          },
          async validateLicenseKey() {
            return { valid: false };
          },
        };
      },
    });

    expect(await module.fetchProducts('owner-token', makeCtx())).toEqual([
      {
        id: '1',
        name: 'Owner Product',
        canonicalSlug: 'owner-product',
        productUrl: 'https://store.example.com/products/owner-product',
      },
    ]);
  });
  it('loads tiers with a collaborator credential when the owner credential cannot access the product', async () => {
    const calls: Array<{ apiToken: string; productId: string }> = [];
    const module = createLemonSqueezyProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'owner-encrypted';
      },
      async decryptCredential(encryptedCredential) {
        return encryptedCredential === 'owner-encrypted' ? 'owner-token' : 'collab-token';
      },
      async listCollaboratorConnections() {
        return [
          {
            id: 'collab-1',
            provider: 'lemonsqueezy',
            credentialEncrypted: 'collab-encrypted',
            collaboratorDisplayName: 'Collaborator A',
          },
        ];
      },
      createClient(apiToken) {
        return {
          async getProducts() {
            return { products: [], pagination: { nextPage: null } };
          },
          async getStores() {
            return { stores: [{ id: 'store-1' }] };
          },
          async getVariants(productId) {
            calls.push({ apiToken, productId });
            if (apiToken === 'owner-token') {
              throw new Error('Forbidden');
            }
            return [
              {
                id: 'variant-collab',
                name: 'Collab Variant',
                price: 2500,
                status: 'published',
              },
            ];
          },
          async validateLicenseKey() {
            return { valid: false };
          },
        };
      },
    });

    await expect(
      module.tiers?.listProductTiers('owner-token', 'collab-product', makeCtx())
    ).resolves.toEqual([
      {
        id: 'variant-collab',
        productId: 'collab-product',
        name: 'Collab Variant',
        description: undefined,
        amountCents: 2500,
        currency: undefined,
        active: true,
        metadata: {
          provider: 'lemonsqueezy',
          status: 'published',
        },
      },
    ]);
    expect(calls).toEqual([
      { apiToken: 'owner-token', productId: 'collab-product' },
      { apiToken: 'collab-token', productId: 'collab-product' },
    ]);
  });
});

describe('createLemonSqueezyLicenseVerification', () => {
  it('maps Lemon Squeezy validation results into verification output', async () => {
    const verification = createLemonSqueezyLicenseVerification({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'api-token';
      },
      async listCollaboratorConnections() {
        return [];
      },
      createClient() {
        return {
          async getProducts() {
            return { products: [], pagination: { nextPage: null } };
          },
          async getStores() {
            return { stores: [{ id: 'store-1' }] };
          },
          async getVariants() {
            return [];
          },
          async validateLicenseKey() {
            return {
              valid: true,
              license_key: { id: 11 },
              meta: { order_item_id: 22, product_id: 33 },
            };
          },
        };
      },
    });

    expect(await verification.verifyLicense('KEY', undefined, 'user-1', makeCtx())).toEqual({
      valid: true,
      externalOrderId: '11',
      providerProductId: '33',
      error: undefined,
    });
  });

  it('verifies collaborator-owned licenses with collaborator credentials when the owner token rejects the license', async () => {
    const calls: Array<{ apiToken: string; licenseKey: string }> = [];
    const verification = createLemonSqueezyLicenseVerification({
      logger,
      async getEncryptedCredential() {
        return 'owner-encrypted';
      },
      async decryptCredential(encryptedCredential) {
        return encryptedCredential === 'owner-encrypted' ? 'owner-token' : 'collab-token';
      },
      async listCollaboratorConnections() {
        return [
          {
            id: 'collab-1',
            provider: 'lemonsqueezy',
            credentialEncrypted: 'collab-encrypted',
            collaboratorDisplayName: 'Collaborator A',
          },
        ];
      },
      createClient(apiToken) {
        return {
          async getProducts() {
            return { products: [], pagination: { nextPage: null } };
          },
          async getStores() {
            return { stores: [{ id: 'store-1' }] };
          },
          async getVariants() {
            return [];
          },
          async validateLicenseKey(licenseKey) {
            calls.push({ apiToken, licenseKey });
            if (apiToken === 'owner-token') {
              return {
                valid: false,
                error: 'License key not found',
              };
            }
            return {
              valid: true,
              license_key: { id: 'license-collab' },
              meta: { product_id: 'collab-product' },
            };
          },
        };
      },
    });

    await expect(
      verification.verifyLicense('KEY', 'collab-product', 'user-1', makeCtx())
    ).resolves.toEqual({
      valid: true,
      externalOrderId: 'license-collab',
      providerProductId: 'collab-product',
      error: undefined,
    });
    expect(calls).toEqual([
      { apiToken: 'owner-token', licenseKey: 'KEY' },
      { apiToken: 'collab-token', licenseKey: 'KEY' },
    ]);
  });
});
