import { createApiActorBinding, createAuthUserApiActor } from '@yucp/shared/apiActor';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

async function creatorActor(authUserId: string) {
  return await createApiActorBinding(
    createAuthUserApiActor({ authUserId, source: 'session' }),
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function seedPackage(t: ReturnType<typeof makeTestConvex>) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('creator_profiles', {
      authUserId: 'creator-mapache',
      name: 'Mapache',
      ownerDiscordUserId: 'discord-mapache',
      slug: 'mapache',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const productId = await ctx.db.insert('product_catalog', {
      authUserId: 'creator-mapache',
      provider: 'gumroad',
      productId: 'song-thing',
      providerProductRef: 'song-thing',
      displayName: 'Song Thing',
      status: 'active',
      supportsAutoDiscovery: true,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('package_registry', {
      packageId: 'com.yucp.songthing',
      publisherId: 'creator:creator-mapache',
      yucpUserId: 'creator-mapache',
      status: 'active',
      registeredAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('package_catalog_bindings', {
      creatorAuthUserId: 'creator-mapache',
      packageId: 'com.yucp.songthing',
      catalogProductId: productId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('package public namespaces', () => {
  it('lets a creator rename a product path without breaking its previous path', async () => {
    const t = makeTestConvex();
    await seedPackage(t);
    const actor = await creatorActor('creator-mapache');

    await t.mutation(api.packageRegistry.updatePublicNamespace, {
      apiSecret: 'test-secret',
      actor,
      authUserId: 'creator-mapache',
      packageId: 'com.yucp.songthing',
      publicSlug: 'song-thing',
    });
    await t.mutation(api.packageRegistry.updatePublicNamespace, {
      apiSecret: 'test-secret',
      actor,
      authUserId: 'creator-mapache',
      packageId: 'com.yucp.songthing',
      publicSlug: 'spotify-library',
    });

    const current = await t.query(api.packageRegistry.resolveBuyerAccessByCreatorProduct, {
      apiSecret: 'test-secret',
      actor,
      creatorRef: 'mapache',
      productRef: 'spotify-library',
    });
    const alias = await t.query(api.packageRegistry.resolveBuyerAccessByCreatorProduct, {
      apiSecret: 'test-secret',
      actor,
      creatorRef: 'mapache',
      productRef: 'song-thing',
    });

    expect(current).toMatchObject({
      packageId: 'com.yucp.songthing',
      publicSlug: 'spotify-library',
    });
    expect(alias).toMatchObject({
      packageId: 'com.yucp.songthing',
      publicSlug: 'spotify-library',
    });
  });
});
