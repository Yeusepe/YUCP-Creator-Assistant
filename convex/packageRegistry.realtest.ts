import { createApiActorBinding, createAuthUserApiActor } from '@yucp/shared/apiActor';
import { describe, expect, it } from 'vitest';
import { ACTIVE_PROTECTION_POLICY_ID } from '../ops/storage-core/protectionPolicyId';
import { api, internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

function readyPublicationFields() {
  return {
    activeContentDigest: '11'.repeat(32),
    activePolicyVersion: 'active-content-policy-v1',
    bindingRoot: '22'.repeat(32),
    commonRoot: '33'.repeat(32),
    logicalBytes: 1,
    logicalFiles: 1,
    manifestSha256: '44'.repeat(32),
    protectedFiles: [],
    protectedSourceRoot: '55'.repeat(32),
    protectionPolicyDigest: '66'.repeat(32),
    protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
    releaseRoot: '77'.repeat(32),
    vpmDependencies: {},
    vpmRepositories: {},
  };
}

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
  it('claims one package namespace for every authenticated creator storefront', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-user-first-upload';
    const catalogProductIds = await t.run(async (ctx) => {
      const now = Date.now();
      return await Promise.all(
        [
          ['gumroad', 'first-upload-gumroad', 'First Upload Product'],
          ['jinxxy', 'first-upload-jinxxy', 'First Upload Product'],
        ].map(async ([provider, productId, displayName]) => {
          return await ctx.db.insert('product_catalog', {
            authUserId,
            productId,
            provider,
            providerProductRef: `${productId}-ref`,
            displayName,
            status: 'active',
            supportsAutoDiscovery: true,
            createdAt: now,
            updatedAt: now,
          });
        })
      );
    });

    const result = await t.mutation(api.packageRegistry.claimPackageForCreatorUpload, {
      apiSecret: 'test-secret',
      actor: await createCreatorActorBinding(authUserId),
      authUserId,
      catalogProductIds,
      packageId: 'com.yucp.first-upload',
    });
    const registration = await t.query(internal.packageRegistry.getRegistration, {
      packageId: 'com.yucp.first-upload',
    });
    const productList = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor: await createCreatorActorBinding(authUserId),
      authUserId,
      configuredOnly: true,
      limit: 50,
    });
    const bindings = await t.run(async (ctx) => {
      return await ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_creator_package_status', (q) =>
          q
            .eq('creatorAuthUserId', authUserId)
            .eq('packageId', 'com.yucp.first-upload')
            .eq('status', 'active')
        )
        .collect();
    });

    expect(result).toEqual({
      registered: true,
      conflict: false,
      archived: false,
    });
    expect(registration).toMatchObject({
      packageId: 'com.yucp.first-upload',
      packageName: 'First Upload Product',
      publisherId: `creator:${authUserId}`,
      yucpUserId: authUserId,
      status: 'active',
    });
    expect(bindings.map((binding) => binding.catalogProductId)).toEqual(catalogProductIds);
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          creatorAuthUserId: authUserId,
          packageId: 'com.yucp.first-upload',
          status: 'active',
        }),
      ])
    );
    expect(productList.data).toHaveLength(1);
    expect(productList.data[0]).toMatchObject({
      packageId: 'com.yucp.first-upload',
      packageName: 'First Upload Product',
      catalogProductIds,
      storefronts: [
        expect.objectContaining({ provider: 'gumroad' }),
        expect.objectContaining({ provider: 'jinxxy' }),
      ],
    });
  });

  it('rejects a first-upload claim for another creator catalog product', async () => {
    const t = makeTestConvex();
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('product_catalog', {
        authUserId: 'catalog-owner',
        productId: 'protected-catalog-product',
        provider: 'manual',
        providerProductRef: 'protected-catalog-product-ref',
        displayName: 'Protected Catalog Product',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.mutation(api.packageRegistry.claimPackageForCreatorUpload, {
      apiSecret: 'test-secret',
      actor: await createCreatorActorBinding('different-creator'),
      authUserId: 'different-creator',
      catalogProductIds: [catalogProductId],
      packageId: 'com.yucp.unauthorized-claim',
    });
    const registration = await t.query(internal.packageRegistry.getRegistration, {
      packageId: 'com.yucp.unauthorized-claim',
    });

    expect(result).toEqual({
      registered: false,
      conflict: false,
      archived: false,
      catalogProductRejected: true,
    });
    expect(registration).toBeNull();
  });

  it('rejects a first-upload claim when the product has another explicit package binding', async () => {
    const t = makeTestConvex();
    const authUserId = 'catalog-package-owner';
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'bound-catalog-product',
        provider: 'manual',
        providerProductRef: 'bound-catalog-product-ref',
        displayName: 'Bound Catalog Product',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_versions_ref', {
        ...readyPublicationFields(),
        packageId: 'com.yucp.bound-package',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000111',
        state: 'READY',
        catalogProductId: productId,
        createdAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId: productId,
        creatorAuthUserId: authUserId,
        packageId: 'com.yucp.bound-package',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return productId;
    });

    const result = await t.mutation(api.packageRegistry.claimPackageForCreatorUpload, {
      apiSecret: 'test-secret',
      actor: await createCreatorActorBinding(authUserId),
      authUserId,
      catalogProductIds: [catalogProductId],
      packageId: 'com.yucp.different-package',
    });

    expect(result).toEqual({
      registered: false,
      conflict: false,
      archived: false,
      catalogProductRejected: true,
    });
  });

  it('binds and unbinds an owned storefront without publishing package bytes', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-manage-storefront-binding';
    const packageId = 'com.yucp.manage-storefront-binding';
    const { anchorProductId, catalogProductId } = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'managed-storefront-product',
        provider: 'jinxxy',
        providerProductRef: 'managed-storefront-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${authUserId}`,
        yucpUserId: authUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });
      const anchorProductId = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'managed-storefront-anchor',
        provider: 'gumroad',
        providerProductRef: 'managed-storefront-anchor-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId: anchorProductId,
        creatorAuthUserId: authUserId,
        packageId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return { anchorProductId, catalogProductId: productId };
    });
    const actor = await createCreatorActorBinding(authUserId);

    const bound = await t.mutation(api.packageRegistry.bindCatalogProductForCreator, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      catalogProductId,
      packageId,
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      const targetTierId = await ctx.db.insert('catalog_tiers', {
        authUserId,
        catalogProductId,
        productId: 'managed-storefront-product',
        provider: 'jinxxy',
        providerProductRef: 'managed-storefront-ref',
        providerTierRef: 'managed-storefront-commercial',
        displayName: 'Commercial',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_editions', {
        catalogProductIds: [anchorProductId, catalogProductId],
        catalogTierIds: [targetTierId],
        createdAt: now,
        creatorAuthUserId: authUserId,
        displayName: 'Commercial',
        editionId: 'commercial',
        packageId,
        priority: 100,
        status: 'active',
        updatedAt: now,
      });
    });
    const unbound = await t.mutation(api.packageRegistry.unbindCatalogProductForCreator, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      catalogProductId,
      packageId,
    });
    const editions = await t.run(async (ctx) => {
      return await ctx.db
        .query('package_editions')
        .withIndex('by_creator_package', (q) =>
          q.eq('creatorAuthUserId', authUserId).eq('packageId', packageId)
        )
        .collect();
    });

    expect(bound).toMatchObject({ bound: true, catalogProductId, packageId });
    expect(unbound).toEqual({ unbound: true });
    expect(editions).toEqual([
      expect.objectContaining({
        catalogProductIds: [anchorProductId],
        catalogTierIds: [],
        status: 'archived',
      }),
    ]);
  });

  it('does not bind one storefront to two package identities', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-exclusive-storefront-binding';
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'exclusive-storefront-product',
        provider: 'gumroad',
        providerProductRef: 'exclusive-storefront-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      for (const packageId of ['com.yucp.first-binding', 'com.yucp.second-binding']) {
        await ctx.db.insert('package_registry', {
          packageId,
          publisherId: `creator:${authUserId}`,
          yucpUserId: authUserId,
          status: 'active',
          registeredAt: now,
          updatedAt: now,
        });
      }
      return productId;
    });
    const actor = await createCreatorActorBinding(authUserId);

    await t.mutation(api.packageRegistry.bindCatalogProductForCreator, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      catalogProductId,
      packageId: 'com.yucp.first-binding',
    });
    await expect(
      t.mutation(api.packageRegistry.bindCatalogProductForCreator, {
        apiSecret: 'test-secret',
        actor,
        authUserId,
        catalogProductId,
        packageId: 'com.yucp.second-binding',
      })
    ).rejects.toThrow('Catalog product is already linked to another package');
  });

  it('does not unlink the final storefront from a managed package', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-final-storefront-binding';
    const packageId = 'com.yucp.final-storefront-binding';
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'final-storefront-product',
        provider: 'gumroad',
        providerProductRef: 'final-storefront-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${authUserId}`,
        yucpUserId: authUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId: productId,
        creatorAuthUserId: authUserId,
        packageId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return productId;
    });

    await expect(
      t.mutation(api.packageRegistry.unbindCatalogProductForCreator, {
        apiSecret: 'test-secret',
        actor: await createCreatorActorBinding(authUserId),
        authUserId,
        catalogProductId,
        packageId,
      })
    ).rejects.toThrow('Package must keep at least one linked storefront');
  });

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
        ...readyPublicationFields(),
        editionId: 'commercial',
        packageId: 'com.yucp.package-history',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000099',
        state: 'READY',
        catalogProductId: productId,
        createdAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId: productId,
        creatorAuthUserId: authUserId,
        packageId: 'com.yucp.package-history',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_editions', {
        catalogProductIds: [productId],
        catalogTierIds: [],
        createdAt: now,
        creatorAuthUserId: authUserId,
        displayName: 'Commercial',
        editionId: 'commercial',
        packageId: 'com.yucp.package-history',
        priority: 100,
        status: 'active',
        updatedAt: now,
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
      packageId: 'com.yucp.package-history',
      packageEditions: [
        {
          displayName: 'Commercial',
          editionId: 'commercial',
          priority: 100,
          status: 'active',
        },
      ],
      canDelete: false,
      deleteBlockedReason:
        'Product has package, role, entitlement, or tier history and cannot be deleted.',
    });
    expect(product).not.toHaveProperty('packageVersions');
  });

  it('keeps a configured package discoverable after every release is deleted', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-user-deleted-package-history';
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'deleted-package-history',
        provider: 'manual',
        providerProductRef: 'deleted-package-history-ref',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_versions_ref', {
        ...readyPublicationFields(),
        packageId: 'com.yucp.deleted-package-history',
        version: '1.0.0',
        versionId: crypto.randomUUID(),
        state: 'DELETED',
        deletedAt: now + 1,
        catalogProductId: productId,
        createdAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId: productId,
        creatorAuthUserId: authUserId,
        packageId: 'com.yucp.deleted-package-history',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return productId;
    });

    const products = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor: await createCreatorActorBinding(authUserId),
      authUserId,
      configuredOnly: true,
      limit: 50,
    });

    expect(products.data).toHaveLength(1);
    expect(products.data[0]).toMatchObject({
      _id: catalogProductId,
      packageId: 'com.yucp.deleted-package-history',
    });
    expect(products.data[0]).not.toHaveProperty('packageVersions');
  });

  it('does not embed package version history in the package summary', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-user-canonical-package-versions';
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'canonical-package-versions',
        provider: 'manual',
        providerProductRef: 'canonical-package-versions-ref',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      const insertVersion = async (input: {
        createdAt: number;
        editionId: string;
        state: 'DELETED' | 'READY' | 'SUPERSEDED';
        version: string;
        versionId: string;
      }) =>
        await ctx.db.insert('package_versions_ref', {
          ...readyPublicationFields(),
          catalogProductId: productId,
          packageId: 'com.yucp.canonical-versions',
          ...input,
          ...(input.state === 'DELETED' ? { deletedAt: input.createdAt + 1 } : {}),
        });

      await insertVersion({
        createdAt: 3_000,
        editionId: 'standard',
        state: 'DELETED',
        version: '1.0.0',
        versionId: 'standard-1-deleted',
      });
      await insertVersion({
        createdAt: 2_000,
        editionId: 'standard',
        state: 'SUPERSEDED',
        version: '1.0.0',
        versionId: 'standard-1-superseded',
      });
      await insertVersion({
        createdAt: 1_000,
        editionId: 'standard',
        state: 'READY',
        version: '1.0.0',
        versionId: 'standard-1-ready',
      });
      await insertVersion({
        createdAt: 1_000,
        editionId: 'standard',
        state: 'SUPERSEDED',
        version: '2.0.0',
        versionId: 'standard-2-older',
      });
      await insertVersion({
        createdAt: 2_000,
        editionId: 'standard',
        state: 'SUPERSEDED',
        version: '2.0.0',
        versionId: 'standard-2-newer',
      });
      await insertVersion({
        createdAt: 4_000,
        editionId: 'commercial',
        state: 'DELETED',
        version: '1.0.0',
        versionId: 'commercial-1-first',
      });
      await insertVersion({
        createdAt: 4_000,
        editionId: 'commercial',
        state: 'DELETED',
        version: '1.0.0',
        versionId: 'commercial-1-second',
      });
      return productId;
    });

    const product = await t.query(api.packageRegistry.getByIdForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createCreatorActorBinding(authUserId),
      authUserId,
      catalogProductId,
    });

    expect(product).not.toHaveProperty('packageVersions');
  });

  it('terminates filtered pagination when its cursor no longer resolves', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-user-stale-package-cursor';
    const [firstProductId] = await t.run(async (ctx) => {
      const now = Date.now();
      const insertConfiguredProduct = async (productId: string) => {
        const catalogProductId = await ctx.db.insert('product_catalog', {
          authUserId,
          productId,
          provider: 'gumroad',
          providerProductRef: `${productId}-ref`,
          status: 'active',
          supportsAutoDiscovery: true,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert('package_versions_ref', {
          ...readyPublicationFields(),
          packageId: `com.yucp.${productId}`,
          version: '1.0.0',
          versionId: crypto.randomUUID(),
          state: 'READY',
          catalogProductId,
          createdAt: now,
        });
        await ctx.db.insert('package_catalog_bindings', {
          catalogProductId,
          creatorAuthUserId: authUserId,
          packageId: `com.yucp.${productId}`,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        return catalogProductId;
      };
      return [
        await insertConfiguredProduct('stale-cursor-first'),
        await insertConfiguredProduct('stale-cursor-second'),
      ] as const;
    });
    const actor = await createCreatorActorBinding(authUserId);
    const firstPage = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      configuredOnly: true,
      status: 'active',
      limit: 1,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(firstProductId, { status: 'hidden', updatedAt: Date.now() });
    });

    const pageAfterStaleCursor = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      configuredOnly: true,
      status: 'active',
      cursor: firstPage.nextCursor ?? undefined,
      limit: 1,
    });

    expect(firstPage.nextCursor).toBe(String(firstProductId));
    expect(pageAfterStaleCursor).toEqual({
      data: [],
      hasMore: false,
      nextCursor: null,
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
          ...readyPublicationFields(),
          packageId: 'com.yucp.configured-one',
          version: '1.0.0',
          versionId: '00000000-0000-4000-8000-000000000011',
          state: 'READY',
          catalogProductId: firstConfigured,
          createdAt: now,
        });
        await ctx.db.insert('package_catalog_bindings', {
          catalogProductId: firstConfigured,
          creatorAuthUserId: authUserId,
          packageId: 'com.yucp.configured-one',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert('package_versions_ref', {
          ...readyPublicationFields(),
          packageId: 'com.yucp.configured-two',
          version: '1.0.0',
          versionId: '00000000-0000-4000-8000-000000000012',
          state: 'READY',
          catalogProductId: secondConfigured,
          createdAt: now,
        });
        await ctx.db.insert('package_catalog_bindings', {
          catalogProductId: secondConfigured,
          creatorAuthUserId: authUserId,
          packageId: 'com.yucp.configured-two',
          status: 'active',
          createdAt: now,
          updatedAt: now,
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
    const firstConfiguredPage = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      configuredOnly: true,
      limit: 1,
    });
    const secondConfiguredPage = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      configuredOnly: true,
      cursor: firstConfiguredPage.nextCursor ?? undefined,
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
    expect(firstConfiguredPage.data.map((product) => product._id)).toEqual([
      firstConfiguredProductId,
    ]);
    expect(firstConfiguredPage.hasMore).toBe(true);
    expect(firstConfiguredPage.nextCursor).not.toBeNull();
    expect(secondConfiguredPage.data.map((product) => product._id)).toEqual([
      secondConfiguredProductId,
    ]);
    expect(secondConfiguredPage.hasMore).toBe(false);
    expect(secondConfiguredPage.nextCursor).toBeNull();
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
        ...readyPublicationFields(),
        packageId: 'com.yucp.bound-package',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000001',
        channel: 'stable',
        state: 'READY',
        catalogProductId: productId,
        createdAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId: productId,
        creatorAuthUserId: 'auth-user-product',
        packageId: 'com.yucp.bound-package',
        status: 'active',
        createdAt: now,
        updatedAt: now,
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

  it('does not associate same-name storefront products without an explicit binding', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-user-cross-store-product';
    const [gumroadProductId, jinxxyProductId] = await t.run(async (ctx) => {
      const now = Date.now();
      const insertProduct = async (
        provider: 'gumroad' | 'jinxxy',
        productId: string,
        providerProductRef: string
      ) =>
        await ctx.db.insert('product_catalog', {
          authUserId,
          productId,
          provider,
          providerProductRef,
          displayName: 'JAMMR',
          status: 'active',
          supportsAutoDiscovery: true,
          createdAt: now,
          updatedAt: now,
        });
      const gumroad = await insertProduct('gumroad', 'jammr-gumroad', 'gumroad-jammr');
      const jinxxy = await insertProduct('jinxxy', 'jammr-jinxxy', 'jinxxy-jammr');
      await ctx.db.insert('package_versions_ref', {
        ...readyPublicationFields(),
        packageId: 'com.yucp.jammr',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000201',
        channel: 'stable',
        state: 'READY',
        catalogProductId: jinxxy,
        createdAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId: jinxxy,
        creatorAuthUserId: authUserId,
        packageId: 'com.yucp.jammr',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return [gumroad, jinxxy] as const;
    });
    const creatorActor = await createCreatorActorBinding(authUserId);
    const serviceActor = await createServiceActorBinding(['verification-intents:service']);

    const creatorProducts = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor: creatorActor,
      authUserId,
      configuredOnly: true,
      limit: 50,
    });
    const buyerProduct = await t.query(
      api.packageRegistry.getBuyerAccessContextByCatalogProductId,
      {
        apiSecret: 'test-secret',
        actor: serviceActor,
        catalogProductId: gumroadProductId,
      }
    );

    expect(creatorProducts.data).toHaveLength(1);
    expect(creatorProducts.data[0]).toMatchObject({
      packageId: 'com.yucp.jammr',
      catalogProductIds: [jinxxyProductId],
      storefronts: [expect.objectContaining({ provider: 'jinxxy' })],
    });
    expect(buyerProduct).toMatchObject({
      catalogProductId: gumroadProductId,
      catalogProductIds: [gumroadProductId],
      storefronts: [
        expect.objectContaining({
          catalogProductId: gumroadProductId,
          provider: 'gumroad',
          productId: 'jammr-gumroad',
        }),
      ],
    });
    expect(buyerProduct).not.toHaveProperty('packageId');
  });

  it('resolves explicitly bound storefront products through one durable package', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-user-explicit-cross-store-product';
    const [gumroadProductId, jinxxyProductId] = await t.run(async (ctx) => {
      const now = Date.now();
      const gumroad = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'jammr-gumroad-explicit',
        provider: 'gumroad',
        providerProductRef: 'gumroad-jammr-explicit',
        displayName: 'JAMMR for Gumroad',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      const jinxxy = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'jammr-jinxxy-explicit',
        provider: 'jinxxy',
        providerProductRef: 'jinxxy-jammr-explicit',
        displayName: 'JAMMR for Jinxxy',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      for (const [index, catalogProductId] of [gumroad, jinxxy].entries()) {
        if (index === 1) {
          await ctx.db.insert('package_versions_ref', {
            ...readyPublicationFields(),
            packageId: 'com.yucp.jammr.explicit',
            version: '1.0.0',
            versionId: '00000000-0000-4000-8000-000000000301',
            channel: 'stable',
            state: 'READY',
            catalogProductId,
            createdAt: now + index,
          });
        }
        await ctx.db.insert('package_catalog_bindings', {
          catalogProductId,
          creatorAuthUserId: authUserId,
          packageId: 'com.yucp.jammr.explicit',
          status: 'active',
          createdAt: now + index,
          updatedAt: now + index,
        });
      }
      return [gumroad, jinxxy] as const;
    });

    const products = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor: await createCreatorActorBinding(authUserId),
      authUserId,
      configuredOnly: true,
      limit: 50,
    });
    const buyerProduct = await t.query(
      api.packageRegistry.getBuyerAccessContextByCatalogProductId,
      {
        apiSecret: 'test-secret',
        actor: await createServiceActorBinding(['verification-intents:service']),
        catalogProductId: gumroadProductId,
      }
    );

    expect(products.data).toHaveLength(1);
    expect(products.data[0]).toMatchObject({
      packageId: 'com.yucp.jammr.explicit',
      catalogProductIds: [gumroadProductId, jinxxyProductId],
      storefronts: [
        expect.objectContaining({ provider: 'gumroad' }),
        expect.objectContaining({ provider: 'jinxxy' }),
      ],
    });
    expect(buyerProduct).toMatchObject({
      packageId: 'com.yucp.jammr.explicit',
      catalogProductIds: [gumroadProductId, jinxxyProductId],
    });
  });

  it('returns one provider-neutral package aggregate when unconfigured products are included', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-user-provider-neutral-package-list';
    const packageId = 'com.yucp.provider-neutral-list';
    const catalogProductIds = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('package_registry', {
        packageId,
        packageName: 'Provider Neutral Product',
        publisherId: `creator:${authUserId}`,
        yucpUserId: authUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });
      return await Promise.all(
        [
          ['gumroad', 'gumroad-provider-neutral'],
          ['jinxxy', 'jinxxy-provider-neutral'],
        ].map(async ([provider, providerProductRef], index) => {
          const catalogProductId = await ctx.db.insert('product_catalog', {
            authUserId,
            productId: `provider-neutral-${provider}`,
            provider,
            providerProductRef,
            displayName: `Provider Neutral ${provider}`,
            status: 'active',
            supportsAutoDiscovery: true,
            createdAt: now + index,
            updatedAt: now + index,
          });
          await ctx.db.insert('package_catalog_bindings', {
            catalogProductId,
            creatorAuthUserId: authUserId,
            packageId,
            status: 'active',
            createdAt: now + index,
            updatedAt: now + index,
          });
          return catalogProductId;
        })
      );
    });

    const products = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor: await createCreatorActorBinding(authUserId),
      authUserId,
      configuredOnly: false,
      limit: 50,
    });

    expect(products.data).toHaveLength(1);
    expect(products.data[0]).toMatchObject({
      aliasId: packageId,
      packageId,
      catalogProductIds,
      storefronts: [
        expect.objectContaining({ provider: 'gumroad' }),
        expect.objectContaining({ provider: 'jinxxy' }),
      ],
    });
  });

  it('includes tiers from every explicitly associated storefront', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-user-cross-store-tiers';
    const [gumroadProductId, jinxxyProductId] = await t.run(async (ctx) => {
      const now = Date.now();
      const products = await Promise.all(
        [
          ['gumroad', 'Gumroad JAMMR', 'gumroad-tier-product', 'gumroad-tier-ref'],
          ['jinxxy', 'Jinxxy JAMMR', 'jinxxy-tier-product', 'jinxxy-tier-ref'],
        ].map(async ([provider, displayName, productId, providerProductRef], index) => {
          const catalogProductId = await ctx.db.insert('product_catalog', {
            authUserId,
            productId,
            provider: provider as 'gumroad' | 'jinxxy',
            providerProductRef,
            displayName,
            status: 'active',
            supportsAutoDiscovery: true,
            createdAt: now,
            updatedAt: now,
          });
          await ctx.db.insert('catalog_tiers', {
            authUserId,
            catalogProductId,
            productId,
            provider: provider as 'gumroad' | 'jinxxy',
            providerProductRef,
            providerTierRef: `${provider}-commercial`,
            displayName: `${displayName} Commercial`,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          });
          if (index === 1) {
            await ctx.db.insert('package_versions_ref', {
              ...readyPublicationFields(),
              packageId: 'com.yucp.jammr.tiers',
              version: '1.0.0',
              versionId: '00000000-0000-4000-8000-000000000401',
              channel: 'stable',
              state: 'READY',
              catalogProductId,
              createdAt: now + index,
            });
          }
          await ctx.db.insert('package_catalog_bindings', {
            catalogProductId,
            creatorAuthUserId: authUserId,
            packageId: 'com.yucp.jammr.tiers',
            status: 'active',
            createdAt: now + index,
            updatedAt: now + index,
          });
          return catalogProductId;
        })
      );
      return products as [(typeof products)[0], (typeof products)[1]];
    });

    const product = await t.query(api.packageRegistry.getByIdForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createCreatorActorBinding(authUserId),
      authUserId,
      catalogProductId: gumroadProductId,
    });

    expect(product?.catalogProductIds).toEqual([gumroadProductId, jinxxyProductId]);
    expect(product?.catalogTiers).toEqual([
      expect.objectContaining({ provider: 'gumroad', providerTierRef: 'gumroad-commercial' }),
      expect.objectContaining({ provider: 'jinxxy', providerTierRef: 'jinxxy-commercial' }),
    ]);
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
