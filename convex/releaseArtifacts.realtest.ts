import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(input));
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

describe('releaseArtifacts.getActiveArtifact', () => {
  it('returns an artifact shape that satisfies its validator', async () => {
    const t = makeTestConvex();
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' })
      );
    });

    await t.mutation(internal.releaseArtifacts.publishArtifact, {
      artifactKey: 'coupling-runtime',
      channel: 'stable',
      platform: 'win-x64',
      version: '1.0.0',
      metadataVersion: 1,
      storageId,
      contentType: 'application/octet-stream',
      deliveryName: 'yucp-coupling.dll',
      envelopeCipher: 'aes-256-gcm',
      envelopeIvBase64: 'ZmFrZS1pdi1iYXNlNjQ=',
      ciphertextSha256: 'a'.repeat(64),
      ciphertextSize: 3,
      plaintextSha256: 'b'.repeat(64),
      plaintextSize: 3,
    });

    const artifact = await t.query(internal.releaseArtifacts.getActiveArtifact, {
      artifactKey: 'coupling-runtime',
      channel: 'stable',
      platform: 'win-x64',
    });

    expect(artifact).toMatchObject({
      artifactKey: 'coupling-runtime',
      channel: 'stable',
      platform: 'win-x64',
      version: '1.0.0',
      deliveryName: 'yucp-coupling.dll',
    });
    expect(artifact).not.toHaveProperty('_id');
    expect(artifact).not.toHaveProperty('_creationTime');
  });

  it('materializes raw uploaded releases into tracked server deliverables', async () => {
    const t = makeTestConvex();
    const uploadBytes = zipSync(
      {
        'Packages/com.yucp.materialized/package.json': [
          new TextEncoder().encode('{"name":"com.yucp.materialized"}'),
          { mtime: new Date() },
        ],
        'Packages/com.yucp.materialized/README.md': [
          new TextEncoder().encode('hello'),
          { mtime: new Date() },
        ],
      },
      { level: 9 }
    );
    const uploadSha256 = await sha256Hex(uploadBytes);
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(uploadBytes)], { type: 'application/zip' })
      );
    });

    const { deliveryPackageId, deliveryPackageReleaseId } = await t.run(async (ctx) => {
      const now = Date.now();
      const deliveryPackageId = await ctx.db.insert('delivery_packages', {
        authUserId: 'auth-user-1',
        packageId: 'com.yucp.materialized.release',
        packageName: 'Materialized Release',
        displayName: 'Materialized Release',
        status: 'active',
        repositoryVisibility: 'listed',
        defaultChannel: 'stable',
        createdAt: now,
        updatedAt: now,
      });
      const deliveryPackageReleaseId = await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-1',
        deliveryPackageId,
        packageId: 'com.yucp.materialized.release',
        version: '1.0.0',
        channel: 'stable',
        releaseStatus: 'published',
        repositoryVisibility: 'listed',
        zipSha256: uploadSha256,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
      return { deliveryPackageId, deliveryPackageReleaseId };
    });

    expect(deliveryPackageId).toBeTruthy();

    const materialized = await t.action(
      internal.releaseArtifacts.materializeUploadedReleaseDeliverable,
      {
        deliveryPackageReleaseId,
        storageId,
        contentType: 'application/zip',
        deliveryName: 'materialized.zip',
        sha256: uploadSha256,
      }
    );

    expect(materialized).toMatchObject({
      deliveryArtifactMode: 'server_materialized',
      rawArtifactId: expect.any(String),
      deliverableArtifactId: expect.any(String),
      materializationStrategy: 'normalized_repack',
      deliverableSha256: expect.any(String),
    });

    const rawArtifact = await t.query(internal.releaseArtifacts.getDeliveryArtifactById, {
      artifactId: materialized.rawArtifactId,
    });
    const deliverableArtifact = await t.query(internal.releaseArtifacts.getDeliveryArtifactById, {
      artifactId: materialized.deliverableArtifactId,
    });

    expect(rawArtifact).toMatchObject({
      artifactRole: 'raw_upload',
      ownership: 'creator_upload',
      deliveryPackageReleaseId,
      storageId,
      contentType: 'application/zip',
      deliveryName: 'materialized.zip',
      sha256: uploadSha256,
      status: 'active',
    });
    expect(deliverableArtifact).toMatchObject({
      artifactRole: 'server_deliverable',
      ownership: 'server_materialized',
      deliveryPackageReleaseId,
      sourceArtifactId: materialized.rawArtifactId,
      contentType: 'application/zip',
      deliveryName: 'materialized.zip',
      sha256: materialized.deliverableSha256,
      status: 'active',
      materializationStrategy: 'normalized_repack',
    });
    expect(deliverableArtifact?.storageId).not.toBe(storageId);
    expect(deliverableArtifact?.sha256).not.toBe(uploadSha256);

    const release = await t.run(async (ctx) => {
      return await ctx.db.get(deliveryPackageReleaseId);
    });
    expect(release?.zipSha256).toBe(materialized.deliverableSha256);
  });
});
