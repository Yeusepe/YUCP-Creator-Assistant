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
});
