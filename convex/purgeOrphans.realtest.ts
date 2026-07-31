import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const apiSecret = 'test-api-secret';

async function seedProduct(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const catalogProductId = await ctx.db.insert('product_catalog', {
      authUserId: 'creator-1',
      createdAt: now,
      displayName: 'Song Thing',
      productId: 'provider-product-1',
      provider: 'jinxxy',
      providerProductRef: 'provider-product-1',
      status: 'active',
      supportsAutoDiscovery: false,
      updatedAt: now,
    });
    return catalogProductId;
  });
}

describe('purgeOrphans', () => {
  it('keeps a product an active package binding still depends on', async () => {
    process.env.CONVEX_API_SECRET = apiSecret;
    const t = convexTest(schema, import.meta.glob('./**/*.ts'));
    const catalogProductId = await seedProduct(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId,
        createdAt: now,
        creatorAuthUserId: 'creator-1',
        packageId: 'com.yucp.songthing',
        status: 'active',
        updatedAt: now,
      });
    });

    const result = await t.mutation(api.purgeOrphans.purge, { apiSecret });

    expect(result.purgedCount).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.get(catalogProductId))).not.toBeNull();
  });

  it('purges a product nothing depends on', async () => {
    process.env.CONVEX_API_SECRET = apiSecret;
    const t = convexTest(schema, import.meta.glob('./**/*.ts'));
    const catalogProductId = await seedProduct(t);

    const result = await t.mutation(api.purgeOrphans.purge, { apiSecret });

    expect(result.purgedCount).toBe(1);
    expect(await t.run(async (ctx) => ctx.db.get(catalogProductId))).toBeNull();
  });
});
