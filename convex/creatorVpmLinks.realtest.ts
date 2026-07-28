import {
  createApiActorBinding,
  createAuthUserApiActor,
  createServiceApiActor,
} from '@yucp/shared/apiActor';
import { describe, expect, it } from 'vitest';
import { ACTIVE_PROTECTION_POLICY_ID } from '../ops/storage-core/protectionPolicyId';
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

async function repositoryActor() {
  return await createApiActorBinding(
    createServiceApiActor({
      service: 'vpm-repository',
      scopes: ['downloads:service'],
      now: Date.now(),
    }),
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

function creatorSlug(authUserId: string): string {
  return authUserId.replace(/^creator-/, '').replace(/[^a-z0-9-]+/g, '-');
}

async function seedOwnedPackage(
  t: ReturnType<typeof makeTestConvex>,
  authUserId: string,
  packageId: string
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('creator_profiles', {
      authUserId,
      deliverySlug: creatorSlug(authUserId),
      name: `Creator ${authUserId}`,
      ownerDiscordUserId: `discord-${authUserId}`,
      slug: creatorSlug(authUserId),
      status: 'active',
      policy: {},
      createdAt: now,
      updatedAt: now,
    });
    const catalogProductId = await ctx.db.insert('product_catalog', {
      authUserId,
      productId: 'durable-vcc-product',
      provider: 'manual',
      providerProductRef: 'durable-vcc-product-ref',
      displayName: 'Durable VCC Product',
      status: 'active',
      supportsAutoDiscovery: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('package_registry', {
      packageId,
      packageName: 'Durable VCC Product',
      publisherId: `creator:${authUserId}`,
      yucpUserId: authUserId,
      status: 'active',
      registeredAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('package_catalog_bindings', {
      catalogProductId,
      creatorAuthUserId: authUserId,
      packageId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('package_versions_ref', {
      packageId,
      version: '1.0.0',
      versionId: crypto.randomUUID(),
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
      channel: 'stable',
      state: 'READY',
      catalogProductId,
      createdAt: now,
    });
    return catalogProductId;
  });
}

describe('creator VPM links', () => {
  it('returns the same active link across independent callers and elapsed time', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-durable-vcc';
    const packageId = 'com.yucp.durable-vcc';
    await seedOwnedPackage(t, authUserId, packageId);
    const actor = await creatorActor(authUserId);

    const created = await t.mutation(api.creatorVpmLinks.ensureActive, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      packageId,
      creatorSlug: creatorSlug(authUserId),
      proposedLinkId: 'A'.repeat(43),
    });
    const afterRestart = await t.mutation(api.creatorVpmLinks.ensureActive, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      packageId,
      creatorSlug: creatorSlug(authUserId),
      proposedLinkId: 'B'.repeat(43),
    });

    expect(created).toMatchObject({
      created: true,
      creatorSlug: creatorSlug(authUserId),
      linkId: 'A'.repeat(43),
      status: 'active',
    });
    expect(afterRestart).toMatchObject({
      created: false,
      linkId: 'A'.repeat(43),
      status: 'active',
    });
    expect(afterRestart.createdAt).toBe(created.createdAt);
  });

  it('returns one package-scoped link to independent repository service callers', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-buyer-vcc';
    const packageId = 'com.yucp.buyer-vcc';
    await seedOwnedPackage(t, authUserId, packageId);
    await t.mutation(api.creatorVpmLinks.ensureActive, {
      apiSecret: 'test-secret',
      actor: await creatorActor(authUserId),
      authUserId,
      packageId,
      creatorSlug: creatorSlug(authUserId),
      proposedLinkId: 'B'.repeat(43),
    });

    const first = await t.query(api.creatorVpmLinks.getActiveForPackageAccess, {
      apiSecret: 'test-secret',
      actor: await repositoryActor(),
      authUserId,
      packageId,
    });
    const second = await t.query(api.creatorVpmLinks.getActiveForPackageAccess, {
      apiSecret: 'test-secret',
      actor: await repositoryActor(),
      authUserId,
      packageId,
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      linkId: 'B'.repeat(43),
      packageId,
      status: 'active',
    });
  });

  it('creates one package link without selecting a storefront', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-provider-neutral-vcc';
    const packageId = 'com.yucp.provider-neutral-vcc';
    await seedOwnedPackage(t, authUserId, packageId);

    const created = await t.mutation(api.creatorVpmLinks.ensureActive, {
      apiSecret: 'test-secret',
      actor: await creatorActor(authUserId),
      authUserId,
      packageId,
      creatorSlug: creatorSlug(authUserId),
      proposedLinkId: 'H'.repeat(43),
    });

    expect(created).toMatchObject({
      created: true,
      linkId: 'H'.repeat(43),
      packageId,
      status: 'active',
    });
  });

  it('revokes the active link and creates a replacement without reactivating the old link', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-revoke-vcc';
    const packageId = 'com.yucp.revoke-vcc';
    await seedOwnedPackage(t, authUserId, packageId);
    const actor = await creatorActor(authUserId);
    const serviceActor = await repositoryActor();

    await t.mutation(api.creatorVpmLinks.ensureActive, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      packageId,
      creatorSlug: creatorSlug(authUserId),
      proposedLinkId: 'C'.repeat(43),
    });
    const revoked = await t.mutation(api.creatorVpmLinks.revokeActive, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      packageId,
    });
    const revokedLookup = await t.query(api.creatorVpmLinks.getActiveByLinkId, {
      apiSecret: 'test-secret',
      actor: serviceActor,
      linkId: 'C'.repeat(43),
    });
    const revokedPackageLookup = await t.query(api.creatorVpmLinks.getActiveForPackageAccess, {
      apiSecret: 'test-secret',
      actor: serviceActor,
      authUserId,
      packageId,
    });
    const replacement = await t.mutation(api.creatorVpmLinks.ensureActive, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      packageId,
      creatorSlug: creatorSlug(authUserId),
      proposedLinkId: 'D'.repeat(43),
    });

    expect(revoked).toEqual({ revoked: true });
    expect(revokedLookup).toBeNull();
    expect(revokedPackageLookup).toBeNull();
    expect(replacement).toMatchObject({
      created: true,
      linkId: 'D'.repeat(43),
      status: 'active',
    });
  });

  it('keeps a creator link manageable after every downloadable release is deleted', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-delete-all-vcc';
    const packageId = 'com.yucp.delete-all-vcc';
    const catalogProductId = await seedOwnedPackage(t, authUserId, packageId);
    const actor = await creatorActor(authUserId);
    const serviceActor = await repositoryActor();

    await t.mutation(api.creatorVpmLinks.ensureActive, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      packageId,
      creatorSlug: creatorSlug(authUserId),
      proposedLinkId: 'F'.repeat(43),
    });
    await t.run(async (ctx) => {
      const versions = await ctx.db
        .query('package_versions_ref')
        .withIndex('by_package_channel', (q) => q.eq('packageId', packageId))
        .collect();
      for (const version of versions) {
        await ctx.db.patch(version._id, { deletedAt: Date.now(), state: 'DELETED' });
      }
    });

    const stillManageable = await t.query(api.creatorVpmLinks.getActiveForCreator, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      packageId,
    });
    const revoked = await t.mutation(api.creatorVpmLinks.revokeActive, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      packageId,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('package_versions_ref', {
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
        packageId,
        version: '2.0.0',
        versionId: crypto.randomUUID(),
        channel: 'stable',
        state: 'READY',
        catalogProductId,
        createdAt: Date.now(),
      });
    });
    const oldLink = await t.query(api.creatorVpmLinks.getActiveByLinkId, {
      apiSecret: 'test-secret',
      actor: serviceActor,
      linkId: 'F'.repeat(43),
    });

    expect(stillManageable).toMatchObject({ linkId: 'F'.repeat(43), status: 'active' });
    expect(revoked).toEqual({ revoked: true });
    expect(oldLink).toBeNull();
  });

  it('keeps the package-scoped link active when one linked storefront is removed', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-package-scoped-vcc';
    const packageId = 'com.yucp.package-scoped-vcc';
    const firstCatalogProductId = await seedOwnedPackage(t, authUserId, packageId);
    const secondCatalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'package-scoped-second-store',
        provider: 'jinxxy',
        providerProductRef: 'package-scoped-second-store-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
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
    const actor = await creatorActor(authUserId);
    const serviceActor = await repositoryActor();
    await t.mutation(api.creatorVpmLinks.ensureActive, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      packageId,
      creatorSlug: creatorSlug(authUserId),
      proposedLinkId: 'G'.repeat(43),
    });

    await t.mutation(api.packageRegistry.unbindCatalogProductForCreator, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      catalogProductId: firstCatalogProductId,
      packageId,
    });
    const link = await t.query(api.creatorVpmLinks.getActiveByLinkId, {
      apiSecret: 'test-secret',
      actor: serviceActor,
      linkId: 'G'.repeat(43),
    });
    const product = await t.query(api.packageRegistry.getBuyerAccessContextByPackageId, {
      apiSecret: 'test-secret',
      actor: serviceActor,
      packageId,
    });

    expect(link).toMatchObject({ linkId: 'G'.repeat(43), packageId, status: 'active' });
    expect(product).toMatchObject({
      catalogProductId: secondCatalogProductId,
      catalogProductIds: [secondCatalogProductId],
      packageId,
    });
  });

  it('serves a package-scoped link through another active storefront when the first is hidden', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-package-scoped-hidden-store';
    const packageId = 'com.yucp.package-scoped-hidden-store';
    const firstCatalogProductId = await seedOwnedPackage(t, authUserId, packageId);
    const secondCatalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'package-scoped-visible-store',
        provider: 'jinxxy',
        providerProductRef: 'package-scoped-visible-store-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
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
      const firstProduct = await ctx.db.get(firstCatalogProductId);
      if (!firstProduct) {
        throw new Error('First storefront fixture is missing');
      }
      await ctx.db.patch(firstProduct._id, {
        status: 'hidden',
        updatedAt: now + 1,
      });
      return productId;
    });

    const product = await t.query(api.packageRegistry.getBuyerAccessContextByPackageId, {
      apiSecret: 'test-secret',
      actor: await repositoryActor(),
      packageId,
    });

    expect(product).toMatchObject({
      catalogProductId: secondCatalogProductId,
      catalogProductIds: [secondCatalogProductId],
      packageId,
    });
  });

  it('does not let another creator inspect or revoke an owned link', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-owner-vcc';
    const packageId = 'com.yucp.owner-vcc';
    await seedOwnedPackage(t, authUserId, packageId);
    await t.mutation(api.creatorVpmLinks.ensureActive, {
      apiSecret: 'test-secret',
      actor: await creatorActor(authUserId),
      authUserId,
      packageId,
      creatorSlug: creatorSlug(authUserId),
      proposedLinkId: 'E'.repeat(43),
    });

    await expect(
      t.mutation(api.creatorVpmLinks.revokeActive, {
        apiSecret: 'test-secret',
        actor: await creatorActor('different-creator'),
        authUserId: 'different-creator',
        packageId,
      })
    ).rejects.toThrow();
  });
});
