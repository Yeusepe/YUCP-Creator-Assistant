import { createApiActorBinding, createAuthUserApiActor } from '@yucp/shared/apiActor';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

async function createServiceActorBinding(scopes: readonly string[]) {
  const now = Date.now();
  return await createApiActorBinding(
    {
      version: 1,
      kind: 'service',
      service: 'api-server',
      scopes: [...scopes],
      issuedAt: now,
      expiresAt: now + 60_000,
    },
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function createCreatorActorBinding(authUserId: string) {
  return await createApiActorBinding(
    createAuthUserApiActor({ authUserId, source: 'session' }),
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

describe('packageRegistry', () => {
  it('blocks deletion when a catalog product has package-version history', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-user-package-history';
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'product-with-package-history',
        provider: 'gumroad',
        providerProductRef: 'product-with-package-history-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_versions_ref', {
        packageId: 'com.yucp.package-history',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000099',
        state: 'READY',
        catalogProductId: productId,
        createdAt: now,
      });
      return productId;
    });

    const product = await t.query(api.packageRegistry.getByIdForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createCreatorActorBinding(authUserId),
      authUserId,
      catalogProductId,
    });

    expect(product).toMatchObject({
      canDelete: false,
      deleteBlockedReason:
        'Product has package, role, entitlement, or tier history and cannot be deleted.',
    });
  });

  it('paginates creator products without hiding products awaiting their first upload', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-user-dashboard-packages';
    const [unconfiguredProductId, firstConfiguredProductId, secondConfiguredProductId] =
      await t.run(async (ctx) => {
        const now = Date.now();
        const insertProduct = async (productId: string, providerProductRef: string) =>
          await ctx.db.insert('product_catalog', {
            authUserId,
            productId,
            provider: 'gumroad',
            providerProductRef,
            status: 'active',
            supportsAutoDiscovery: true,
            createdAt: now,
            updatedAt: now,
          });

        const unconfigured = await insertProduct('unconfigured-product', 'unconfigured-ref');
        const firstConfigured = await insertProduct('configured-product-1', 'configured-ref-1');
        const secondConfigured = await insertProduct('configured-product-2', 'configured-ref-2');
        await ctx.db.insert('package_versions_ref', {
          packageId: 'com.yucp.configured-one',
          version: '1.0.0',
          versionId: '00000000-0000-4000-8000-000000000011',
          state: 'READY',
          catalogProductId: firstConfigured,
          createdAt: now,
        });
        await ctx.db.insert('package_versions_ref', {
          packageId: 'com.yucp.configured-two',
          version: '1.0.0',
          versionId: '00000000-0000-4000-8000-000000000012',
          state: 'READY',
          catalogProductId: secondConfigured,
          createdAt: now,
        });
        return [unconfigured, firstConfigured, secondConfigured] as const;
      });
    const actor = await createCreatorActorBinding(authUserId);

    const firstPage = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      limit: 1,
    });
    const secondPage = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      cursor: firstPage.nextCursor ?? undefined,
      limit: 1,
    });
    const thirdPage = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      cursor: secondPage.nextCursor ?? undefined,
      limit: 1,
    });

    expect(firstPage.data.map((product) => product._id)).toEqual([unconfiguredProductId]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(secondPage.data.map((product) => product._id)).toEqual([firstConfiguredProductId]);
    expect(secondPage.hasMore).toBe(true);
    expect(thirdPage.data.map((product) => product._id)).toEqual([secondConfiguredProductId]);
    expect(thirdPage.hasMore).toBe(false);
    expect(thirdPage.nextCursor).toBeNull();
  });

  it('stores package names and lists owned packages with human metadata', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.gamma',
      packageName: 'Gamma Tools',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });
    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.alpha',
      packageName: 'Alpha Suite',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const packages = await t.query(internal.packageRegistry.getRegistrationsByYucpUser, {
      yucpUserId: 'auth-user-1',
    });

    expect(
      packages.map((entry: Doc<'package_registry'>) => [entry.packageId, entry.packageName])
    ).toEqual([
      ['pkg.gamma', 'Gamma Tools'],
      ['pkg.alpha', 'Alpha Suite'],
    ]);
  });

  it('updates the registered package name when the same creator re-registers a package', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.creator-suite',
      packageName: 'Creator Suite',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });
    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.creator-suite',
      packageName: 'Creator Suite+',
      publisherId: 'publisher-2',
      yucpUserId: 'auth-user-1',
    });

    const registration = await t.query(internal.packageRegistry.getRegistration, {
      packageId: 'pkg.creator-suite',
    });

    expect(registration?.publisherId).toBe('publisher-2');
    expect(registration?.packageName).toBe('Creator Suite+');
  });

  it('allows actor-protected package lookups used by hosted verification helpers', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.lookup',
      packageName: 'Lookup Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-lookup',
    });

    const registration = await t.query(api.packageRegistry.lookupRegistration, {
      apiSecret: 'test-secret',
      actor: await createServiceActorBinding(['verification-intents:service']),
      packageId: 'pkg.lookup',
    });

    expect(registration).toEqual({
      packageId: 'pkg.lookup',
      yucpUserId: 'auth-user-lookup',
      status: 'active',
    });
  });

  it('returns the package bound to an active catalog product', async () => {
    const t = makeTestConvex();
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId: 'auth-user-product',
        productId: 'product-bound-to-package',
        provider: 'gumroad',
        providerProductRef: 'provider-product-bound-to-package',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_versions_ref', {
        packageId: 'com.yucp.bound-package',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000001',
        channel: 'stable',
        state: 'READY',
        catalogProductId: productId,
        createdAt: now,
      });
      return productId;
    });

    const product = await t.query(api.packageRegistry.getBuyerAccessContextByCatalogProductId, {
      apiSecret: 'test-secret',
      actor: await createServiceActorBinding(['verification-intents:service']),
      catalogProductId,
    });

    expect(product?.packageId).toBe('com.yucp.bound-package');
  });

  it('resolves human product aliases only within the requested creator profile', async () => {
    const t = makeTestConvex();
    const [firstProductId, secondProductId] = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('creator_profiles', {
        authUserId: 'creator-one',
        name: 'Creator One',
        ownerDiscordUserId: 'discord-creator-one',
        slug: 'creator-one',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('creator_profiles', {
        authUserId: 'creator-two',
        name: 'Creator Two',
        ownerDiscordUserId: 'discord-creator-two',
        slug: 'creator-two',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const insertProduct = async (authUserId: string, productId: string) =>
        await ctx.db.insert('product_catalog', {
          authUserId,
          productId,
          provider: 'gumroad',
          providerProductRef: 'shared-provider-ref',
          canonicalSlug: 'avatar-bundle',
          displayName: `${authUserId} bundle`,
          status: 'active',
          supportsAutoDiscovery: true,
          createdAt: now,
          updatedAt: now,
        });
      return [
        await insertProduct('creator-one', 'creator-one-product'),
        await insertProduct('creator-two', 'creator-two-product'),
      ] as const;
    });
    const actor = await createServiceActorBinding(['creator:delegate']);

    const first = await t.query(api.packageRegistry.getBuyerAccessContextByCreatorAndProductRef, {
      apiSecret: 'test-secret',
      actor,
      creatorRef: 'creator-one',
      productRef: 'avatar-bundle',
    });
    const second = await t.query(api.packageRegistry.getBuyerAccessContextByCreatorAndProductRef, {
      apiSecret: 'test-secret',
      actor,
      creatorRef: 'creator-two',
      productRef: 'shared-provider-ref',
    });
    const missing = await t.query(api.packageRegistry.getBuyerAccessContextByCreatorAndProductRef, {
      apiSecret: 'test-secret',
      actor,
      creatorRef: 'unknown-creator',
      productRef: 'avatar-bundle',
    });

    expect(first?.catalogProductId).toBe(firstProductId);
    expect(first?.creatorAuthUserId).toBe('creator-one');
    expect(second?.catalogProductId).toBe(secondProductId);
    expect(second?.creatorAuthUserId).toBe('creator-two');
    expect(missing).toBeNull();
  });

  it('does not disclose the owning creator on a package namespace conflict', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.namespace',
      packageName: 'Namespace Owner',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });
    const conflict = await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.namespace',
      packageName: 'Namespace Challenger',
      publisherId: 'publisher-2',
      yucpUserId: 'auth-user-2',
    });

    expect(conflict).toEqual({
      registered: false,
      conflict: true,
      archived: false,
    });
    expect('ownedBy' in conflict).toBe(false);
  });
});
