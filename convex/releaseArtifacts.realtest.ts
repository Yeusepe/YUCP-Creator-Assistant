import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

async function seedDeliveryPackageRelease(
  t: ReturnType<typeof makeTestConvex>,
  packageId = 'com.yucp.backstage.cdngine-only'
): Promise<Id<'delivery_package_releases'>> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const deliveryPackageId = await ctx.db.insert('delivery_packages', {
      authUserId: 'auth-user-1',
      packageId,
      packageName: 'CDNgine Only Package',
      displayName: 'CDNgine Only Package',
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

describe('releaseArtifacts CDNgine storage contract', () => {
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
      'Backstage delivery release artifacts must store CDNgine references, not Convex storage.'
    );
  });

  it('stores source and delivery coordinates without Convex storage URLs', async () => {
    const t = makeTestConvex();
    const deliveryPackageReleaseId = await seedDeliveryPackageRelease(t);

    const rawArtifactId = await t.mutation(internal.releaseArtifacts.publishDeliveryArtifact, {
      deliveryPackageReleaseId,
      artifactRole: 'raw_upload',
      ownership: 'creator_upload',
      contentType: 'application/octet-stream',
      deliveryName: 'Song Thing_1.0.0.unitypackage',
      sha256: '1'.repeat(64),
      byteSize: 1234,
      cdngineSource: {
        assetId: 'ast_source_1',
        versionId: 'ver_source_1',
        serviceNamespaceId: 'yucp-backstage',
        assetOwner: 'creator:auth-user-1',
        sha256: '1'.repeat(64),
        byteSize: 1234,
        uploadedAt: 1_700_000_000_000,
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
        deliveryName: 'vrc-get-com.yucp.backstage.cdngine-only-1.0.0.zip',
        sha256: '2'.repeat(64),
        byteSize: 456,
        cdngineDelivery: {
          assetId: 'ast_delivery_1',
          versionId: 'ver_delivery_1',
          deliveryScopeId: 'paid-downloads',
          variant: 'preserve-original',
          serviceNamespaceId: 'yucp-backstage',
          assetOwner: 'creator:auth-user-1',
          sha256: '2'.repeat(64),
          byteSize: 456,
          uploadedAt: 1_700_000_000_000,
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
      cdngineSource: {
        assetId: 'ast_source_1',
        versionId: 'ver_source_1',
      },
    });
    expect(rawArtifact?.storageId).toBeUndefined();
    expect(deliverableArtifact).toMatchObject({
      artifactRole: 'server_deliverable',
      cdngineDelivery: {
        assetId: 'ast_delivery_1',
        versionId: 'ver_delivery_1',
      },
    });
    expect(deliverableArtifact?.storageId).toBeUndefined();
  });
});
