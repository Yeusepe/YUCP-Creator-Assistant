import {
  createApiActorBinding,
  createAuthUserApiActor,
  createServiceApiActor,
} from '@yucp/shared/apiActor';
import { describe, expect, it } from 'vitest';
import { ACTIVE_PROTECTION_POLICY_ID } from '../ops/storage-core/protectionPolicyId';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

async function creatorActor(authUserId: string) {
  return await createApiActorBinding(
    createAuthUserApiActor({ authUserId, source: 'session' }),
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function buyerRepositoryActor(authUserId?: string) {
  return await createApiActorBinding(
    createServiceApiActor({
      ...(authUserId ? { authUserId } : {}),
      service: 'buyer-vpm-repository',
      scopes: ['downloads:service'],
      now: Date.now(),
    }),
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

describe('buyer and creator VPM repositories', () => {
  it('keeps one tailored link while dynamically reflecting every entitled enabled package', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const creatorAuthUserId = 'creator-song-things';
    const buyerAuthUserId = 'buyer-song-things';
    const creatorSlug = 'yeusepe';
    const packageIds = ['com.yucp.songthing', 'com.yucp.songthingextras'];

    const fixtures = await t.run(async (ctx) => {
      await ctx.db.insert('creator_profiles', {
        authUserId: creatorAuthUserId,
        deliverySlug: creatorSlug,
        name: 'Yeusepe',
        ownerDiscordUserId: 'discord-creator-song-things',
        slug: creatorSlug,
        status: 'active',
        policy: {},
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert('subjects', {
        authUserId: buyerAuthUserId,
        primaryDiscordUserId: 'discord-buyer-song-things',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const catalogProductIds: Id<'product_catalog'>[] = [];
      const entitlementIds: Id<'entitlements'>[] = [];
      for (const [index, packageId] of packageIds.entries()) {
        const productId = `song-product-${index + 1}`;
        const catalogProductId = await ctx.db.insert('product_catalog', {
          authUserId: creatorAuthUserId,
          productId,
          provider: 'manual',
          providerProductRef: `${productId}-ref`,
          displayName: index === 0 ? 'Song Thing' : 'Song Thing Extras',
          status: 'active',
          supportsAutoDiscovery: false,
          createdAt: now,
          updatedAt: now,
        });
        catalogProductIds.push(catalogProductId);
        await ctx.db.insert('package_registry', {
          packageId,
          packageName: index === 0 ? 'Song Thing' : 'Song Thing Extras',
          publisherId: `creator:${creatorAuthUserId}`,
          yucpUserId: creatorAuthUserId,
          status: 'active',
          registeredAt: now,
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
        await ctx.db.insert('package_editions', {
          catalogProductIds: [catalogProductId],
          catalogTierIds: [],
          createdAt: now,
          creatorAuthUserId,
          displayName: 'Standard',
          editionId: 'standard',
          packageId,
          priority: 0,
          status: 'active',
          updatedAt: now,
        });
        await ctx.db.insert('package_versions_ref', {
          packageId,
          editionId: 'standard',
          version: `${index + 1}.0.0`,
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
          releaseRoot: `${index + 7}`.repeat(64).slice(0, 64),
          vpmDependencies: {},
          vpmRepositories: {},
          channel: 'stable',
          state: 'READY',
          catalogProductId,
          createdAt: now + index,
        });
        entitlementIds.push(
          await ctx.db.insert('entitlements', {
            authUserId: creatorAuthUserId,
            subjectId,
            productId,
            sourceProvider: 'manual',
            sourceReference: `verification-${index + 1}`,
            catalogProductId,
            status: 'active',
            grantedAt: now,
            updatedAt: now,
          })
        );
      }
      return { catalogProductIds, entitlementIds };
    });

    const creator = await creatorActor(creatorAuthUserId);
    for (const [index, packageId] of packageIds.entries()) {
      await t.mutation(api.creatorVpmLinks.ensureActive, {
        apiSecret: 'test-secret',
        actor: creator,
        authUserId: creatorAuthUserId,
        creatorSlug,
        packageId,
        proposedLinkId: String(index + 1).repeat(43),
      });
    }

    const buyerActor = await buyerRepositoryActor(buyerAuthUserId);
    const repositories = api.buyerCreatorVpmRepositories;
    const first = await t.mutation(repositories.ensureActive, {
      apiSecret: 'test-secret',
      actor: buyerActor,
      buyerAuthUserId,
      creatorAuthUserId,
      creatorSlug,
      requiredCatalogProductIds: [fixtures.catalogProductIds[0]],
      proposedLinkId: 'A'.repeat(43),
    });
    const secondProductPage = await t.mutation(repositories.ensureActive, {
      apiSecret: 'test-secret',
      actor: buyerActor,
      buyerAuthUserId,
      creatorAuthUserId,
      creatorSlug,
      requiredCatalogProductIds: [fixtures.catalogProductIds[1]],
      proposedLinkId: 'B'.repeat(43),
    });
    const repository = await t.query(repositories.getActiveByLinkId, {
      apiSecret: 'test-secret',
      actor: await buyerRepositoryActor(),
      linkId: 'A'.repeat(43),
    });

    expect(first).toMatchObject({ created: true, linkId: 'A'.repeat(43) });
    expect(secondProductPage).toMatchObject({ created: false, linkId: 'A'.repeat(43) });
    expect(repository).toMatchObject({
      creatorName: 'Yeusepe',
      creatorSlug,
      linkId: 'A'.repeat(43),
      packages: [
        { packageId: packageIds[0], version: '1.0.0' },
        { packageId: packageIds[1], version: '2.0.0' },
      ],
      packageIds,
    });

    await t.run(async (ctx) => {
      const stable = await ctx.db
        .query('package_versions_ref')
        .withIndex('by_package_version', (q) =>
          q.eq('packageId', packageIds[0] as string).eq('version', '1.0.0')
        )
        .unique();
      expect(stable).not.toBeNull();
      await ctx.db.patch(stable?._id as Id<'package_versions_ref'>, {
        state: 'SUPERSEDED',
      });
      await ctx.db.insert('package_versions_ref', {
        packageId: packageIds[0] as string,
        editionId: 'standard',
        version: '2.0.0-beta.1',
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
        releaseRoot: '09'.repeat(32),
        vpmDependencies: {},
        vpmRepositories: {},
        channel: 'stable',
        state: 'READY',
        catalogProductId: fixtures.catalogProductIds[0],
        createdAt: now + 10,
      });
    });
    const withPrereleaseCurrent = await t.query(repositories.getActiveByLinkId, {
      apiSecret: 'test-secret',
      actor: await buyerRepositoryActor(),
      linkId: 'A'.repeat(43),
    });
    expect(withPrereleaseCurrent?.packages[0]?.version).toBe('1.0.0');

    await t.run(async (ctx) => {
      await ctx.db.patch(fixtures.entitlementIds[1], {
        status: 'revoked',
        revokedAt: now + 1,
        updatedAt: now + 1,
      });
    });
    const afterRevocation = await t.query(repositories.getActiveByLinkId, {
      apiSecret: 'test-secret',
      actor: await buyerRepositoryActor(),
      linkId: 'A'.repeat(43),
    });

    expect(afterRevocation).toMatchObject({ packageIds: [packageIds[0]] });
  });
});
