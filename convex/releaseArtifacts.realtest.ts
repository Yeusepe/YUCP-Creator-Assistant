import { materializeBackstageReleaseArtifact } from '@yucp/shared/backstageReleaseMaterialization';
import { BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY } from '@yucp/shared/backstageVpmDelivery';
import { gzipSync, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

const CDNGINE_ENV_KEYS = [
  'CDNGINE_ACCESS_TOKEN',
  'CDNGINE_API_BASE_URL',
  'CDNGINE_BACKSTAGE_DELIVERY_SCOPE_ID',
  'CDNGINE_BACKSTAGE_REQUIRED',
  'CDNGINE_BACKSTAGE_SERVICE_NAMESPACE_ID',
  'CDNGINE_BACKSTAGE_VARIANT',
] as const;
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(
  CDNGINE_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof CDNGINE_ENV_KEYS)[number], string | undefined>;
let cdngineUploadCounter = 0;
let cdngineUploadBodies: Array<ArrayBuffer> = [];

beforeEach(() => {
  cdngineUploadCounter = 0;
  cdngineUploadBodies = [];
  process.env.CDNGINE_API_BASE_URL = 'https://cdngine.test';
  process.env.CDNGINE_ACCESS_TOKEN = 'cdngine-token';
  process.env.CDNGINE_BACKSTAGE_REQUIRED = 'true';
  process.env.CDNGINE_BACKSTAGE_SERVICE_NAMESPACE_ID = 'yucp-backstage';
  process.env.CDNGINE_BACKSTAGE_DELIVERY_SCOPE_ID = 'paid-downloads';
  process.env.CDNGINE_BACKSTAGE_VARIANT = 'vpm-package';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://cdngine.test/v1/upload-sessions') {
      cdngineUploadCounter += 1;
      return new Response(
        JSON.stringify({
          uploadSessionId: `upl_backstage_${cdngineUploadCounter}`,
          assetId: `ast_backstage_${cdngineUploadCounter}`,
          versionId: `ver_backstage_pending_${cdngineUploadCounter}`,
          uploadTarget: {
            protocol: 'tus',
            method: 'PATCH',
            url: `https://uploads.cdngine.test/files/upl_backstage_${cdngineUploadCounter}`,
          },
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    if (url.startsWith('https://uploads.cdngine.test/files/')) {
      expect(init?.method).toBe('PATCH');
      if (init?.body instanceof ArrayBuffer) {
        cdngineUploadBodies.push(init.body);
      }
      return new Response(null, { status: 204 });
    }
    const completeMatch = url.match(
      /^https:\/\/cdngine\.test\/v1\/upload-sessions\/(upl_backstage_\d+)\/complete$/
    );
    if (completeMatch) {
      const index = completeMatch[1].replace('upl_backstage_', '');
      return new Response(
        JSON.stringify({
          assetId: `ast_backstage_${index}`,
          versionId: `ver_backstage_${index}`,
        }),
        {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    return new Response(`unexpected url: ${url}`, { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of CDNGINE_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

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

  it('uploads materialized Backstage deliverables to CDNgine when configured', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = {
      CDNGINE_ACCESS_TOKEN: process.env.CDNGINE_ACCESS_TOKEN,
      CDNGINE_API_BASE_URL: process.env.CDNGINE_API_BASE_URL,
      CDNGINE_BACKSTAGE_DELIVERY_SCOPE_ID: process.env.CDNGINE_BACKSTAGE_DELIVERY_SCOPE_ID,
      CDNGINE_BACKSTAGE_REQUIRED: process.env.CDNGINE_BACKSTAGE_REQUIRED,
      CDNGINE_BACKSTAGE_SERVICE_NAMESPACE_ID: process.env.CDNGINE_BACKSTAGE_SERVICE_NAMESPACE_ID,
      CDNGINE_BACKSTAGE_VARIANT: process.env.CDNGINE_BACKSTAGE_VARIANT,
    };
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    process.env.CDNGINE_API_BASE_URL = 'https://cdngine.test';
    process.env.CDNGINE_ACCESS_TOKEN = 'cdngine-token';
    process.env.CDNGINE_BACKSTAGE_REQUIRED = 'true';
    process.env.CDNGINE_BACKSTAGE_SERVICE_NAMESPACE_ID = 'yucp-backstage';
    process.env.CDNGINE_BACKSTAGE_DELIVERY_SCOPE_ID = 'paid-downloads';
    process.env.CDNGINE_BACKSTAGE_VARIANT = 'vpm-package';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      const url = String(input);
      if (url === 'https://cdngine.test/v1/upload-sessions') {
        return new Response(
          JSON.stringify({
            uploadSessionId: 'upl_backstage_1',
            assetId: 'ast_backstage_1',
            versionId: 'ver_backstage_pending',
            uploadTarget: {
              protocol: 'tus',
              method: 'PATCH',
              url: 'https://uploads.cdngine.test/files/upl_backstage_1',
            },
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      if (url === 'https://uploads.cdngine.test/files/upl_backstage_1') {
        expect(init?.method).toBe('PATCH');
        expect((init?.headers as Record<string, string>)['tus-resumable']).toBe('1.0.0');
        expect(init?.body).toBeInstanceOf(ArrayBuffer);
        return new Response(null, { status: 204 });
      }
      if (url === 'https://cdngine.test/v1/upload-sessions/upl_backstage_1/complete') {
        return new Response(
          JSON.stringify({
            assetId: 'ast_backstage_1',
            versionId: 'ver_backstage_1',
          }),
          {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      return new Response('unexpected url', { status: 500 });
    }) as typeof fetch;

    try {
      const t = makeTestConvex();
      const uploadBytes = zipSync(
        {
          'Packages/com.yucp.cdngine/package.json': [
            new TextEncoder().encode('{"name":"com.yucp.cdngine"}'),
            { mtime: new Date() },
          ],
          'Packages/com.yucp.cdngine/README.md': [
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

      const { deliveryPackageReleaseId } = await t.run(async (ctx) => {
        const now = Date.now();
        const deliveryPackageId = await ctx.db.insert('delivery_packages', {
          authUserId: 'auth-user-1',
          packageId: 'com.yucp.cdngine',
          packageName: 'CDNgine Release',
          displayName: 'CDNgine Release',
          status: 'active',
          repositoryVisibility: 'listed',
          defaultChannel: 'stable',
          createdAt: now,
          updatedAt: now,
        });
        const deliveryPackageReleaseId = await ctx.db.insert('delivery_package_releases', {
          authUserId: 'auth-user-1',
          deliveryPackageId,
          packageId: 'com.yucp.cdngine',
          version: '1.0.0',
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
          contentType: 'application/zip',
          deliveryName: 'cdngine.zip',
          sha256: uploadSha256,
        }
      );
      const deliverableArtifact = await t.query(internal.releaseArtifacts.getDeliveryArtifactById, {
        artifactId: materialized.deliverableArtifactId,
      });

      expect(deliverableArtifact?.storageId).toBeUndefined();
      expect(deliverableArtifact?.cdngineDelivery).toMatchObject({
        assetId: 'ast_backstage_1',
        versionId: 'ver_backstage_1',
        deliveryScopeId: 'paid-downloads',
        variant: 'vpm-package',
        serviceNamespaceId: 'yucp-backstage',
        tenantId: 'auth-user-1',
        assetOwner: 'creator:auth-user-1',
        sha256: materialized.deliverableSha256,
        byteSize: expect.any(Number),
      });
      const createCall = calls.find((call) => String(call.input).endsWith('/v1/upload-sessions'));
      expect((createCall?.init?.headers as Record<string, string>).authorization).toBe(
        'Bearer cdngine-token'
      );
      expect((createCall?.init?.headers as Record<string, string>)['idempotency-key']).toBe(
        `backstage-deliverable:${String(deliveryPackageReleaseId)}:${materialized.deliverableSha256}:create`
      );
      expect(JSON.parse(String(createCall?.init?.body))).toMatchObject({
        assetOwner: 'creator:auth-user-1',
        serviceNamespaceId: 'yucp-backstage',
        tenantId: 'auth-user-1',
        source: {
          contentType: 'application/zip',
          filename: 'cdngine.zip',
        },
        upload: {
          byteLength: deliverableArtifact?.byteSize,
          checksum: {
            algorithm: 'sha256',
            value: materialized.deliverableSha256,
          },
        },
      });
      const deletedUpload = await t.run(async (ctx) => await ctx.storage.get(storageId));
      expect(deletedUpload).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('materializes unitypackage uploads as shim-only VPM package zips', async () => {
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

    expect(deliverableArtifact?.storageId).toBeUndefined();
    const cdngineUploadBody = cdngineUploadBodies.at(-1);
    const deliverableBytes = cdngineUploadBody
      ? Array.from(new Uint8Array(cdngineUploadBody))
      : null;
    expect(deliverableBytes).not.toBeNull();
    if (!deliverableBytes) {
      throw new Error('Expected a materialized deliverable archive.');
    }
    const archive = unzipSync(new Uint8Array(deliverableBytes));
    expect(Object.keys(archive).sort()).toEqual(['package.json']);
    expect(Object.keys(archive).some((entry) => entry.startsWith('BackstagePayload~/'))).toBe(
      false
    );
    expect(Object.keys(archive).some((entry) => entry.endsWith('.cs'))).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(archive['package.json']))).toMatchObject({
      name: 'com.yucp.jammr',
      version: '2.1.5',
      displayName:
        'JAMMR - NEW UPDATE- Song recognition - Create-Join Spotify® Jams from within VRChat - VRCFury Ready',
    });
  });

  it('repairs stale unitypackage deliverables and updates the published digest', async () => {
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

    const repaired = await t.action(
      internal.releaseArtifacts.repairMaterializedReleaseDeliverable,
      {
        deliveryPackageReleaseId,
        apply: true,
      }
    );

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
    expect(activeDeliverable?.storageId).toBeUndefined();

    const cdngineUploadBody = cdngineUploadBodies.at(-1);
    const deliverableBytes = cdngineUploadBody
      ? Array.from(new Uint8Array(cdngineUploadBody))
      : null;
    expect(deliverableBytes).not.toBeNull();
    if (!deliverableBytes) {
      throw new Error('Expected a repaired deliverable archive.');
    }
    const archive = unzipSync(new Uint8Array(deliverableBytes));
    expect(Object.keys(archive).sort()).toEqual(['package.json']);
    expect(Object.keys(archive).some((entry) => entry.startsWith('BackstagePayload~/'))).toBe(
      false
    );
    expect(Object.keys(archive).some((entry) => entry.endsWith('.cs'))).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(archive['package.json']))).toMatchObject({
      name: 'com.yucp.jammr',
      version: '2.1.5',
      displayName: 'JAMMR',
    });

    const release = await t.run(async (ctx) => {
      return await ctx.db.get(deliveryPackageReleaseId);
    });
    expect(release?.zipSha256).toBe(repaired.nextSha256);
    expect(release?.metadata).toMatchObject({
      [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]: 'unitypackage',
    });
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
      return await ctx.storage.store(
        new Blob([toArrayBuffer(staleZipBytes)], { type: 'application/zip' })
      );
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

    const repaired = await t.action(
      internal.releaseArtifacts.repairMaterializedReleaseDeliverable,
      {
        deliveryPackageReleaseId,
        apply: true,
      }
    );

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
    expect(release?.metadata).toMatchObject({
      [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]: 'unitypackage',
    });
  });

  it('treats legacy plain ZIP artifacts as raw ZIP sources when no raw upload exists', async () => {
    const t = makeTestConvex();
    const zipBytes = zipSync(
      {
        'Packages/com.yucp.ziponly/package.json': strToU8(
          '{"name":"com.yucp.ziponly","version":"1.0.0"}'
        ),
        'Packages/com.yucp.ziponly/README.md': strToU8('zip-readme'),
      },
      { level: 9 }
    );
    const zipSha256 = await sha256Hex(zipBytes);
    const zipStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(zipBytes)], { type: 'application/zip' })
      );
    });
    const signedArtifactId = await t.mutation(internal.releaseArtifacts.publishArtifact, {
      artifactKey: 'backstage-package:com.yucp.ziponly',
      channel: 'stable',
      platform: 'unity',
      version: '1.0.0',
      metadataVersion: 1,
      storageId: zipStorageId,
      contentType: 'application/zip',
      deliveryName: 'ziponly-1.0.0.zip',
      envelopeCipher: 'aes-256-gcm',
      envelopeIvBase64: 'ZmFrZS1pdi1iYXNlNjQ=',
      ciphertextSha256: 'b'.repeat(64),
      ciphertextSize: zipBytes.byteLength,
      plaintextSha256: zipSha256,
      plaintextSize: zipBytes.byteLength,
    });
    const deliveryPackageReleaseId = await t.run(async (ctx) => {
      const now = Date.now();
      const deliveryPackageId = await ctx.db.insert('delivery_packages', {
        authUserId: 'auth-user-ziponly',
        packageId: 'com.yucp.ziponly',
        packageName: 'Zip Only',
        displayName: 'Zip Only',
        status: 'active',
        repositoryVisibility: 'listed',
        defaultChannel: 'stable',
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-ziponly',
        deliveryPackageId,
        packageId: 'com.yucp.ziponly',
        version: '1.0.0',
        channel: 'stable',
        releaseStatus: 'published',
        repositoryVisibility: 'listed',
        artifactKey: 'backstage-package:com.yucp.ziponly',
        signedArtifactId,
        zipSha256: 'c'.repeat(64),
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
    });

    const repaired = await t.action(
      internal.releaseArtifacts.repairMaterializedReleaseDeliverable,
      {
        deliveryPackageReleaseId,
        apply: true,
      }
    );

    expect(repaired.status).toBe('repaired');
    if (repaired.status !== 'repaired') {
      throw new Error(`Expected repaired ZIP deliverable, got ${repaired.status}`);
    }

    const rawArtifact = await t.run(async (ctx) => {
      return await ctx.db
        .query('delivery_release_artifacts')
        .withIndex('by_release_role_status', (q) =>
          q
            .eq('deliveryPackageReleaseId', deliveryPackageReleaseId)
            .eq('artifactRole', 'raw_upload')
            .eq('status', 'active')
        )
        .first();
    });
    expect(rawArtifact).toMatchObject({
      contentType: 'application/zip',
      deliveryName: 'ziponly-1.0.0.zip',
      sha256: zipSha256,
    });

    const release = await t.run(async (ctx) => {
      return await ctx.db.get(deliveryPackageReleaseId);
    });
    expect(release?.metadata).toMatchObject({
      [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]: 'zip',
    });
  });

  it('does not recover raw uploads from shim-only current deliverables', async () => {
    const t = makeTestConvex();
    const uploadBytes = buildUnitypackage([
      { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
      { path: 'asset-guid/pathname', content: strToU8('Assets/JAMMR/readme.txt') },
    ]);
    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: uploadBytes,
      deliveryName: 'JAMMR_2.1.5.unitypackage',
      contentType: 'application/octet-stream',
      packageId: 'com.yucp.jammr',
      version: '2.1.5',
      displayName: 'JAMMR',
    });
    const deliverableStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(materialized.bytes)], { type: materialized.contentType })
      );
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
        zipSha256: materialized.sha256,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
    });

    await t.mutation(internal.releaseArtifacts.publishDeliveryArtifact, {
      deliveryPackageReleaseId,
      artifactRole: 'server_deliverable',
      ownership: 'server_materialized',
      materializationStrategy: materialized.materializationStrategy,
      storageId: deliverableStorageId,
      contentType: materialized.contentType,
      deliveryName: materialized.deliveryName,
      sha256: materialized.sha256,
      byteSize: materialized.byteSize,
    });

    const repaired = await t.action(
      internal.releaseArtifacts.repairMaterializedReleaseDeliverable,
      {
        deliveryPackageReleaseId,
        apply: true,
      }
    );

    expect(repaired.status).toBe('missing_raw_upload');
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

    expect(activeDeliverable?.sha256).toBe(materialized.sha256);
    expect(activeDeliverable?.sourceArtifactId).toBeUndefined();
  });

  it('normalizes stale wrapped raw artifacts before repairing the active deliverable link', async () => {
    const t = makeTestConvex();
    const uploadBytes = buildUnitypackage([
      { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
      { path: 'asset-guid/pathname', content: strToU8('Assets/JAMMR/readme.txt') },
    ]);
    const staleRawBytes = buildLegacyUnitypackageWrapperZip({
      packageId: 'com.yucp.jammr',
      version: '2.1.5',
      displayName: 'JAMMR',
      payloadBytes: uploadBytes,
    });
    const staleRawSha256 = await sha256Hex(staleRawBytes);
    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: uploadBytes,
      deliveryName: 'JAMMR_2.1.5.unitypackage',
      contentType: 'application/octet-stream',
      packageId: 'com.yucp.jammr',
      version: '2.1.5',
      displayName: 'JAMMR',
    });
    const staleRawStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(staleRawBytes)], { type: 'application/zip' })
      );
    });
    const deliverableStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(materialized.bytes)], { type: materialized.contentType })
      );
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
        zipSha256: materialized.sha256,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
    });

    const rawArtifactId = await t.mutation(internal.releaseArtifacts.publishDeliveryArtifact, {
      deliveryPackageReleaseId,
      artifactRole: 'raw_upload',
      ownership: 'creator_upload',
      storageId: staleRawStorageId,
      contentType: 'application/zip',
      deliveryName: 'vrc-get-com.yucp.jammr-2.1.5.zip',
      sha256: staleRawSha256,
      byteSize: staleRawBytes.byteLength,
    });
    await t.mutation(internal.releaseArtifacts.publishDeliveryArtifact, {
      deliveryPackageReleaseId,
      artifactRole: 'server_deliverable',
      ownership: 'server_materialized',
      materializationStrategy: materialized.materializationStrategy,
      sourceArtifactId: rawArtifactId,
      storageId: deliverableStorageId,
      contentType: materialized.contentType,
      deliveryName: materialized.deliveryName,
      sha256: materialized.sha256,
      byteSize: materialized.byteSize,
    });

    const repaired = await t.action(
      internal.releaseArtifacts.repairMaterializedReleaseDeliverable,
      {
        deliveryPackageReleaseId,
        apply: true,
      }
    );

    expect(repaired.status).toBe('repaired');
    if (repaired.status !== 'repaired') {
      throw new Error(`Expected raw wrapper normalization repair, got ${repaired.status}`);
    }
    expect(repaired.nextSha256).not.toBe(staleRawSha256);

    const activeRawArtifact = await t.run(async (ctx) => {
      return await ctx.db
        .query('delivery_release_artifacts')
        .withIndex('by_release_role_status', (q) =>
          q
            .eq('deliveryPackageReleaseId', deliveryPackageReleaseId)
            .eq('artifactRole', 'raw_upload')
            .eq('status', 'active')
        )
        .first();
    });
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

    expect(activeRawArtifact).toMatchObject({
      contentType: 'application/octet-stream',
      deliveryName: 'payload.unitypackage',
    });
    expect(activeRawArtifact?.sha256).not.toBe(staleRawSha256);
    expect(activeDeliverable?.sha256).toBe(repaired.nextSha256);
    expect(String(activeDeliverable?.sourceArtifactId)).toBe(String(activeRawArtifact?._id));
  });
});
