import {
  createApiActorBinding,
  createAuthUserApiActor,
  createServiceApiActor,
} from '@yucp/shared/apiActor';
import { catalogTierPackageEditionId } from '@yucp/shared/packageEdition';
import { describe, expect, it } from 'vitest';
import { ACTIVE_PROTECTION_POLICY_ID } from '../ops/storage-core/protectionPolicyId';
import { api } from './_generated/api';
import { makeTestConvex, seedSubject } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

async function creatorActor(authUserId: string) {
  return await createApiActorBinding(
    createAuthUserApiActor({ authUserId, source: 'session' }),
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function downloadActor(authUserId: string) {
  return await createApiActorBinding(
    createServiceApiActor({
      authUserId,
      now: Date.now(),
      scopes: ['downloads:service', 'entitlements:service'],
      service: 'package-install-sessions',
    }),
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

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

describe('package editions', () => {
  it('authorizes exact creator-owned package editions for version management', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-version-management';
    const otherAuthUserId = 'creator-version-management-other';
    const packageId = 'com.yucp.version-management';
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${authUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: authUserId,
      });
      await ctx.db.insert('package_editions', {
        catalogProductIds: [],
        catalogTierIds: [],
        createdAt: now,
        creatorAuthUserId: authUserId,
        displayName: 'Commercial archive',
        editionId: 'commercial',
        packageId,
        priority: 100,
        status: 'archived',
        updatedAt: now,
      });
    });

    const authorized = await t.query(api.packageEditions.getManagementScopeForCreator, {
      apiSecret: 'test-secret',
      actor: await creatorActor(authUserId),
      authUserId,
      editionId: 'commercial',
      packageId,
    });
    expect(authorized).toMatchObject({
      displayName: 'Commercial archive',
      editionId: 'commercial',
      packageId,
      status: 'archived',
    });

    await expect(
      t.query(api.packageEditions.getManagementScopeForCreator, {
        apiSecret: 'test-secret',
        actor: await creatorActor(otherAuthUserId),
        authUserId: otherAuthUserId,
        editionId: 'commercial',
        packageId,
      })
    ).resolves.toBeNull();

    await expect(
      t.query(api.packageEditions.getManagementScopeForCreator, {
        apiSecret: 'test-secret',
        actor: await creatorActor(authUserId),
        authUserId,
        editionId: 'unknown',
        packageId,
      })
    ).resolves.toBeNull();
  });

  it('authorizes the implicit Standard edition for an owned package before its first upload', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-implicit-standard-management';
    const packageId = 'com.yucp.implicit-standard-management';
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${authUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: authUserId,
      });
    });

    await expect(
      t.query(api.packageEditions.getManagementScopeForCreator, {
        apiSecret: 'test-secret',
        actor: await creatorActor(authUserId),
        authUserId,
        editionId: 'standard',
        packageId,
      })
    ).resolves.toEqual({
      displayName: 'Standard',
      editionId: 'standard',
      packageId,
      status: 'active',
    });
  });

  it('creates one explicit standard edition and merges associated storefront products', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-standard-upload-edition';
    const packageId = 'com.yucp.standard-upload-edition';
    const productIds = await t.run(async (ctx) => {
      const now = Date.now();
      const ids = [];
      for (const [index, provider] of ['gumroad', 'jinxxy'].entries()) {
        const catalogProductId = await ctx.db.insert('product_catalog', {
          authUserId,
          productId: `${provider}-standard-product`,
          provider: provider as 'gumroad' | 'jinxxy',
          providerProductRef: `${provider}-standard-ref`,
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
        ids.push(catalogProductId);
      }
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${authUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: authUserId,
      });
      return ids;
    });

    for (const catalogProductId of productIds) {
      await t.mutation(api.packageEditions.ensureStandardForCreatorUpload, {
        apiSecret: 'test-secret',
        actor: await creatorActor(authUserId),
        authUserId,
        catalogProductIds: [catalogProductId],
        packageId,
      });
    }

    const editions = await t.query(api.packageEditions.listForCreator, {
      apiSecret: 'test-secret',
      actor: await creatorActor(authUserId),
      authUserId,
      packageId,
    });
    expect(editions).toHaveLength(1);
    expect(editions[0]).toMatchObject({
      catalogProductIds: productIds,
      catalogTierIds: [],
      displayName: 'Standard',
      editionId: 'standard',
      priority: 0,
      status: 'active',
    });
  });

  it('creates one package edition from an owned catalog tier without provider branching', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-catalog-tier-upload-edition';
    const packageId = 'com.yucp.catalog-tier-upload-edition';
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId,
        createdAt: now,
        displayName: 'Membership Product',
        productId: 'membership-product',
        provider: 'patreon',
        providerProductRef: 'membership-product-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: now,
      });
      const catalogTierId = await ctx.db.insert('catalog_tiers', {
        authUserId,
        catalogProductId,
        createdAt: now,
        displayName: 'Gold patrons',
        productId: 'membership-product',
        provider: 'patreon',
        providerProductRef: 'membership-product-ref',
        providerTierRef: 'gold',
        status: 'active',
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${authUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: authUserId,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId,
        creatorAuthUserId: authUserId,
        packageId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return { catalogProductId, catalogTierId };
    });
    const editionId = catalogTierPackageEditionId(String(seeded.catalogTierId));

    await t.mutation(api.packageEditions.ensureCatalogTierForCreatorUpload, {
      apiSecret: 'test-secret',
      actor: await creatorActor(authUserId),
      authUserId,
      catalogProductIds: [seeded.catalogProductId],
      catalogTierId: seeded.catalogTierId,
      editionId,
      packageId,
    });
    await t.mutation(api.packageEditions.ensureCatalogTierForCreatorUpload, {
      apiSecret: 'test-secret',
      actor: await creatorActor(authUserId),
      authUserId,
      catalogProductIds: [seeded.catalogProductId],
      catalogTierId: seeded.catalogTierId,
      editionId,
      packageId,
    });

    const editions = await t.query(api.packageEditions.listForCreator, {
      apiSecret: 'test-secret',
      actor: await creatorActor(authUserId),
      authUserId,
      packageId,
    });
    expect(editions).toHaveLength(1);
    expect(editions[0]).toMatchObject({
      catalogProductIds: [seeded.catalogProductId],
      catalogTierIds: [seeded.catalogTierId],
      displayName: 'Gold patrons',
      editionId,
      priority: 100,
      status: 'active',
    });
  });

  it('rejects an owned catalog product that is not explicitly associated with the package', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-unrelated-edition-product';
    const packageId = 'com.yucp.edition-association';
    const [associatedProductId, unrelatedProductId] = await t.run(async (ctx) => {
      const now = Date.now();
      const associated = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'associated-product',
        provider: 'gumroad',
        providerProductRef: 'associated-product-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      const unrelated = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'unrelated-product',
        provider: 'jinxxy',
        providerProductRef: 'unrelated-product-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${authUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: authUserId,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId: associated,
        creatorAuthUserId: authUserId,
        packageId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_versions_ref', {
        ...readyPublicationFields(),
        packageId,
        version: '1.0.0',
        versionId: crypto.randomUUID(),
        state: 'READY',
        catalogProductId: associated,
        createdAt: now,
      });
      return [associated, unrelated] as const;
    });

    await expect(
      t.mutation(api.packageEditions.upsertForCreator, {
        apiSecret: 'test-secret',
        actor: await creatorActor(authUserId),
        authUserId,
        catalogProductIds: [associatedProductId, unrelatedProductId],
        catalogTierIds: [],
        displayName: 'Unsafe association',
        editionId: 'unsafe-association',
        packageId,
        priority: 1,
      })
    ).rejects.toThrow('Catalog product is not associated with this package');
  });

  it('preserves explicit mappings across associated storefront products', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-cross-store-edition';
    const packageId = 'com.yucp.cross-store-edition';
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const products = [];
      const tiers = [];
      for (const [index, provider] of ['gumroad', 'jinxxy'].entries()) {
        const catalogProductId = await ctx.db.insert('product_catalog', {
          authUserId,
          productId: `${provider}-edition-product`,
          provider: provider as 'gumroad' | 'jinxxy',
          providerProductRef: `${provider}-edition-ref`,
          status: 'active',
          supportsAutoDiscovery: true,
          createdAt: now,
          updatedAt: now,
        });
        const catalogTierId = await ctx.db.insert('catalog_tiers', {
          authUserId,
          catalogProductId,
          productId: `${provider}-edition-product`,
          provider: provider as 'gumroad' | 'jinxxy',
          providerProductRef: `${provider}-edition-ref`,
          providerTierRef: `${provider}-commercial`,
          displayName: `${provider} commercial`,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        if (index === 1) {
          await ctx.db.insert('package_versions_ref', {
            ...readyPublicationFields(),
            packageId,
            version: '1.0.0',
            versionId: crypto.randomUUID(),
            state: 'READY',
            catalogProductId,
            createdAt: now + index,
          });
        }
        await ctx.db.insert('package_catalog_bindings', {
          catalogProductId,
          creatorAuthUserId: authUserId,
          packageId,
          status: 'active',
          createdAt: now + index,
          updatedAt: now + index,
        });
        products.push(catalogProductId);
        tiers.push(catalogTierId);
      }
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${authUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: authUserId,
      });
      return { products, tiers };
    });

    await t.mutation(api.packageEditions.upsertForCreator, {
      apiSecret: 'test-secret',
      actor: await creatorActor(authUserId),
      authUserId,
      catalogProductIds: seeded.products,
      catalogTierIds: seeded.tiers,
      displayName: 'Commercial',
      editionId: 'commercial',
      packageId,
      priority: 100,
    });
    const editions = await t.query(api.packageEditions.listForCreator, {
      apiSecret: 'test-secret',
      actor: await creatorActor(authUserId),
      authUserId,
      packageId,
    });

    expect(editions).toHaveLength(1);
    expect(editions[0]).toMatchObject({
      catalogProductIds: seeded.products,
      catalogTierIds: seeded.tiers,
    });
  });

  it('selects the highest-priority edition that matches verified tier evidence', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-editions';
    const buyerAuthUserId = 'buyer-editions';
    const packageId = 'com.yucp.editions';
    const subjectId = await seedSubject(t, { authUserId: buyerAuthUserId });
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        createdAt: now,
        displayName: 'Edition Product',
        productId: 'edition-product',
        provider: 'patreon',
        providerProductRef: 'edition-product-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        packageName: 'Edition Product',
        publisherId: `creator:${creatorAuthUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: creatorAuthUserId,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId,
        creatorAuthUserId,
        packageId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_versions_ref', {
        ...readyPublicationFields(),
        packageId,
        version: '1.0.0',
        versionId: crypto.randomUUID(),
        state: 'READY',
        catalogProductId,
        createdAt: now,
      });
      const commercialTierId = await ctx.db.insert('catalog_tiers', {
        authUserId: creatorAuthUserId,
        catalogProductId,
        createdAt: now,
        displayName: 'Commercial',
        productId: 'edition-product',
        provider: 'patreon',
        providerProductRef: 'edition-product-ref',
        providerTierRef: 'commercial',
        status: 'active',
        updatedAt: now,
      });
      const entitlementId = await ctx.db.insert('entitlements', {
        authUserId: creatorAuthUserId,
        catalogProductId,
        grantedAt: now,
        productId: 'edition-product',
        sourceProvider: 'patreon',
        sourceReference: 'membership-commercial',
        status: 'active',
        subjectId,
        updatedAt: now,
      });
      await ctx.db.insert('entitlement_evidence', {
        authUserId: creatorAuthUserId,
        catalogProductId,
        createdAt: now,
        evidenceType: 'membership',
        observedAt: now,
        productId: 'edition-product',
        providerKey: 'patreon',
        providerTierRefs: ['commercial'],
        sourceReference: 'membership-commercial',
        status: 'active',
        subjectId,
        updatedAt: now,
      });
      return { catalogProductId, commercialTierId, entitlementId };
    });
    const actor = await creatorActor(creatorAuthUserId);

    await t.mutation(api.packageEditions.upsertForCreator, {
      apiSecret: 'test-secret',
      actor,
      authUserId: creatorAuthUserId,
      catalogProductIds: [seeded.catalogProductId],
      catalogTierIds: [],
      displayName: 'Personal',
      editionId: 'personal',
      packageId,
      priority: 0,
    });
    await t.mutation(api.packageEditions.upsertForCreator, {
      apiSecret: 'test-secret',
      actor,
      authUserId: creatorAuthUserId,
      catalogProductIds: [seeded.catalogProductId],
      catalogTierIds: [seeded.commercialTierId],
      displayName: 'Commercial',
      editionId: 'commercial',
      packageId,
      priority: 100,
    });

    const resolved = await t.query(api.packageEditions.resolveBuyerEdition, {
      apiSecret: 'test-secret',
      actor: await downloadActor(buyerAuthUserId),
      buyerAuthUserId,
      catalogProductIds: [seeded.catalogProductId],
      packageId,
    });

    expect(resolved).toMatchObject({
      editionId: 'commercial',
      matchedCatalogProductId: seeded.catalogProductId,
      matchedCatalogTierIds: [seeded.commercialTierId],
    });
  });

  it('does not apply one storefront tier restriction to another storefront', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-cross-store-tier-scope';
    const buyerAuthUserId = 'buyer-cross-store-tier-scope';
    const packageId = 'com.yucp.cross-store-tier-scope';
    const subjectId = await seedSubject(t, { authUserId: buyerAuthUserId });
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const gumroadProductId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        createdAt: now,
        displayName: 'Shared product',
        productId: 'gumroad-shared-product',
        provider: 'gumroad',
        providerProductRef: 'gumroad-shared-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: now,
      });
      const jinxxyProductId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        createdAt: now,
        displayName: 'Shared product',
        productId: 'jinxxy-shared-product',
        provider: 'jinxxy',
        providerProductRef: 'jinxxy-shared-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${creatorAuthUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: creatorAuthUserId,
      });
      for (const catalogProductId of [gumroadProductId, jinxxyProductId]) {
        await ctx.db.insert('package_catalog_bindings', {
          catalogProductId,
          creatorAuthUserId,
          packageId,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
      }
      const gumroadCommercialTierId = await ctx.db.insert('catalog_tiers', {
        authUserId: creatorAuthUserId,
        catalogProductId: gumroadProductId,
        createdAt: now,
        displayName: 'Commercial',
        productId: 'gumroad-shared-product',
        provider: 'gumroad',
        providerProductRef: 'gumroad-shared-ref',
        providerTierRef: 'commercial',
        status: 'active',
        updatedAt: now,
      });
      await ctx.db.insert('package_editions', {
        catalogProductIds: [gumroadProductId, jinxxyProductId],
        catalogTierIds: [gumroadCommercialTierId],
        createdAt: now,
        creatorAuthUserId,
        displayName: 'Commercial',
        editionId: 'commercial',
        packageId,
        priority: 100,
        status: 'active',
        updatedAt: now,
      });
      await ctx.db.insert('entitlements', {
        authUserId: creatorAuthUserId,
        catalogProductId: jinxxyProductId,
        grantedAt: now,
        productId: 'jinxxy-shared-product',
        sourceProvider: 'jinxxy',
        sourceReference: 'jinxxy-license',
        status: 'active',
        subjectId,
        updatedAt: now,
      });
      return { jinxxyProductId };
    });

    const resolved = await t.query(api.packageEditions.resolveBuyerEdition, {
      apiSecret: 'test-secret',
      actor: await downloadActor(buyerAuthUserId),
      buyerAuthUserId,
      catalogProductIds: await t.run(async (ctx) => {
        const bindings = await ctx.db
          .query('package_catalog_bindings')
          .withIndex('by_creator_package_status', (q) =>
            q.eq('creatorAuthUserId', creatorAuthUserId).eq('packageId', packageId)
          )
          .collect();
        return bindings.map((binding) => binding.catalogProductId);
      }),
      packageId,
    });

    expect(resolved).toMatchObject({
      editionId: 'commercial',
      matchedCatalogProductId: seeded.jinxxyProductId,
      matchedCatalogTierIds: [],
    });
  });

  it('maps a legacy entitlement by provider and product identity', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-legacy-provider-product';
    const buyerAuthUserId = 'buyer-legacy-provider-product';
    const packageId = 'com.yucp.legacy-provider-product';
    const subjectId = await seedSubject(t, { authUserId: buyerAuthUserId });
    const [jinxxyProductId, gumroadProductId] = await t.run(async (ctx) => {
      const now = Date.now();
      const products = [];
      for (const provider of ['jinxxy', 'gumroad'] as const) {
        const catalogProductId = await ctx.db.insert('product_catalog', {
          authUserId: creatorAuthUserId,
          createdAt: now,
          displayName: `${provider} shared product`,
          productId: 'shared-legacy-product',
          provider,
          providerProductRef: `${provider}-shared-legacy-ref`,
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: now,
        });
        await ctx.db.insert('package_catalog_bindings', {
          catalogProductId,
          creatorAuthUserId,
          packageId,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        products.push(catalogProductId);
      }
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${creatorAuthUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: creatorAuthUserId,
      });
      await ctx.db.insert('package_editions', {
        catalogProductIds: [products[0]],
        catalogTierIds: [],
        createdAt: now,
        creatorAuthUserId,
        displayName: 'Jinxxy edition',
        editionId: 'jinxxy-edition',
        packageId,
        priority: 100,
        status: 'active',
        updatedAt: now,
      });
      await ctx.db.insert('entitlements', {
        authUserId: creatorAuthUserId,
        grantedAt: now,
        productId: 'shared-legacy-product',
        sourceProvider: 'jinxxy',
        sourceReference: 'legacy-jinxxy-license',
        status: 'active',
        subjectId,
        updatedAt: now,
      });
      return products as [(typeof products)[number], (typeof products)[number]];
    });

    const resolved = await t.query(api.packageEditions.resolveBuyerEdition, {
      apiSecret: 'test-secret',
      actor: await downloadActor(buyerAuthUserId),
      buyerAuthUserId,
      catalogProductIds: [jinxxyProductId, gumroadProductId],
      packageId,
    });

    expect(resolved).toMatchObject({
      editionId: 'jinxxy-edition',
      matchedCatalogProductId: jinxxyProductId,
    });
  });

  it('fails closed when a legacy provider and product identity is ambiguous', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-legacy-provider-collision';
    const buyerAuthUserId = 'buyer-legacy-provider-collision';
    const packageId = 'com.yucp.legacy-provider-collision';
    const subjectId = await seedSubject(t, { authUserId: buyerAuthUserId });
    const catalogProductIds = await t.run(async (ctx) => {
      const now = Date.now();
      const products = [];
      for (const suffix of ['first', 'second']) {
        const catalogProductId = await ctx.db.insert('product_catalog', {
          authUserId: creatorAuthUserId,
          createdAt: now,
          displayName: `Jinxxy collision ${suffix}`,
          productId: 'ambiguous-legacy-product',
          provider: 'jinxxy',
          providerProductRef: `jinxxy-collision-${suffix}`,
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: now,
        });
        await ctx.db.insert('package_catalog_bindings', {
          catalogProductId,
          creatorAuthUserId,
          packageId,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        products.push(catalogProductId);
      }
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${creatorAuthUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: creatorAuthUserId,
      });
      await ctx.db.insert('entitlements', {
        authUserId: creatorAuthUserId,
        grantedAt: now,
        productId: 'ambiguous-legacy-product',
        sourceProvider: 'jinxxy',
        sourceReference: 'legacy-ambiguous-license',
        status: 'active',
        subjectId,
        updatedAt: now,
      });
      return products;
    });

    const resolved = await t.query(api.packageEditions.resolveBuyerEdition, {
      apiSecret: 'test-secret',
      actor: await downloadActor(buyerAuthUserId),
      buyerAuthUserId,
      catalogProductIds,
      packageId,
    });

    expect(resolved).toBeNull();
  });

  it('does not authorize a catalog product that is bound to another package', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-cross-package-entitlement';
    const buyerAuthUserId = 'buyer-cross-package-entitlement';
    const subjectId = await seedSubject(t, { authUserId: buyerAuthUserId });
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        createdAt: now,
        displayName: 'Other package product',
        productId: 'other-package-product',
        provider: 'gumroad',
        providerProductRef: 'other-package-product-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId: productId,
        creatorAuthUserId,
        packageId: 'com.yucp.other-package',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('entitlements', {
        authUserId: creatorAuthUserId,
        catalogProductId: productId,
        grantedAt: now,
        productId: 'other-package-product',
        sourceProvider: 'gumroad',
        sourceReference: 'cross-package-license',
        status: 'active',
        subjectId,
        updatedAt: now,
      });
      return productId;
    });

    const resolved = await t.query(api.packageEditions.resolveBuyerEdition, {
      apiSecret: 'test-secret',
      actor: await downloadActor(buyerAuthUserId),
      buyerAuthUserId,
      catalogProductIds: [catalogProductId],
      packageId: 'com.yucp.requested-package',
    });

    expect(resolved).toBeNull();
  });

  it('rejects tier mappings that belong to another creator', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const otherTierId = await t.run(async (ctx) => {
      return await ctx.db.insert('catalog_tiers', {
        authUserId: 'other-creator',
        createdAt: now,
        displayName: 'Other Tier',
        productId: 'other-product',
        provider: 'patreon',
        providerProductRef: 'other-product-ref',
        providerTierRef: 'other-tier',
        status: 'active',
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(api.packageEditions.upsertForCreator, {
        apiSecret: 'test-secret',
        actor: await creatorActor('creator-owner'),
        authUserId: 'creator-owner',
        catalogProductIds: [],
        catalogTierIds: [otherTierId],
        displayName: 'Invalid',
        editionId: 'invalid',
        packageId: 'com.yucp.owner',
        priority: 0,
      })
    ).rejects.toThrow();
  });

  it('uses the standard edition when no active custom edition matches the buyer', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-standard-fallback';
    const buyerAuthUserId = 'buyer-standard-fallback';
    const packageId = 'com.yucp.standard-fallback';
    const subjectId = await seedSubject(t, { authUserId: buyerAuthUserId });
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        createdAt: now,
        displayName: 'Standard Fallback Product',
        productId: 'standard-fallback-product',
        provider: 'patreon',
        providerProductRef: 'standard-fallback-product-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        packageName: 'Standard Fallback Product',
        publisherId: `creator:${creatorAuthUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: creatorAuthUserId,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId,
        creatorAuthUserId,
        packageId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_versions_ref', {
        ...readyPublicationFields(),
        packageId,
        version: '1.0.0',
        versionId: crypto.randomUUID(),
        state: 'READY',
        catalogProductId,
        createdAt: now,
      });
      const commercialTierId = await ctx.db.insert('catalog_tiers', {
        authUserId: creatorAuthUserId,
        catalogProductId,
        createdAt: now,
        displayName: 'Commercial',
        productId: 'standard-fallback-product',
        provider: 'patreon',
        providerProductRef: 'standard-fallback-product-ref',
        providerTierRef: 'commercial',
        status: 'active',
        updatedAt: now,
      });
      await ctx.db.insert('entitlements', {
        authUserId: creatorAuthUserId,
        catalogProductId,
        grantedAt: now,
        productId: 'standard-fallback-product',
        sourceProvider: 'patreon',
        sourceReference: 'purchase-personal',
        status: 'active',
        subjectId,
        updatedAt: now,
      });
      return { catalogProductId, commercialTierId };
    });

    await t.mutation(api.packageEditions.upsertForCreator, {
      apiSecret: 'test-secret',
      actor: await creatorActor(creatorAuthUserId),
      authUserId: creatorAuthUserId,
      catalogProductIds: [seeded.catalogProductId],
      catalogTierIds: [seeded.commercialTierId],
      displayName: 'Commercial',
      editionId: 'commercial',
      packageId,
      priority: 100,
    });

    const resolved = await t.query(api.packageEditions.resolveBuyerEdition, {
      apiSecret: 'test-secret',
      actor: await downloadActor(buyerAuthUserId),
      buyerAuthUserId,
      catalogProductIds: [seeded.catalogProductId],
      packageId,
    });

    expect(resolved).toMatchObject({
      editionId: 'standard',
      matchedCatalogProductId: seeded.catalogProductId,
      matchedCatalogTierIds: [],
    });
  });

  it('does not archive the built-in standard edition', async () => {
    const creatorAuthUserId = 'creator-standard-edition';
    const t = makeTestConvex();

    await expect(
      t.mutation(api.packageEditions.archiveForCreator, {
        apiSecret: 'test-secret',
        actor: await creatorActor(creatorAuthUserId),
        authUserId: creatorAuthUserId,
        editionId: 'standard',
        packageId: 'com.yucp.standard-edition',
      })
    ).rejects.toThrow('The standard edition is always available');
  });
});
