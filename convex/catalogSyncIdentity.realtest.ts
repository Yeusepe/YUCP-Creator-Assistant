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

  it('stores the canonical URL as a direct product link for newly synced products', async () => {
    const t = makeTestConvex();

    const result = await t.mutation(api.role_rules.addCatalogProduct, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-link-1',
      productId: 'product-link-1',
      providerProductRef: 'provider-link-1',
      provider: 'gumroad',
      canonicalUrl: 'https://quaggycharr.gumroad.com/l/Fluffgan',
      supportsAutoDiscovery: false,
      displayName: 'Fluffgan',
      canonicalSlug: 'Fluffgan',
    });

    const links = await t.run(async (ctx) =>
      ctx.db
        .query('catalog_product_links')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', result.catalogProductId))
        .collect()
    );

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      linkKind: 'direct_product',
      status: 'active',
      originalUrl: 'https://quaggycharr.gumroad.com/l/Fluffgan',
      normalizedUrl: 'https://quaggycharr.gumroad.com/l/fluffgan',
    });
  });

  it('creates no catalog product link when no canonical URL is available', async () => {
    const t = makeTestConvex();

    const result = await t.mutation(api.role_rules.addCatalogProduct, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-link-2',
      productId: 'product-link-2',
      providerProductRef: 'provider-link-2',
      provider: 'vrchat',
      supportsAutoDiscovery: false,
      displayName: 'Avatar Listing',
    });

    const links = await t.run(async (ctx) =>
      ctx.db
        .query('catalog_product_links')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', result.catalogProductId))
        .collect()
    );

    expect(links).toHaveLength(0);
  });

  it('does not persist a non-HTTPS canonical product URL', async () => {
    const t = makeTestConvex();

    const result = await t.mutation(api.role_rules.addCatalogProduct, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-link-unsafe',
      productId: 'product-link-unsafe',
      providerProductRef: 'provider-link-unsafe',
      provider: 'itchio',
      canonicalUrl: 'javascript:alert(1)',
      supportsAutoDiscovery: false,
      displayName: 'Unsafe Link Product',
    });

    const links = await t.run(async (ctx) =>
      ctx.db
        .query('catalog_product_links')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', result.catalogProductId))
        .collect()
    );

    expect(links).toHaveLength(0);
  });

  it('repairs the stored canonical link when re-sync provides a corrected URL', async () => {
    const t = makeTestConvex();
    const existingCatalogId = await t.run(async (ctx) => {
      const now = Date.now();
      const catalogId = await ctx.db.insert('product_catalog', {
        authUserId: 'auth-creator-link-3',
        productId: 'product-link-3',
        provider: 'jinxxy',
        providerProductRef: 'jinxxy-product-uuid',
        displayName: 'Song Thing',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      const junkUrl = 'https://jinxxy.app/products/jinxxy-product-uuid';
      await ctx.db.insert('catalog_product_links', {
        catalogProductId: catalogId,
        provider: 'jinxxy',
        originalUrl: junkUrl,
        normalizedUrl: junkUrl,
        urlHash: 'junk-hash',
        linkKind: 'direct_product',
        status: 'active',
        submittedByAuthUserId: 'auth-creator-link-3',
        createdAt: now,
        updatedAt: now,
      });
      return catalogId;
    });

    const result = await t.mutation(api.role_rules.addCatalogProduct, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-link-3',
      productId: 'product-link-3',
      providerProductRef: 'jinxxy-product-uuid',
      provider: 'jinxxy',
      canonicalUrl: 'https://jinxxy.com/Squishycollars/abie',
      supportsAutoDiscovery: false,
      displayName: 'Song Thing',
      canonicalSlug: 'abie',
    });

    const links = await t.run(async (ctx) =>
      ctx.db
        .query('catalog_product_links')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', existingCatalogId))
        .collect()
    );

    expect(result.catalogProductId).toBe(existingCatalogId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      originalUrl: 'https://jinxxy.com/Squishycollars/abie',
      normalizedUrl: 'https://jinxxy.com/squishycollars/abie',
      status: 'active',
    });
    expect(links[0]?.urlHash).not.toBe('junk-hash');
  });

  it('backfills a missing canonical link onto an existing product during re-sync', async () => {
    const t = makeTestConvex();
    const existingCatalogId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('product_catalog', {
        authUserId: 'auth-creator-link-4',
        productId: 'product-link-4',
        provider: 'gumroad',
        providerProductRef: 'provider-link-4',
        displayName: 'Fluffgan',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.mutation(api.role_rules.addCatalogProduct, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-link-4',
      productId: 'product-link-4',
      providerProductRef: 'provider-link-4',
      provider: 'gumroad',
      canonicalUrl: 'https://gumroad.com/l/fluffgan',
      supportsAutoDiscovery: false,
      displayName: 'Fluffgan',
      canonicalSlug: 'fluffgan',
    });

    const links = await t.run(async (ctx) =>
      ctx.db
        .query('catalog_product_links')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', existingCatalogId))
        .collect()
    );

    expect(links).toHaveLength(1);
    expect(links[0]?.originalUrl).toBe('https://gumroad.com/l/fluffgan');
  });
});
