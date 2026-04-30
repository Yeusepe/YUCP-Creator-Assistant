import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

describe('catalog sync canonical identity persistence', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  it('persists canonical identity fields for newly synced catalog products', async () => {
    const t = makeTestConvex();

    const result = await t.mutation(api.role_rules.addCatalogProduct, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-1',
      productId: 'product-1',
      providerProductRef: 'provider-product-1',
      provider: 'lemonsqueezy',
      canonicalUrl: 'https://store.example.com/products/song-thing',
      supportsAutoDiscovery: false,
      displayName: 'Song Thing',
      canonicalSlug: ' song-thing ',
      aliases: [' Song Thing ', 'Song Thing Deluxe', 'Song Thing '],
    });

    const row = (await t.run(async (ctx) =>
      ctx.db.get(result.catalogProductId)
    )) as Doc<'product_catalog'> | null;

    expect(row).not.toBeNull();
    expect(row?.canonicalSlug).toBe('song-thing');
    expect(row?.aliases).toEqual(['Song Thing', 'Song Thing Deluxe']);
  });

  it('backfills canonical identity fields onto existing synced catalog products during re-sync', async () => {
    const t = makeTestConvex();
    const existingCatalogId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('product_catalog', {
        authUserId: 'auth-creator-2',
        productId: 'product-2',
        provider: 'lemonsqueezy',
        providerProductRef: 'provider-product-2',
        displayName: 'Song Thing',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.mutation(api.role_rules.addCatalogProduct, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-2',
      productId: 'product-2',
      providerProductRef: 'provider-product-2',
      provider: 'lemonsqueezy',
      canonicalUrl: 'https://store.example.com/products/song-thing',
      supportsAutoDiscovery: false,
      displayName: 'Song Thing',
      canonicalSlug: 'song-thing',
      aliases: ['Song Thing Deluxe'],
    });

    const row = (await t.run(async (ctx) =>
      ctx.db.get(existingCatalogId)
    )) as Doc<'product_catalog'> | null;

    expect(result.catalogProductId).toBe(existingCatalogId);
    expect(row?.canonicalSlug).toBe('song-thing');
    expect(row?.aliases).toEqual(['Song Thing Deluxe']);
  });
});
