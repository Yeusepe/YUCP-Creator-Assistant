import { createApiActorBinding } from '@yucp/shared/apiActor';
import { describe, expect, it } from 'vitest';
import { ACTIVE_PROTECTION_POLICY_ID } from '../ops/storage-core/protectionPolicyId';
import { api } from './_generated/api';
import { makeTestConvex } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

async function createDownloadServiceActorBinding() {
  const now = Date.now();
  return await createApiActorBinding(
    {
      version: 1,
      kind: 'service',
      service: 'api-server',
      scopes: ['downloads:service'],
      issuedAt: now,
      expiresAt: now + 60_000,
    },
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function authenticatedReadyVersionArgs<T extends Record<string, unknown>>(input: T) {
  return {
    apiSecret: 'test-secret',
    actor: await createDownloadServiceActorBinding(),
    activeContentDigest: '55'.repeat(32),
    activePolicyVersion: 'active-content-policy-v1',
    bindingRoot: '22'.repeat(32),
    commonRoot: '66'.repeat(32),
    logicalBytes: 1_024,
    logicalFiles: 2,
    manifestSha256: '33'.repeat(32),
    protectedFiles: [],
    protectedSourceRoot: '77'.repeat(32),
    protectionPolicyDigest: '88'.repeat(32),
    protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
    releaseRoot: '44'.repeat(32),
    vpmDependencies: {},
    vpmRepositories: {},
    ...input,
  };
}

async function seedActivePackageEditions(
  t: ReturnType<typeof makeTestConvex>,
  packageId: string,
  editionIds: string[]
): Promise<void> {
  const creatorAuthUserId = `creator-${packageId}`;
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('package_registry', {
      packageId,
      publisherId: `creator:${creatorAuthUserId}`,
      registeredAt: now,
      status: 'active',
      updatedAt: now,
      yucpUserId: creatorAuthUserId,
    });
    for (const [priority, editionId] of editionIds.entries()) {
      await ctx.db.insert('package_editions', {
        catalogProductIds: [],
        catalogTierIds: [],
        createdAt: now,
        creatorAuthUserId,
        displayName: editionId,
        editionId,
        packageId,
        priority,
        status: 'active',
        updatedAt: now,
      });
    }
  });
}

