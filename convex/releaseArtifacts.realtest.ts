import { gzipSync, strToU8, unzipSync, zipSync } from 'fflate';
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

function writeAscii(target: Uint8Array, offset: number, length: number, value: string) {
  const encoded = new TextEncoder().encode(value);
  target.set(encoded.subarray(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeAscii(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function writeChecksum(target: Uint8Array, value: number) {
  const encoded = value.toString(8).padStart(6, '0');
  writeAscii(target, 148, 6, encoded);
  target[154] = 0;
  target[155] = 0x20;
}

function buildTarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 123);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(header, 257, 6, 'ustar');
  writeAscii(header, 263, 2, '00');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeChecksum(header, checksum);
  return header;
}

function buildUnitypackage(entries: Array<{ path: string; content: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = buildTarHeader(entry.path, entry.content.byteLength);
    blocks.push(header);
    blocks.push(entry.content);
    const remainder = entry.content.byteLength % 512;
    if (remainder !== 0) {
      blocks.push(new Uint8Array(512 - remainder));
    }
  }
  blocks.push(new Uint8Array(1024));

  const totalSize = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const tarBytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const block of blocks) {
    tarBytes.set(block, offset);
    offset += block.byteLength;
  }
  return gzipSync(tarBytes, { level: 9, mtime: 123 });
}

function buildLegacyUnitypackageWrapperZip(input: {
  packageId: string;
  version: string;
  displayName: string;
  payloadBytes: Uint8Array;
}): Uint8Array {
  const legacyInstallerSource = [
    'using System;',
    'using System.IO;',
    'using UnityEditor;',
    'using UnityEditor.PackageManager;',
    'namespace Yucp.Backstage.Generated',
    '{',
    '    [Serializable]',
    '    internal sealed class BackstagePayloadManifest',
    '    {',
    '        public string packageId = "";',
    '        public string version = "";',
    '        public string displayName = "";',
    '        public string payloadFileName = "";',
    '        public string payloadSha256 = "";',
    '    }',
    '',
    '    [InitializeOnLoad]',
    '    internal static class YucpBackstageEmbeddedUnitypackageInstaller_Legacy',
    '    {',
    '        private const string ManifestRelativePath = "BackstagePayload~/backstage-payload.json";',
    '        private const string PayloadRelativePath = "BackstagePayload~/payload.unitypackage";',
    '',
    '        static YucpBackstageEmbeddedUnitypackageInstaller_Legacy()',
    '        {',
    '            EditorApplication.delayCall += MaybeImportPayload;',
    '        }',
    '',
    '        private static void MaybeImportPayload()',
    '        {',
    '            var packageInfo = PackageInfo.FindForAssembly(typeof(YucpBackstageEmbeddedUnitypackageInstaller_Legacy).Assembly);',
    '            var manifestPath = Path.Combine(packageInfo.resolvedPath, ManifestRelativePath);',
    '            var payloadPath = Path.Combine(packageInfo.resolvedPath, PayloadRelativePath);',
    '            var manifest = JsonUtility.FromJson<BackstagePayloadManifest>(File.ReadAllText(manifestPath));',
    '            AssetDatabase.ImportPackage(payloadPath, false);',
    '            Debug.Log("[YUCP Backstage] Imported " + manifest.displayName + " from Backstage Repos.");',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  const payloadManifest = JSON.stringify({
    packageId: input.packageId,
    version: input.version,
    displayName: input.displayName,
    payloadFileName: 'payload.unitypackage',
    payloadSha256: 'legacy-sha-placeholder',
  });
  const asmdef = JSON.stringify({
    name: 'Yucp.Backstage.PackageInstaller',
    includePlatforms: ['Editor'],
  });

  return zipSync(
    {
      'package.json': strToU8(
        JSON.stringify({
          name: input.packageId,
          version: input.version,
          displayName: input.displayName,
          unity: '2022.3',
        })
      ),
      'Editor/Yucp.Backstage.PackageInstaller.asmdef': strToU8(asmdef),
      'Editor/YucpBackstageEmbeddedUnitypackageInstaller.cs': strToU8(legacyInstallerSource),
      'BackstagePayload~/payload.unitypackage': input.payloadBytes,
      'BackstagePayload~/backstage-payload.json': strToU8(payloadManifest),
    },
    { level: 9 }
  );
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

  it('wraps unitypackage uploads in a compile-safe backstage installer zip', async () => {
    const t = makeTestConvex();
    const uploadBytes = buildUnitypackage([
      { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
      { path: 'asset-guid/pathname', content: strToU8('Assets/JAMMR/readme.txt') },
    ]);
    const uploadSha256 = await sha256Hex(uploadBytes);
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(uploadBytes)], { type: 'application/octet-stream' })
      );
    });

    const { deliveryPackageReleaseId } = await t.run(async (ctx) => {
      const now = Date.now();
      const deliveryPackageId = await ctx.db.insert('delivery_packages', {
        authUserId: 'auth-user-1',
        packageId: 'com.yucp.jammr',
        packageName:
          'JAMMR | NEW UPDATE: Song recognition | Create/Join Spotify® Jams from within VRChat | VRCFury Ready',
        displayName:
          'JAMMR | NEW UPDATE: Song recognition | Create/Join Spotify® Jams from within VRChat | VRCFury Ready',
        status: 'active',
        repositoryVisibility: 'listed',
        defaultChannel: 'stable',
        createdAt: now,
        updatedAt: now,
      });
      const deliveryPackageReleaseId = await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-1',
        deliveryPackageId,
        packageId: 'com.yucp.jammr',
        version: '2.1.5',
        channel: 'stable',
        releaseStatus: 'published',
        repositoryVisibility: 'listed',
        zipSha256: uploadSha256,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
      return { deliveryPackageReleaseId };
    });

    const materialized = await t.action(
      internal.releaseArtifacts.materializeUploadedReleaseDeliverable,
      {
        deliveryPackageReleaseId,
        storageId,
        contentType: 'application/octet-stream',
        deliveryName: 'JAMMR_2.1.5.unitypackage',
        sha256: uploadSha256,
      }
    );

    const deliverableArtifact = await t.query(internal.releaseArtifacts.getDeliveryArtifactById, {
      artifactId: materialized.deliverableArtifactId,
    });
    expect(deliverableArtifact).toMatchObject({
      contentType: 'application/zip',
      deliveryName: 'vrc-get-com.yucp.jammr-2.1.5.zip',
      materializationStrategy: 'normalized_repack',
    });

    const deliverableBytes = await t.run(async (ctx) => {
      const blob = deliverableArtifact ? await ctx.storage.get(deliverableArtifact.storageId) : null;
      return blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : null;
    });
    expect(deliverableBytes).not.toBeNull();

    const archive = unzipSync(new Uint8Array(deliverableBytes!));
    expect(Object.keys(archive).sort()).toEqual([
      'BackstagePayload~/backstage-payload.json',
      'BackstagePayload~/payload.unitypackage',
      'Editor/Yucp.Backstage.PackageInstaller.asmdef',
      'Editor/YucpBackstageEmbeddedUnitypackageInstaller.cs',
      'package.json',
    ]);

    const installerSource = new TextDecoder().decode(
      archive['Editor/YucpBackstageEmbeddedUnitypackageInstaller.cs']
    );
    expect(installerSource).toContain('using UnityEngine;');
    expect(installerSource).toContain('UnityEditor.PackageManager.PackageInfo.FindForAssembly');
    expect(installerSource).not.toContain('using UnityEditor.PackageManager;');
  });

  it('repairs stale unitypackage deliverables and updates the published digest', async () => {
    const t = makeTestConvex();
    const uploadBytes = buildUnitypackage([
      { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
      { path: 'asset-guid/pathname', content: strToU8('Assets/JAMMR/readme.txt') },
    ]);
    const uploadSha256 = await sha256Hex(uploadBytes);
    const staleZipBytes = buildLegacyUnitypackageWrapperZip({
      packageId: 'com.yucp.jammr',
      version: '2.1.5',
      displayName: 'JAMMR',
      payloadBytes: uploadBytes,
    });
    const staleZipSha256 = await sha256Hex(staleZipBytes);
    const { deliveryPackageReleaseId, staleStorageId } = await t.run(async (ctx) => {
      const now = Date.now();
      const staleStorageId = await ctx.storage.store(
        new Blob([toArrayBuffer(staleZipBytes)], { type: 'application/zip' })
      );
      const deliveryPackageId = await ctx.db.insert('delivery_packages', {
        authUserId: 'auth-user-1',
        packageId: 'com.yucp.jammr',
        packageName: 'JAMMR',
        displayName: 'JAMMR',
        status: 'active',
        repositoryVisibility: 'listed',
        defaultChannel: 'stable',
        createdAt: now,
        updatedAt: now,
      });
      const deliveryPackageReleaseId = await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-1',
        deliveryPackageId,
        packageId: 'com.yucp.jammr',
        version: '2.1.5',
        channel: 'stable',
        releaseStatus: 'published',
        repositoryVisibility: 'listed',
        zipSha256: staleZipSha256,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
      return { deliveryPackageReleaseId, staleStorageId };
    });

    await t.mutation(internal.releaseArtifacts.publishDeliveryArtifact, {
      deliveryPackageReleaseId,
      artifactRole: 'server_deliverable',
      ownership: 'server_materialized',
      materializationStrategy: 'normalized_repack',
      storageId: staleStorageId,
      contentType: 'application/zip',
      deliveryName: 'vrc-get-com.yucp.jammr-2.1.5.zip',
      sha256: staleZipSha256,
      byteSize: staleZipBytes.byteLength,
    });

    const repaired = await t.action(internal.releaseArtifacts.repairMaterializedReleaseDeliverable, {
      deliveryPackageReleaseId,
      apply: true,
    });

    expect(repaired.status).toBe('repaired');
    if (repaired.status !== 'repaired') {
      throw new Error(`Expected repaired stale deliverable, got ${repaired.status}`);
    }
    expect(repaired).toMatchObject({
      status: 'repaired',
      deliveryPackageReleaseId,
      previousSha256: staleZipSha256,
      nextSha256: expect.any(String),
    });
    expect(repaired.nextSha256).not.toBe(staleZipSha256);

    const activeDeliverable = await t.run(async (ctx) => {
      return await ctx.db
        .query('delivery_release_artifacts')
        .withIndex('by_release_role_status', (q) =>
          q
            .eq('deliveryPackageReleaseId', deliveryPackageReleaseId)
            .eq('artifactRole', 'server_deliverable')
            .eq('status', 'active')
        )
        .first();
    });
    expect(activeDeliverable?.sha256).toBe(repaired.nextSha256);

    const deliverableBytes = await t.run(async (ctx) => {
      const blob = activeDeliverable ? await ctx.storage.get(activeDeliverable.storageId) : null;
      return blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : null;
    });
    expect(deliverableBytes).not.toBeNull();
    const archive = unzipSync(new Uint8Array(deliverableBytes!));
    const installerSource = new TextDecoder().decode(
      archive['Editor/YucpBackstageEmbeddedUnitypackageInstaller.cs']
    );
    expect(installerSource).toContain('using UnityEngine;');
    expect(installerSource).toContain('UnityEditor.PackageManager.PackageInfo.FindForAssembly');
    expect(installerSource).not.toContain('using UnityEditor.PackageManager;');

    const release = await t.run(async (ctx) => {
      return await ctx.db.get(deliveryPackageReleaseId);
    });
    expect(release?.zipSha256).toBe(repaired.nextSha256);
  });

  it('recovers stale wrapped payloads from legacy signed artifacts when no raw upload exists', async () => {
    const t = makeTestConvex();
    const uploadBytes = buildUnitypackage([
      { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
      { path: 'asset-guid/pathname', content: strToU8('Assets/JAMMR/readme.txt') },
    ]);
    const staleZipBytes = buildLegacyUnitypackageWrapperZip({
      packageId: 'com.yucp.jammr',
      version: '2.1.5',
      displayName: 'JAMMR',
      payloadBytes: uploadBytes,
    });
    const staleZipSha256 = await sha256Hex(staleZipBytes);
    const staleStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(new Blob([toArrayBuffer(staleZipBytes)], { type: 'application/zip' }));
    });
    const signedArtifactId = await t.mutation(internal.releaseArtifacts.publishArtifact, {
      artifactKey: 'backstage-package:com.yucp.jammr',
      channel: 'stable',
      platform: 'unity',
      version: '2.1.5',
      metadataVersion: 1,
      storageId: staleStorageId,
      contentType: 'application/zip',
      deliveryName: 'vrc-get-com.yucp.jammr-2.1.5.zip',
      envelopeCipher: 'aes-256-gcm',
      envelopeIvBase64: 'ZmFrZS1pdi1iYXNlNjQ=',
      ciphertextSha256: 'a'.repeat(64),
      ciphertextSize: staleZipBytes.byteLength,
      plaintextSha256: staleZipSha256,
      plaintextSize: staleZipBytes.byteLength,
    });
    const deliveryPackageReleaseId = await t.run(async (ctx) => {
      const now = Date.now();
      const deliveryPackageId = await ctx.db.insert('delivery_packages', {
        authUserId: 'auth-user-1',
        packageId: 'com.yucp.jammr',
        packageName: 'JAMMR',
        displayName: 'JAMMR',
        status: 'active',
        repositoryVisibility: 'listed',
        defaultChannel: 'stable',
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-1',
        deliveryPackageId,
        packageId: 'com.yucp.jammr',
        version: '2.1.5',
        channel: 'stable',
        releaseStatus: 'published',
        repositoryVisibility: 'listed',
        artifactKey: 'backstage-package:com.yucp.jammr',
        signedArtifactId,
        zipSha256: staleZipSha256,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
    });

    const repaired = await t.action(internal.releaseArtifacts.repairMaterializedReleaseDeliverable, {
      deliveryPackageReleaseId,
      apply: true,
    });

    expect(repaired.status).toBe('repaired');
    if (repaired.status !== 'repaired') {
      throw new Error(`Expected repaired signed-artifact deliverable, got ${repaired.status}`);
    }
    expect(repaired.previousSha256).toBe(staleZipSha256);
    expect(repaired.nextSha256).not.toBe(staleZipSha256);

    const release = await t.run(async (ctx) => {
      return await ctx.db.get(deliveryPackageReleaseId);
    });
    expect(release?.zipSha256).toBe(repaired.nextSha256);
  });
});
