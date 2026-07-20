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
  it('lists only configured products before applying dashboard pagination', async () => {
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
      configuredOnly: true,
      limit: 1,
    });
    const secondPage = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      configuredOnly: true,
      cursor: firstPage.nextCursor ?? undefined,
      limit: 1,
    });

    expect(firstPage.data.map((product) => product._id)).toEqual([firstConfiguredProductId]);
    expect(firstPage.data.map((product) => product._id)).not.toContain(unconfiguredProductId);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBe(firstConfiguredProductId);
    expect(secondPage.data.map((product) => product._id)).toEqual([secondConfiguredProductId]);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextCursor).toBeNull();
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