describe('packageVersions', () => {
  it('inserts a READY package version reference with the stable channel by default', async () => {
    const t = makeTestConvex();
    const createdAt = Date.now();

    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        bootstrapMedia: [
          {
            bucketName: 'metadata',
            byteSize: 9,
            contentType: 'image/png',
            kind: 'icon',
            localPath: 'Documentation~/YUCP/icon.png',
            objectKey: 'indexes/bootstrap-media/abc.png',
            providerVersion: 'exact-version-1',
            sha256: 'aa'.repeat(32),
          },
        ],
        packageId: 'com.yucp.avatar-tools',
        packageMetadata: {
          author: 'YUCP Studio',
          description: 'Avatar tools.',
          packageName: 'Avatar Tools',
          version: '1.0.0',
        },
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000001',
        createdAt,
      })
    );

    const rows = await t.run(async (ctx) => await ctx.db.query('package_versions_ref').collect());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      packageId: 'com.yucp.avatar-tools',
      version: '1.0.0',
      versionId: '00000000-0000-4000-8000-000000000001',
      channel: 'stable',
      state: 'READY',
      logicalBytes: 1_024,
      logicalFiles: 2,
      packageMetadata: {
        author: 'YUCP Studio',
        description: 'Avatar tools.',
        packageName: 'Avatar Tools',
        version: '1.0.0',
      },
      bootstrapMedia: [
        {
          bucketName: 'metadata',
          byteSize: 9,
          contentType: 'image/png',
          kind: 'icon',
          localPath: 'Documentation~/YUCP/icon.png',
          objectKey: 'indexes/bootstrap-media/abc.png',
          providerVersion: 'exact-version-1',
          sha256: 'aa'.repeat(32),
        },
      ],
      createdAt,
    });
  });

  it('completes a legacy release pointer when the authoritative READY event is replayed', async () => {
    const t = makeTestConvex();
    const versionId = '00000000-0000-4000-8000-000000000099';
    const createdAt = Date.now();
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert('package_versions_ref', {
        channel: 'stable',
        createdAt,
        packageId: 'com.yucp.legacy-ready',
        state: 'READY',
        version: '1.0.0',
        versionId,
      })
    );

    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        createdAt: createdAt + 60_000,
        packageId: 'com.yucp.legacy-ready',
        version: '1.0.0',
        versionId,
      })
    );

    expect(await t.run(async (ctx) => ctx.db.get(rowId))).toMatchObject({
      activeContentDigest: '55'.repeat(32),
      logicalBytes: 1_024,
      releaseRoot: '44'.repeat(32),
      state: 'READY',
      versionId,
    });
  });

  it('supersedes the prior READY reference for the same package and channel', async () => {
    const t = makeTestConvex();

    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        packageId: 'com.yucp.avatar-tools',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000001',
        channel: 'stable',
        createdAt: 1_000,
      })
    );
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        packageId: 'com.yucp.avatar-tools',
        version: '1.1.0',
        versionId: '00000000-0000-4000-8000-000000000002',
        channel: 'stable',
        createdAt: 2_000,
      })
    );

    const rows = await t.run(
      async (ctx) =>
        await ctx.db
          .query('package_versions_ref')
          .withIndex('by_package_channel', (q) =>
            q.eq('packageId', 'com.yucp.avatar-tools').eq('channel', 'stable')
          )
          .collect()
    );

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.version === '1.0.0')?.state).toBe('SUPERSEDED');
    expect(rows.find((row) => row.version === '1.1.0')?.state).toBe('READY');
  });

  it('keeps current releases independent across package editions', async () => {
    const t = makeTestConvex();
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        createdAt: 1_000,
        editionId: 'personal',
        packageId: 'com.yucp.editions',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000011',
      })
    );
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        createdAt: 2_000,
        editionId: 'commercial',
        packageId: 'com.yucp.editions',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000012',
      })
    );

    const personal = await t.query(api.packageVersions.resolveDownloadableVersion, {
      actor: await createDownloadServiceActorBinding(),
      apiSecret: 'test-secret',
      editionId: 'personal',
      packageId: 'com.yucp.editions',
    });
    const commercial = await t.query(api.packageVersions.resolveDownloadableVersion, {
      actor: await createDownloadServiceActorBinding(),
      apiSecret: 'test-secret',
      editionId: 'commercial',
      packageId: 'com.yucp.editions',
    });
    const unscoped = await t.query(api.packageVersions.resolveDownloadableVersion, {
      actor: await createDownloadServiceActorBinding(),
      apiSecret: 'test-secret',
      packageId: 'com.yucp.editions',
    });

    expect(personal?.versionId).toBe('00000000-0000-4000-8000-000000000011');
    expect(commercial?.versionId).toBe('00000000-0000-4000-8000-000000000012');
    expect(unscoped).toBeNull();
  });

  it('fails closed when a package-scoped download omits its edition', async () => {
    const t = makeTestConvex();
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        createdAt: 1_000,
        editionId: 'commercial',
        packageId: 'com.yucp.edition-required',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000013',
      })
    );

    const resolved = await t.query(api.packageVersions.resolveDownloadableVersion, {
      actor: await createDownloadServiceActorBinding(),
      apiSecret: 'test-secret',
      packageId: 'com.yucp.edition-required',
    });

    expect(resolved).toBeNull();
  });

  it('rejects publication when the catalog product belongs to another active edition', async () => {
    const t = makeTestConvex();
    const packageId = 'com.yucp.edition-publication';
    const creatorAuthUserId = `creator-${packageId}`;
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'edition-publication-product',
        provider: 'manual',
        providerProductRef: 'edition-publication-product',
        displayName: 'Edition publication product',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
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
      await ctx.db.insert('package_editions', {
        catalogProductIds: [productId],
        catalogTierIds: [],
        createdAt: now,
        creatorAuthUserId,
        displayName: 'Commercial',
        editionId: 'commercial',
        packageId,
        priority: 0,
        status: 'active',
        updatedAt: now,
      });
      return productId;
    });

    await expect(
      t.mutation(
        api.packageVersions.upsertReadyVersion,
        await authenticatedReadyVersionArgs({
          catalogProductId,
          createdAt: Date.now(),
          editionId: 'standard',
          packageId,
          version: '1.0.0',
          versionId: '00000000-0000-4000-8000-000000000013',
        })
      )
    ).rejects.toThrow('Package edition does not contain the catalog product');
  });

  it('builds public bootstrap presentation only from values shared by all ready editions', async () => {
    const t = makeTestConvex();
    await seedActivePackageEditions(t, 'com.yucp.public-bootstrap', ['standard', 'commercial']);
    const sharedIcon = {
      bucketName: 'metadata',
      byteSize: 9,
      contentType: 'image/png' as const,
      kind: 'icon' as const,
      localPath: 'Documentation~/YUCP/icon.png',
      objectKey: 'indexes/bootstrap-media/shared.png',
      providerVersion: 'exact-shared-version',
      sha256: 'aa'.repeat(32),
    };
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        bootstrapMedia: [sharedIcon],
        createdAt: 1_000,
        editionId: 'standard',
        packageId: 'com.yucp.public-bootstrap',
        packageMetadata: {
          author: 'YUCP Studio',
          description: 'Standard edition description.',
          packageName: 'Public Bootstrap',
          tagline: 'Shared tagline',
          version: '1.0.0',
        },
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000021',
      })
    );
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        bootstrapMedia: [sharedIcon],
        createdAt: 2_000,
        editionId: 'commercial',
        packageId: 'com.yucp.public-bootstrap',
        packageMetadata: {
          author: 'YUCP Studio',
          description: 'Commercial edition description.',
          packageName: 'Public Bootstrap',
          tagline: 'Shared tagline',
          version: '9.0.0',
        },
        version: '9.0.0',
        versionId: '00000000-0000-4000-8000-000000000022',
      })
    );

    const presentation = await t.query(api.packageVersions.resolvePublicBootstrapPresentation, {
      actor: await createDownloadServiceActorBinding(),
      apiSecret: 'test-secret',
      packageId: 'com.yucp.public-bootstrap',
    });

    expect(presentation).toEqual({
      bootstrapMedia: [sharedIcon],
      createdAt: 2_000,
      packageMetadata: {
        author: 'YUCP Studio',
        packageName: 'Public Bootstrap',
        tagline: 'Shared tagline',
        version: '9.0.0',
      },
    });
  });

  it('preserves public bootstrap presentation from one ready edition', async () => {
    const t = makeTestConvex();
    await seedActivePackageEditions(t, 'com.yucp.public-bootstrap-single', ['standard']);
    const icon = {
      bucketName: 'metadata',
      byteSize: 9,
      contentType: 'image/png' as const,
      kind: 'icon' as const,
      localPath: 'Documentation~/YUCP/icon.png',
      objectKey: 'indexes/bootstrap-media/single.png',
      providerVersion: 'exact-single-version',
      sha256: 'ab'.repeat(32),
    };
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        bootstrapMedia: [icon],
        createdAt: 3_000,
        editionId: 'standard',
        packageId: 'com.yucp.public-bootstrap-single',
        packageMetadata: {
          author: 'YUCP Studio',
          description: 'One ready edition.',
          packageName: 'Single Edition',
          tagline: 'Complete presentation',
          version: '4.2.0',
        },
        version: '4.2.0',
        versionId: '00000000-0000-4000-8000-000000000025',
      })
    );

    const presentation = await t.query(api.packageVersions.resolvePublicBootstrapPresentation, {
      actor: await createDownloadServiceActorBinding(),
      apiSecret: 'test-secret',
      packageId: 'com.yucp.public-bootstrap-single',
    });

    expect(presentation).toEqual({
      bootstrapMedia: [icon],
      createdAt: 3_000,
      packageMetadata: {
        author: 'YUCP Studio',
        description: 'One ready edition.',
        packageName: 'Single Edition',
        tagline: 'Complete presentation',
        version: '4.2.0',
      },
    });
  });

  it('omits public bootstrap media when ready editions do not share the exact media set', async () => {
    const t = makeTestConvex();
    await seedActivePackageEditions(t, 'com.yucp.public-bootstrap-media', [
      'standard',
      'commercial',
    ]);
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        bootstrapMedia: [
          {
            bucketName: 'metadata',
            byteSize: 9,
            contentType: 'image/png',
            kind: 'icon',
            localPath: 'Documentation~/YUCP/icon.png',
            objectKey: 'indexes/bootstrap-media/standard.png',
            providerVersion: 'standard-version',
            sha256: 'aa'.repeat(32),
          },
        ],
        createdAt: 1_000,
        editionId: 'standard',
        packageId: 'com.yucp.public-bootstrap-media',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000023',
      })
    );
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        bootstrapMedia: [],
        createdAt: 2_000,
        editionId: 'commercial',
        packageId: 'com.yucp.public-bootstrap-media',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000024',
      })
    );

    const presentation = await t.query(api.packageVersions.resolvePublicBootstrapPresentation, {
      actor: await createDownloadServiceActorBinding(),
      apiSecret: 'test-secret',
      packageId: 'com.yucp.public-bootstrap-media',
    });

    expect(presentation).toEqual({
      bootstrapMedia: [],
      createdAt: 2_000,
      packageMetadata: {
        version: '1.0.0',
      },
    });
  });

  it('excludes archived editions from the public bootstrap presentation', async () => {
    const t = makeTestConvex();
    const packageId = 'com.yucp.public-bootstrap-active-only';
    const creatorAuthUserId = 'creator-public-bootstrap-active-only';
    const activeIcon = {
      bucketName: 'metadata',
      byteSize: 9,
      contentType: 'image/png' as const,
      kind: 'icon' as const,
      localPath: 'Documentation~/YUCP/active.png',
      objectKey: 'indexes/bootstrap-media/active.png',
      providerVersion: 'active-version',
      sha256: 'ac'.repeat(32),
    };
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${creatorAuthUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: creatorAuthUserId,
      });
      await ctx.db.insert('package_editions', {
        catalogProductIds: [],
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
      await ctx.db.insert('package_editions', {
        catalogProductIds: [],
        catalogTierIds: [],
        createdAt: now,
        creatorAuthUserId,
        displayName: 'Retired commercial',
        editionId: 'commercial',
        packageId,
        priority: 100,
        status: 'archived',
        updatedAt: now,
      });
    });
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        bootstrapMedia: [activeIcon],
        createdAt: 1_000,
        editionId: 'standard',
        packageId,
        packageMetadata: {
          author: 'YUCP Studio',
          packageName: 'Active package name',
          version: '1.0.0',
        },
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000026',
      })
    );
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        bootstrapMedia: [],
        createdAt: 9_000,
        editionId: 'commercial',
        packageId,
        packageMetadata: {
          author: 'Retired studio',
          packageName: 'Archived package name',
          version: '9.0.0',
        },
        version: '9.0.0',
        versionId: '00000000-0000-4000-8000-000000000027',
      })
    );

    const presentation = await t.query(api.packageVersions.resolvePublicBootstrapPresentation, {
      actor: await createDownloadServiceActorBinding(),
      apiSecret: 'test-secret',
      packageId,
    });

    expect(presentation).toEqual({
      bootstrapMedia: [activeIcon],
      createdAt: 1_000,
      packageMetadata: {
        author: 'YUCP Studio',
        packageName: 'Active package name',
        version: '1.0.0',
      },
    });
  });

  it('publishes no bootstrap when a package has no active explicit edition', async () => {
    const t = makeTestConvex();
    const packageId = 'com.yucp.public-bootstrap-no-active-edition';
    const creatorAuthUserId = 'creator-public-bootstrap-no-active-edition';
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${creatorAuthUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: creatorAuthUserId,
      });
      await ctx.db.insert('package_editions', {
        catalogProductIds: [],
        catalogTierIds: [],
        createdAt: now,
        creatorAuthUserId,
        displayName: 'Retired edition',
        editionId: 'commercial',
        packageId,
        priority: 100,
        status: 'archived',
        updatedAt: now,
      });
    });
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        createdAt: 1_000,
        editionId: 'commercial',
        packageId,
        packageMetadata: {
          author: 'Retired studio',
          packageName: 'Retired package',
          version: '1.0.0',
        },
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000028',
      })
    );

    const presentation = await t.query(api.packageVersions.resolvePublicBootstrapPresentation, {
      actor: await createDownloadServiceActorBinding(),
      apiSecret: 'test-secret',
      packageId,
    });

    expect(presentation).toBeNull();
  });

  it('does not duplicate an at-least-once READY event for the same versionId', async () => {
    const t = makeTestConvex();
    const input = {
      packageId: 'com.yucp.avatar-tools',
      version: '1.0.0',
      versionId: '00000000-0000-4000-8000-000000000001',
      channel: 'beta',
      createdAt: 1_000,
    } as const;

    const firstId = await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs(input)
    );
    const secondId = await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs(input)
    );
    const rows = await t.run(
      async (ctx) =>
        await ctx.db
          .query('package_versions_ref')
          .withIndex('by_version_id', (q) => q.eq('versionId', input.versionId))
          .collect()
    );

    expect(secondId).toBe(firstId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('READY');
  });

  it('rejects an idempotent version event with changed immutable release data', async () => {
    const t = makeTestConvex();
    const input = {
      channel: 'beta',
      createdAt: 1_000,
      editionId: 'commercial',
      packageId: 'com.yucp.immutable-version',
      version: '1.0.0',
      versionId: '00000000-0000-4000-8000-000000000021',
    } as const;
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs(input)
    );

    await expect(
      t.mutation(
        api.packageVersions.upsertReadyVersion,
        await authenticatedReadyVersionArgs({
          ...input,
          channel: 'stable',
          manifestSha256: '99'.repeat(32),
          releaseRoot: 'aa'.repeat(32),
        })
      )
    ).rejects.toThrow('Package version immutable payload conflict');
  });

  it('publishes new immutable release data when a deleted version is cleanly re-uploaded', async () => {
    const t = makeTestConvex();
    const actor = await createDownloadServiceActorBinding();
    const input = {
      channel: 'stable',
      createdAt: 1_000,
      editionId: 'standard',
      packageId: 'com.yucp.deleted-reupload',
      version: '2.0.0',
      versionId: '00000000-0000-4000-8000-000000000022',
    } as const;
    const firstId = await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs(input)
    );
    await t.mutation(api.packageVersions.markVersionDeleted, {
      apiSecret: 'test-secret',
      actor,
      versionId: input.versionId,
      deletedAt: 2_000,
    });

    const secondId = await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        ...input,
        activeContentDigest: 'aa'.repeat(32),
        bindingRoot: 'bb'.repeat(32),
        commonRoot: 'cc'.repeat(32),
        createdAt: 3_000,
        logicalBytes: 2_048,
        manifestSha256: 'dd'.repeat(32),
        protectedSourceRoot: 'ee'.repeat(32),
        releaseRoot: 'ff'.repeat(32),
      })
    );
    const resolved = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor,
      editionId: input.editionId,
      packageId: input.packageId,
    });

    expect(secondId).toBe(firstId);
    expect(resolved).toMatchObject({
      activeContentDigest: 'aa'.repeat(32),
      bindingRoot: 'bb'.repeat(32),
      commonRoot: 'cc'.repeat(32),
      createdAt: 3_000,
      logicalBytes: 2_048,
      manifestSha256: 'dd'.repeat(32),
      protectedSourceRoot: 'ee'.repeat(32),
      releaseRoot: 'ff'.repeat(32),
      state: 'READY',
      versionId: input.versionId,
    });
    expect(resolved?.deletedAt).toBeUndefined();
  });

  it('does not resurrect a deleted version from a stale READY event', async () => {
    const t = makeTestConvex();
    const actor = await createDownloadServiceActorBinding();
    const input = {
      createdAt: 1_000,
      editionId: 'standard',
      packageId: 'com.yucp.stale-reupload',
      version: '2.0.0',
      versionId: '00000000-0000-4000-8000-000000000023',
    } as const;
    const versionRefId = await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs(input)
    );
    await t.mutation(api.packageVersions.markVersionDeleted, {
      apiSecret: 'test-secret',
      actor,
      versionId: input.versionId,
      deletedAt: 3_000,
    });

    await expect(
      t.mutation(
        api.packageVersions.upsertReadyVersion,
        await authenticatedReadyVersionArgs({
          ...input,
          createdAt: 2_000,
          manifestSha256: '99'.repeat(32),
          releaseRoot: 'aa'.repeat(32),
        })
      )
    ).resolves.toBe(versionRefId);
    const resolved = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor,
      editionId: input.editionId,
      packageId: input.packageId,
    });
    const stored = await t.run(async (ctx) => await ctx.db.get(versionRefId));

    expect(resolved).toBeNull();
    expect(stored).toMatchObject({
      deletedAt: 3_000,
      manifestSha256: '33'.repeat(32),
      releaseRoot: '44'.repeat(32),
      state: 'DELETED',
    });
  });

  it('rejects a different durable identity for an existing logical package version', async () => {
    const t = makeTestConvex();
    const logicalVersion = {
      createdAt: 1_000,
      editionId: 'commercial',
      packageId: 'com.yucp.logical-identity',
      version: '1.0.0',
    } as const;
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        ...logicalVersion,
        versionId: '00000000-0000-4000-8000-000000000031',
      })
    );

    await expect(
      t.mutation(
        api.packageVersions.upsertReadyVersion,
        await authenticatedReadyVersionArgs({
          ...logicalVersion,
          versionId: '00000000-0000-4000-8000-000000000032',
        })
      )
    ).rejects.toThrow('Package version logical identity conflict');
    const rows = await t.run(
      async (ctx) =>
        await ctx.db
          .query('package_versions_ref')
          .withIndex('by_package_channel', (q) =>
            q.eq('packageId', logicalVersion.packageId).eq('channel', 'stable')
          )
          .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.versionId).toBe('00000000-0000-4000-8000-000000000031');
  });

  it('keeps a newer READY release downloadable after an older event arrives out of order', async () => {
    const t = makeTestConvex();
    const packageId = 'com.yucp.out-of-order';

    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        packageId,
        version: '2.0.0',
        versionId: '00000000-0000-4000-8000-000000000002',
        createdAt: 2_000,
      })
    );
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        packageId,
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000001',
        createdAt: 1_000,
      })
    );

    const resolved = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor: await createDownloadServiceActorBinding(),
      editionId: 'standard',
      packageId,
    });
    const rows = await t.run(async (ctx) => await ctx.db.query('package_versions_ref').collect());

    expect(resolved?.versionId).toBe('00000000-0000-4000-8000-000000000002');
    expect(rows.find((row) => row.version === '2.0.0')?.state).toBe('READY');
    expect(rows.find((row) => row.version === '1.0.0')?.state).toBe('SUPERSEDED');
  });

  it('keeps deleted installed identity while rejecting deleted downloads', async () => {
    const t = makeTestConvex();
    const packageId = 'com.yucp.rollback';
    const baseVersionId = '00000000-0000-4000-8000-000000000001';
    const updateVersionId = '00000000-0000-4000-8000-000000000002';
    const baseReleaseRoot = '01'.repeat(32);
    const updateReleaseRoot = '02'.repeat(32);

    for (const [index, versionId] of [baseVersionId, updateVersionId].entries()) {
      await t.mutation(
        api.packageVersions.upsertReadyVersion,
        await authenticatedReadyVersionArgs({
          packageId,
          version: `1.${index}.0`,
          versionId,
          releaseRoot: index === 0 ? baseReleaseRoot : updateReleaseRoot,
          createdAt: 1_000 + index,
        })
      );
    }

    const actor = await createDownloadServiceActorBinding();
    const retained = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor,
      editionId: 'standard',
      packageId,
      releaseRoot: baseReleaseRoot,
    });
    expect(retained).toMatchObject({
      packageId,
      state: 'SUPERSEDED',
      versionId: baseVersionId,
    });

    await t.mutation(api.packageVersions.markVersionDeleted, {
      apiSecret: 'test-secret',
      actor: await createDownloadServiceActorBinding(),
      versionId: baseVersionId,
      deletedAt: 3_000,
    });
    const deleted = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor,
      editionId: 'standard',
      packageId,
      releaseRoot: baseReleaseRoot,
    });
    expect(deleted).toBeNull();
    const installed = await t.query(api.packageVersions.resolveInstalledVersion, {
      apiSecret: 'test-secret',
      actor,
      editionId: 'standard',
      packageId,
      releaseRoot: baseReleaseRoot,
    });
    expect(installed).toMatchObject({
      packageId,
      state: 'DELETED',
      versionId: baseVersionId,
    });
  });

  it('accepts a tombstone for a version that never reached the reference catalog', async () => {
    const t = makeTestConvex();
    const actor = await createDownloadServiceActorBinding();

    await expect(
      t.mutation(api.packageVersions.markVersionDeleted, {
        apiSecret: 'test-secret',
        actor,
        versionId: '00000000-0000-4000-8000-000000000099',
        deletedAt: 3_000,
      })
    ).resolves.toBeNull();
    expect(
      await t.run(async (ctx) => await ctx.db.query('package_versions_ref').collect())
    ).toEqual([]);
  });

  it('deletes a base version without breaking the current update', async () => {
    const t = makeTestConvex();
    const packageId = 'com.yucp.delete-base';
    const baseVersionId = '00000000-0000-4000-8000-000000000001';
    const updateVersionId = '00000000-0000-4000-8000-000000000002';

    for (const [index, versionId] of [baseVersionId, updateVersionId].entries()) {
      await t.mutation(
        api.packageVersions.upsertReadyVersion,
        await authenticatedReadyVersionArgs({
          packageId,
          version: `1.${index}.0`,
          versionId,
          createdAt: 1_000 + index,
        })
      );
    }
    await t.mutation(api.packageVersions.markVersionDeleted, {
      apiSecret: 'test-secret',
      actor: await createDownloadServiceActorBinding(),
      versionId: baseVersionId,
      deletedAt: 3_000,
    });

    const resolved = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor: await createDownloadServiceActorBinding(),
      editionId: 'standard',
      packageId,
    });
    const rows = await t.run(async (ctx) => await ctx.db.query('package_versions_ref').collect());
    expect(resolved?.versionId).toBe(updateVersionId);
    expect(rows.find((row) => row.versionId === baseVersionId)).toMatchObject({
      state: 'DELETED',
      deletedAt: 3_000,
    });
    expect(rows.find((row) => row.versionId === updateVersionId)?.state).toBe('READY');
  });

  it('removes all deleted versions from download resolution and restores no deleted base', async () => {
    const t = makeTestConvex();
    const packageId = 'com.yucp.delete-all';
    const versionIds = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];

    for (const [index, versionId] of versionIds.entries()) {
      await t.mutation(
        api.packageVersions.upsertReadyVersion,
        await authenticatedReadyVersionArgs({
          packageId,
          version: `1.${index}.0`,
          versionId,
          createdAt: 1_000 + index,
        })
      );
    }
    for (const [index, versionId] of versionIds.entries()) {
      await t.mutation(api.packageVersions.markVersionDeleted, {
        apiSecret: 'test-secret',
        actor: await createDownloadServiceActorBinding(),
        versionId,
        deletedAt: 2_000 + index,
      });
    }

    const resolved = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor: await createDownloadServiceActorBinding(),
      editionId: 'standard',
      packageId,
    });
    const rows = await t.run(async (ctx) => await ctx.db.query('package_versions_ref').collect());
    expect(resolved).toBeNull();
    expect(rows.every((row) => row.state === 'DELETED')).toBe(true);
  });

  it('resolves the latest READY reference by product or package and returns null when absent', async () => {
    const t = makeTestConvex();
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId: 'creator-package-versions',
        productId: 'avatar-tools-product',
        provider: 'gumroad',
        providerProductRef: 'gumroad-avatar-tools',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId: 'com.yucp.avatar-tools',
        publisherId: 'creator:creator-package-versions',
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: 'creator-package-versions',
      });
      await ctx.db.insert('package_editions', {
        catalogProductIds: [productId],
        catalogTierIds: [],
        createdAt: now,
        creatorAuthUserId: 'creator-package-versions',
        displayName: 'Standard',
        editionId: 'standard',
        packageId: 'com.yucp.avatar-tools',
        priority: 0,
        status: 'active',
        updatedAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId: productId,
        creatorAuthUserId: 'creator-package-versions',
        packageId: 'com.yucp.avatar-tools',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return productId;
    });

    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        packageId: 'com.yucp.avatar-tools',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000001',
        catalogProductId,
        createdAt: 1_000,
      })
    );
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        packageId: 'com.yucp.avatar-tools',
        version: '1.1.0',
        versionId: '00000000-0000-4000-8000-000000000002',
        catalogProductId,
        createdAt: 2_000,
      })
    );

    const actor = await createDownloadServiceActorBinding();
    const byProduct = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor,
      catalogProductId,
    });
    const byPackage = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor,
      editionId: 'standard',
      packageId: 'com.yucp.avatar-tools',
    });
    const absent = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor,
      packageId: 'com.yucp.missing',
    });

    expect(byProduct?.versionId).toBe('00000000-0000-4000-8000-000000000002');
    expect(byProduct?.state).toBe('READY');
    expect(byPackage?.versionId).toBe('00000000-0000-4000-8000-000000000002');
    expect(absent).toBeNull();
  });

  it('resolves an exact root only inside the bound package edition and channel', async () => {
    const t = makeTestConvex();
    const releaseRoot = 'ab'.repeat(32);
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        channel: 'stable',
        createdAt: 1_000,
        editionId: 'standard',
        packageId: 'com.yucp.shared-root-a',
        releaseRoot,
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000041',
      })
    );
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        channel: 'stable',
        createdAt: 2_000,
        editionId: 'commercial',
        packageId: 'com.yucp.shared-root-b',
        releaseRoot,
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000042',
      })
    );
    const actor = await createDownloadServiceActorBinding();

    const exact = await t.query(api.packageVersions.resolveDownloadableVersion, {
      actor,
      apiSecret: 'test-secret',
      channel: 'stable',
      editionId: 'commercial',
      packageId: 'com.yucp.shared-root-b',
      releaseRoot,
    });
    const unscoped = await t.query(api.packageVersions.resolveDownloadableVersion, {
      actor,
      apiSecret: 'test-secret',
      releaseRoot,
    });
    const wrongChannel = await t.query(api.packageVersions.resolveDownloadableVersion, {
      actor,
      apiSecret: 'test-secret',
      channel: 'beta',
      editionId: 'commercial',
      packageId: 'com.yucp.shared-root-b',
      releaseRoot,
    });

    expect(exact?.versionId).toBe('00000000-0000-4000-8000-000000000042');
    expect(unscoped).toBeNull();
    expect(wrongChannel).toBeNull();
  });

  it('fails closed when a catalog product belongs to multiple active editions', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-ambiguous-product-edition';
    const packageId = 'com.yucp.ambiguous-product-edition';
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'ambiguous-product-edition',
        provider: 'manual',
        providerProductRef: 'ambiguous-product-edition',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
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
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId: productId,
        creatorAuthUserId,
        packageId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      for (const [priority, editionId] of ['standard', 'commercial'].entries()) {
        await ctx.db.insert('package_editions', {
          catalogProductIds: [productId],
          catalogTierIds: [],
          createdAt: now,
          creatorAuthUserId,
          displayName: editionId,
          editionId,
          packageId,
          priority,
          status: 'active',
          updatedAt: now,
        });
      }
      return productId;
    });
    const releaseRoot = 'cd'.repeat(32);
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        catalogProductId,
        createdAt: 1_000,
        editionId: 'standard',
        packageId,
        releaseRoot,
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000043',
      })
    );

    const resolved = await t.query(api.packageVersions.resolveDownloadableVersion, {
      actor: await createDownloadServiceActorBinding(),
      apiSecret: 'test-secret',
      catalogProductId,
      releaseRoot,
    });

    expect(resolved).toBeNull();
  });
});
