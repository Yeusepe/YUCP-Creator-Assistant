import { describe, expect, it } from 'bun:test';
import type { ProviderContext, ProviderRuntimeClient } from '../../src/contracts';
import { gumroad as gumroadDescriptor } from '../../src/descriptors/gumroad';
import {
  createGumroadLicenseVerification,
  createGumroadProviderModule,
} from '../../src/gumroad/module';

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

describe('createGumroadProviderModule', () => {
  it('advertises Gumroad tier catalog support for the rollout lane', () => {
    expect(gumroadDescriptor.capabilities).toContain('tier_catalog');
  });

  it('fetches paginated products and strips access_token from next_page_url', async () => {
    const seenUrls: string[] = [];
    const module = createGumroadProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl(input) {
        const url = String(input);
        seenUrls.push(url);
        if (url.includes('page=2')) {
          return new Response(
            JSON.stringify({
              success: true,
              products: [{ id: 'p2', name: 'Product 2' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            products: [{ id: 'p1', name: 'Product 1' }],
            next_page_url: 'https://api.gumroad.com/v2/products?page=2&access_token=leak',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(module.fetchProducts('access-token', makeCtx())).resolves.toEqual([
      { id: 'p1', name: 'Product 1' },
      { id: 'p2', name: 'Product 2' },
    ]);
    expect(seenUrls).toEqual([
      'https://api.gumroad.com/v2/products',
      'https://api.gumroad.com/v2/products?page=2',
    ]);
  });

  it('resolves relative next_page_url values against the Gumroad products endpoint', async () => {
    const seenUrls: string[] = [];
    const module = createGumroadProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl(input) {
        const url = String(input);
        seenUrls.push(url);
        if (url.includes('page=2')) {
          return new Response(
            JSON.stringify({
              success: true,
              products: [{ id: 'p2', name: 'Product 2' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            products: [{ id: 'p1', name: 'Product 1' }],
            next_page_url: '/v2/products?page=2&access_token=leak',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(module.fetchProducts('access-token', makeCtx())).resolves.toEqual([
      { id: 'p1', name: 'Product 1' },
      { id: 'p2', name: 'Product 2' },
    ]);
    expect(seenUrls).toEqual([
      'https://api.gumroad.com/v2/products',
      'https://api.gumroad.com/v2/products?page=2',
    ]);
  });

  it('stops pagination when Gumroad returns an unsafe next_page_url', async () => {
    const seenUrls: string[] = [];
    const warnCalls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const module = createGumroadProviderModule({
      logger: {
        warn(message, meta) {
          warnCalls.push({ message, meta });
        },
      },
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl(input) {
        const url = String(input);
        seenUrls.push(url);
        return new Response(
          JSON.stringify({
            success: true,
            products: [{ id: 'p1', name: 'Product 1' }],
            next_page_url: 'https://evil.example/products?page=2&access_token=leak',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(module.fetchProducts('access-token', makeCtx())).resolves.toEqual([
      { id: 'p1', name: 'Product 1' },
    ]);
    expect(seenUrls).toEqual(['https://api.gumroad.com/v2/products']);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatchObject({
      message: 'Ignoring Gumroad pagination link',
      meta: { reason: 'unexpected-origin' },
    });
  });

  it('stops pagination when Gumroad repeats the next_page_url', async () => {
    const seenUrls: string[] = [];
    const warnCalls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const module = createGumroadProviderModule({
      logger: {
        warn(message, meta) {
          warnCalls.push({ message, meta });
        },
      },
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl(input) {
        const url = String(input);
        seenUrls.push(url);
        if (url.includes('page=2')) {
          return new Response(
            JSON.stringify({
              success: true,
              products: [{ id: 'p2', name: 'Product 2' }],
              next_page_url: 'https://api.gumroad.com/v2/products?page=2&access_token=rotated',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            products: [{ id: 'p1', name: 'Product 1' }],
            next_page_url: 'https://api.gumroad.com/v2/products?page=2&access_token=leak',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(module.fetchProducts('access-token', makeCtx())).resolves.toEqual([
      { id: 'p1', name: 'Product 1' },
      { id: 'p2', name: 'Product 2' },
    ]);
    expect(seenUrls).toEqual([
      'https://api.gumroad.com/v2/products',
      'https://api.gumroad.com/v2/products?page=2',
    ]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatchObject({
      message: 'Ignoring Gumroad pagination link',
      meta: { reason: 'repeated-link' },
    });
  });

  it('stops pagination when Gumroad repeats the cursor in the next_page_url', async () => {
    const seenUrls: string[] = [];
    const warnCalls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const module = createGumroadProviderModule({
      logger: {
        warn(message, meta) {
          warnCalls.push({ message, meta });
        },
      },
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl(input) {
        const url = String(input);
        seenUrls.push(url);
        if (url.includes('page=2')) {
          return new Response(
            JSON.stringify({
              success: true,
              products: [{ id: 'p2', name: 'Product 2' }],
              next_page_url: 'https://api.gumroad.com/v2/products?page=3&cursor=cursor-1',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            products: [{ id: 'p1', name: 'Product 1' }],
            next_page_url: 'https://api.gumroad.com/v2/products?page=2&cursor=cursor-1',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(module.fetchProducts('access-token', makeCtx())).resolves.toEqual([
      { id: 'p1', name: 'Product 1' },
      { id: 'p2', name: 'Product 2' },
    ]);
    expect(seenUrls).toEqual([
      'https://api.gumroad.com/v2/products',
      'https://api.gumroad.com/v2/products?page=2&cursor=cursor-1',
    ]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatchObject({
      message: 'Ignoring Gumroad pagination link',
      meta: { reason: 'repeated-cursor' },
    });
  });

  it('preserves Gumroad storefront URLs for catalog, creator-subdomain, and external products', async () => {
    const products = [
      {
        id: 'product-catalog',
        name: 'Catalog Product',
        short_url: 'https://gumroad.com/l/catalog-product',
      },
      {
        id: 'product-storefront',
        name: 'Storefront Product',
        short_url: 'https://creator.gumroad.com/l/storefront-product?layout=profile',
      },
      {
        id: 'product-external',
        name: 'External Product',
        short_url: 'https://store.example.com/l/external-product?recommended_by=library',
      },
    ];
    const module = createGumroadProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl() {
        return new Response(JSON.stringify({ success: true, products }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await expect(module.fetchProducts('access-token', makeCtx())).resolves.toEqual([
      {
        id: 'product-catalog',
        name: 'Catalog Product',
        productUrl: 'https://gumroad.com/l/catalog-product',
        canonicalSlug: 'catalog-product',
      },
      {
        id: 'product-storefront',
        name: 'Storefront Product',
        productUrl: 'https://creator.gumroad.com/l/storefront-product?layout=profile',
        canonicalSlug: 'storefront-product',
      },
      {
        id: 'product-external',
        name: 'External Product',
        productUrl: 'https://store.example.com/l/external-product?recommended_by=library',
        canonicalSlug: 'external-product',
      },
    ]);
  });

  it('preserves Gumroad product thumbnails from the products API payload', async () => {
    const module = createGumroadProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            success: true,
            products: [
              {
                id: 'product-with-thumbnail',
                name: 'Creator Pack',
                short_url: 'https://gumroad.com/l/creator-pack',
                thumbnail_url: 'https://public-files.gumroad.com/creator-pack.png',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(module.fetchProducts('access-token', makeCtx())).resolves.toEqual([
      {
        id: 'product-with-thumbnail',
        name: 'Creator Pack',
        productUrl: 'https://gumroad.com/l/creator-pack',
        thumbnailUrl: 'https://public-files.gumroad.com/creator-pack.png',
        canonicalSlug: 'creator-pack',
      },
    ]);
  });

  it('exposes Gumroad custom permalinks as canonical slugs for catalog identity', async () => {
    const module = createGumroadProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            success: true,
            products: [
              {
                id: 'product-with-slug',
                name: 'Creator Pack',
                short_url: 'https://gumroad.com/l/creator-pack',
                custom_permalink: 'creator-pack',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(module.fetchProducts('access-token', makeCtx())).resolves.toEqual([
      {
        id: 'product-with-slug',
        name: 'Creator Pack',
        productUrl: 'https://gumroad.com/l/creator-pack',
        canonicalSlug: 'creator-pack',
      },
    ]);
  });

  it('lists tiered membership options per documented recurrence as deterministic Gumroad tiers', async () => {
    const module = createGumroadProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            success: true,
            products: [
              {
                id: 'product-membership',
                name: 'YUCP Membership',
                price: 500,
                currency: 'usd',
                short_url: 'https://gumroad.com/l/yucp-membership',
                formatted_price: '$5',
                purchase_type: 'subscription',
                published: true,
                created_at: '2024-01-01T00:00:00Z',
                is_tiered_membership: true,
                recurrences: ['monthly', 'yearly'],
                recurrence_prices: {
                  monthly: { cents: 500, formatted_price: '$5/month' },
                  yearly: { cents: 5000, formatted_price: '$50/year' },
                },
                variants: [
                  {
                    title: 'Tier',
                    options: ['Starter', 'Studio'],
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(
      module.tiers?.listProductTiers('access-token', 'product-membership', makeCtx())
    ).resolves.toEqual([
      {
        id: 'gumroad|product|18:product-membership|variant|4:tier|option|7:starter|recurrence|7:monthly',
        productId: 'product-membership',
        name: 'Starter (Monthly)',
        amountCents: 500,
        currency: 'USD',
        active: true,
        metadata: {
          provider: 'gumroad',
          isTieredMembership: true,
          selection: 'Tier: Starter',
          variantTitle: 'Tier',
          optionLabel: 'Starter',
          recurrence: 'monthly',
          formattedPrice: '$5/month',
        },
      },
      {
        id: 'gumroad|product|18:product-membership|variant|4:tier|option|7:starter|recurrence|6:yearly',
        productId: 'product-membership',
        name: 'Starter (Yearly)',
        amountCents: 5000,
        currency: 'USD',
        active: true,
        metadata: {
          provider: 'gumroad',
          isTieredMembership: true,
          selection: 'Tier: Starter',
          variantTitle: 'Tier',
          optionLabel: 'Starter',
          recurrence: 'yearly',
          formattedPrice: '$50/year',
        },
      },
      {
        id: 'gumroad|product|18:product-membership|variant|4:tier|option|6:studio|recurrence|7:monthly',
        productId: 'product-membership',
        name: 'Studio (Monthly)',
        amountCents: 500,
        currency: 'USD',
        active: true,
        metadata: {
          provider: 'gumroad',
          isTieredMembership: true,
          selection: 'Tier: Studio',
          variantTitle: 'Tier',
          optionLabel: 'Studio',
          recurrence: 'monthly',
          formattedPrice: '$5/month',
        },
      },
      {
        id: 'gumroad|product|18:product-membership|variant|4:tier|option|6:studio|recurrence|6:yearly',
        productId: 'product-membership',
        name: 'Studio (Yearly)',
        amountCents: 5000,
        currency: 'USD',
        active: true,
        metadata: {
          provider: 'gumroad',
          isTieredMembership: true,
          selection: 'Tier: Studio',
          variantTitle: 'Tier',
          optionLabel: 'Studio',
          recurrence: 'yearly',
          formattedPrice: '$50/year',
        },
      },
    ]);
  });

  it('lists non-membership Gumroad variant options with provider-local canonical refs', async () => {
    const module = createGumroadProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            success: true,
            products: [
              {
                id: 'product-variants',
                name: 'Avatar Pack',
                price: 3000,
                currency: 'usd',
                short_url: 'https://gumroad.com/l/avatar-pack',
                formatted_price: '$30',
                purchase_type: 'buy',
                published: true,
                created_at: '2024-01-01T00:00:00Z',
                variants: [
                  {
                    title: 'License',
                    options: ['Personal', 'Commercial'],
                  },
                  {
                    title: 'Source',
                    options: ['Included'],
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(
      module.tiers?.listProductTiers('access-token', 'product-variants', makeCtx())
    ).resolves.toEqual([
      {
        id: 'gumroad|product|16:product-variants|variant|7:license|option|8:personal',
        productId: 'product-variants',
        name: 'License: Personal',
        amountCents: undefined,
        currency: 'USD',
        active: true,
        metadata: {
          provider: 'gumroad',
          isTieredMembership: false,
          selection: 'License: Personal',
          variantTitle: 'License',
          optionLabel: 'Personal',
        },
      },
      {
        id: 'gumroad|product|16:product-variants|variant|7:license|option|10:commercial',
        productId: 'product-variants',
        name: 'License: Commercial',
        amountCents: undefined,
        currency: 'USD',
        active: true,
        metadata: {
          provider: 'gumroad',
          isTieredMembership: false,
          selection: 'License: Commercial',
          variantTitle: 'License',
          optionLabel: 'Commercial',
        },
      },
      {
        id: 'gumroad|product|16:product-variants|variant|6:source|option|8:included',
        productId: 'product-variants',
        name: 'Source: Included',
        amountCents: undefined,
        currency: 'USD',
        active: true,
        metadata: {
          provider: 'gumroad',
          isTieredMembership: false,
          selection: 'Source: Included',
          variantTitle: 'Source',
          optionLabel: 'Included',
        },
      },
    ]);
  });
});

describe('createGumroadLicenseVerification', () => {
  it('retries with product_permalink after product_id is rejected', async () => {
    const seenBodies: string[] = [];
    const module = createGumroadProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-token';
      },
      async decryptCredential() {
        return 'access-token';
      },
      async fetchImpl(_input, init) {
        seenBodies.push(String(init?.body ?? ''));
        if (seenBodies.length === 1) {
          return new Response(JSON.stringify({ success: false, message: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            success: true,
            purchase: {
              email: 'buyer@example.com',
              sale_id: 'sale-2',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(
      module.verification?.verifyLicense('KEY', 'product-ref-1', 'user-1', makeCtx())
    ).resolves.toEqual({
      valid: true,
      externalOrderId: 'sale-2',
      providerUserId: '6a6c26195c3682faa816966af789717c3bfa834eee6c599d667d2b3429c27cfd',
    });
    expect(seenBodies).toHaveLength(2);
    const firstAttempt = new URLSearchParams(seenBodies[0]);
    const secondAttempt = new URLSearchParams(seenBodies[1]);
    expect(Object.fromEntries(firstAttempt.entries())).toEqual({
      access_token: 'access-token',
      product_id: 'product-ref-1',
      license_key: 'KEY',
      increment_uses_count: 'false',
    });
    expect(Object.fromEntries(secondAttempt.entries())).toEqual({
      access_token: 'access-token',
      product_permalink: 'product-ref-1',
      license_key: 'KEY',
      increment_uses_count: 'false',
    });
  });

  it('maps Gumroad verification output into provider verification output', async () => {
    const verification = createGumroadLicenseVerification({
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            success: true,
            purchase: {
              email: 'buyer@example.com',
              sale_id: 'sale-1',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    const result = await verification.verifyLicense('KEY', 'product-1', 'user-1', makeCtx());
    expect(result).toEqual({
      valid: true,
      externalOrderId: 'sale-1',
      providerUserId: '6a6c26195c3682faa816966af789717c3bfa834eee6c599d667d2b3429c27cfd',
    });
  });
});
