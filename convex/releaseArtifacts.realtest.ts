import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

async function seedDeliveryPackageRelease(
  t: ReturnType<typeof makeTestConvex>,
  packageId = 'com.yucp.backstage.lore-only'
): Promise<Id<'delivery_package_releases'>> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const deliveryPackageId = await ctx.db.insert('delivery_packages', {
      authUserId: 'auth-user-1',
      packageId,
      packageName: 'Lore Only Package',
      displayName: 'Lore Only Package',
      status: 'active',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.insert('delivery_package_releases', {
      authUserId: 'auth-user-1',
      deliveryPackageId,
      packageId,
      version: '1.0.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      zipSha256: '2'.repeat(64),
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('releaseArtifacts Lore storage contract', () => {
  it('rejects Convex storage ids for Backstage release artifacts', async () => {
    const t = makeTestConvex();
    const deliveryPackageReleaseId = await seedDeliveryPackageRelease(t);
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' })
      );
    });

    await expect(
      t.mutation(internal.releaseArtifacts.publishDeliveryArtifact, {
        deliveryPackageReleaseId,
        artifactRole: 'raw_upload',
        ownership: 'creator_upload',
        storageId,
        contentType: 'application/zip',
        deliveryName: 'source.zip',
        sha256: '1'.repeat(64),
        byteSize: 3,
      })
    ).rejects.toThrow(
      'Backstage delivery release artifacts must store Lore references, not Convex storage.'
    );
  });

  it('stores Lore source and delivery coordinates without Convex storage URLs', async () => {
    const t = makeTestConvex();
    const deliveryPackageReleaseId = await seedDeliveryPackageRelease(t);
    const uploadedAt = new Date(1_700_000_000_000).toISOString();

    const rawArtifactId = await t.mutation(internal.releaseArtifacts.publishDeliveryArtifact, {
      deliveryPackageReleaseId,
      artifactRole: 'raw_upload',
      ownership: 'creator_upload',
      contentType: 'application/octet-stream',
      deliveryName: 'Song Thing_1.0.0.unitypackage',
      sha256: '1'.repeat(64),
      byteSize: 1234,
      loreSource: {
        repositoryId: '1'.repeat(32),
        address: `${'1'.repeat(64)}-${'a'.repeat(32)}`,
        sha256: '1'.repeat(64),
        byteSize: 1234,
        uploadedAt,
        tenantId: 'auth-user-1',
      },
    });
    const deliverableArtifactId = await t.mutation(
      internal.releaseArtifacts.publishDeliveryArtifact,
      {
        deliveryPackageReleaseId,
        artifactRole: 'server_deliverable',
        ownership: 'server_materialized',
        materializationStrategy: 'normalized_repack',
        sourceArtifactId: rawArtifactId,
        contentType: 'application/zip',
        deliveryName: 'vrc-get-com.yucp.backstage.lore-only-1.0.0.zip',
        sha256: '2'.repeat(64),
        byteSize: 456,
        loreDelivery: {
          repositoryId: '1'.repeat(32),
          address: `${'2'.repeat(64)}-${'b'.repeat(32)}`,
          sha256: '2'.repeat(64),
          byteSize: 456,
          uploadedAt,
          tenantId: 'auth-user-1',
        },
      }
    );

    const [rawArtifact, deliverableArtifact] = await Promise.all([
      t.query(internal.releaseArtifacts.getDeliveryArtifactById, { artifactId: rawArtifactId }),
      t.query(internal.releaseArtifacts.getDeliveryArtifactById, {
        artifactId: deliverableArtifactId,
      }),
    ]);

    expect(rawArtifact).toMatchObject({
      artifactRole: 'raw_upload',
      loreSource: {
        repositoryId: '1'.repeat(32),
        address: `${'1'.repeat(64)}-${'a'.repeat(32)}`,
      },
    });
    expect(rawArtifact?.storageId).toBeUndefined();
    expect(deliverableArtifact).toMatchObject({
      artifactRole: 'server_deliverable',
      loreDelivery: {
        repositoryId: '1'.repeat(32),
        address: `${'2'.repeat(64)}-${'b'.repeat(32)}`,
      },
    });
    expect(deliverableArtifact?.storageId).toBeUndefined();
  });
});
