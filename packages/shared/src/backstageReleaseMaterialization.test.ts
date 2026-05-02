import { describe, expect, it } from 'bun:test';
import { gzipSync, strToU8, unzipSync, zipSync } from 'fflate';
import { materializeBackstageReleaseArtifact } from './backstageReleaseMaterialization';
import {
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY,
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY,
} from './backstageVpmDelivery';

const ZIP_DATE_A = new Date(315705600000);
const ZIP_DATE_B = new Date(315964800000);
const TAR_MTIME_A = 123;
const TAR_MTIME_B = 456;

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

function buildTarHeader(path: string, size: number, mtimeSeconds: number): Uint8Array {
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtimeSeconds);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(header, 257, 6, 'ustar');
  writeAscii(header, 263, 2, '00');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeChecksum(header, checksum);
  return header;
}

function buildUnitypackage(
  entries: Array<{ path: string; content: Uint8Array }>,
  mtimeSeconds: number
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = buildTarHeader(entry.path, entry.content.byteLength, mtimeSeconds);
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
  return gzipSync(tarBytes, { level: 9, mtime: mtimeSeconds });
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(input));
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

describe('materializeBackstageReleaseArtifact', () => {
  it('canonicalizes ZIP uploads into deterministic deliverable bytes', async () => {
    const firstInput = zipSync(
      {
        'Packages/com.yucp.example/package.json': [
          strToU8('{"name":"pkg"}'),
          { mtime: ZIP_DATE_A },
        ],
        'Packages/com.yucp.example/README.md': [strToU8('hello'), { mtime: ZIP_DATE_A }],
      },
      { level: 9 }
    );
    const secondInput = zipSync(
      {
        'Packages/com.yucp.example/README.md': [strToU8('hello'), { mtime: ZIP_DATE_B }],
        'Packages/com.yucp.example/package.json': [
          strToU8('{"name":"pkg"}'),
          { mtime: ZIP_DATE_B },
        ],
      },
      { level: 9 }
    );

    const first = await materializeBackstageReleaseArtifact({
      sourceBytes: firstInput,
      deliveryName: 'example.zip',
      contentType: 'application/zip',
    });
    const second = await materializeBackstageReleaseArtifact({
      sourceBytes: secondInput,
      deliveryName: 'example.zip',
      contentType: 'application/zip',
    });

    expect(first.materializationStrategy).toBe('normalized_repack');
    expect(first.bytes).toEqual(second.bytes);
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes).not.toEqual(firstInput);
    expect(Object.keys(unzipSync(first.bytes)).sort()).toEqual([
      'Packages/com.yucp.example/README.md',
      'Packages/com.yucp.example/package.json',
    ]);
  });

  it('rewrites ZIP package manifests to match normalized repo metadata', async () => {
    const input = zipSync(
      {
        'Packages/com.yucp.example/package.json': [
          strToU8(
            JSON.stringify({
              name: 'com.yucp.backstage.raw',
              version: '0.0.1',
              [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]: 'zip',
              [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY]: 'server-derived-v1',
            })
          ),
          { mtime: ZIP_DATE_A },
        ],
        'Packages/com.yucp.example/README.md': [strToU8('hello'), { mtime: ZIP_DATE_A }],
      },
      { level: 9 }
    );

    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: input,
      deliveryName: 'example.zip',
      contentType: 'application/zip',
      packageId: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      metadata: {
        description: 'Generated on the server',
        dependencies: {
          'com.yucp.importer': '1.4.0',
        },
        [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]: 'zip',
        [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY]: 'server-derived-v1',
        yucp: {
          kind: 'alias-v1',
          aliasId: 'creator-alias',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
        },
      },
    });

    const archive = unzipSync(materialized.bytes);
    expect(
      JSON.parse(new TextDecoder().decode(archive['Packages/com.yucp.example/package.json']))
    ).toEqual({
      name: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      description: 'Generated on the server',
      vpmDependencies: {
        'com.yucp.importer': '1.4.0',
      },
      yucp: {
        kind: 'alias-v1',
        aliasId: 'creator-alias',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
      },
    });
    expect(
      JSON.parse(new TextDecoder().decode(archive['Packages/com.yucp.example/package.json']))
    ).not.toHaveProperty(BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY);
    expect(
      JSON.parse(new TextDecoder().decode(archive['Packages/com.yucp.example/package.json']))
    ).not.toHaveProperty(BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY);
  });

  it('rewrites root ZIP package manifests and strips reserved delivery keys', async () => {
    const input = zipSync(
      {
        'nested/package.json': [
          strToU8('{"name":"nested","version":"9.9.9"}'),
          { mtime: ZIP_DATE_A },
        ],
        'package.json': [
          strToU8(
            JSON.stringify({
              name: 'com.yucp.backstage.raw',
              version: '0.0.1',
              [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]: 'zip',
              [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY]: 'server-derived-v1',
            })
          ),
          { mtime: ZIP_DATE_A },
        ],
        'README.md': [strToU8('hello'), { mtime: ZIP_DATE_A }],
      },
      { level: 9 }
    );

    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: input,
      deliveryName: 'example.zip',
      contentType: 'application/zip',
      packageId: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      metadata: {
        description: 'Generated on the server',
        [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]: 'zip',
        [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY]: 'server-derived-v1',
      },
    });

    const archive = unzipSync(materialized.bytes);
    expect(JSON.parse(new TextDecoder().decode(archive['package.json']))).toEqual({
      name: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      description: 'Generated on the server',
    });
    expect(JSON.parse(new TextDecoder().decode(archive['nested/package.json']))).toEqual({
      name: 'nested',
      version: '9.9.9',
    });
  });

  it('materializes unitypackage uploads as importer-driven shim package zips', async () => {
    const firstInput = buildUnitypackage(
      [
        { path: 'b-guid/asset', content: strToU8('readme-bytes') },
        { path: 'a-guid/asset', content: strToU8('png-bytes') },
        { path: 'a-guid/pathname', content: strToU8('Assets/Avatar/body.png') },
        { path: 'b-guid/pathname', content: strToU8('Assets/Avatar/readme.txt') },
      ],
      TAR_MTIME_A
    );
    const secondInput = buildUnitypackage(
      [
        { path: 'a-guid/pathname', content: strToU8('Assets/Avatar/body.png') },
        { path: 'a-guid/asset', content: strToU8('png-bytes') },
        { path: 'b-guid/pathname', content: strToU8('Assets/Avatar/readme.txt') },
        { path: 'b-guid/asset', content: strToU8('readme-bytes') },
      ],
      TAR_MTIME_B
    );

    const first = await materializeBackstageReleaseArtifact({
      sourceBytes: firstInput,
      deliveryName: 'example.unitypackage',
      contentType: 'application/octet-stream',
      packageId: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      metadata: {
        description: 'Generated on the server',
        unity: '2022.3',
        dependencies: {
          'com.yucp.importer': '1.4.0',
        },
        [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]: 'unitypackage',
        [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY]: 'server-derived-v1',
      },
    });
    const second = await materializeBackstageReleaseArtifact({
      sourceBytes: secondInput,
      deliveryName: 'example.unitypackage',
      contentType: 'application/octet-stream',
      packageId: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      metadata: {
        description: 'Generated on the server',
        unity: '2022.3',
        dependencies: {
          'com.yucp.importer': '1.4.0',
        },
      },
    });

    expect(first.materializationStrategy).toBe('normalized_repack');
    expect(first.bytes).toEqual(second.bytes);
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes).not.toEqual(firstInput);
    expect(first.contentType).toBe('application/zip');
    expect(first.deliveryName).toBe('vrc-get-com.yucp.example-1.2.3.zip');
    expect(first.sourceKind).toBe('zip');

    const archive = unzipSync(first.bytes);
    expect(Object.keys(archive).sort()).toEqual(['package.json']);

    const packageJson = JSON.parse(new TextDecoder().decode(archive['package.json']));
    expect(packageJson).toEqual({
      name: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      description: 'Generated on the server',
      unity: '2022.3',
      vpmDependencies: {
        'com.yucp.importer': '1.4.0',
      },
    });
    expect(packageJson).not.toHaveProperty(BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY);
    expect(packageJson).not.toHaveProperty(BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY);

    expect(Object.keys(archive).some((entry) => entry.startsWith('BackstagePayload~/'))).toBe(
      false
    );
    expect(Object.keys(archive).some((entry) => entry.endsWith('.cs'))).toBe(false);
  });

  it('sanitizes server-generated shim display names and preserves protected package titles', async () => {
    const input = buildUnitypackage(
      [
        { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
        { path: 'asset-guid/pathname', content: strToU8('Assets/Avatar/readme.txt') },
      ],
      TAR_MTIME_A
    );
    const protectedTitle = 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready';

    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: input,
      deliveryName: 'song-thing.unitypackage',
      contentType: 'application/octet-stream',
      packageId: 'com.yucp.songthing',
      version: '1.0.6',
      displayName: protectedTitle,
      metadata: {
        yucp: {
          kind: 'alias-v1',
          aliasId: 'song-thing-your-spotify-library-within-vrchat-vrcfury-ready',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          minImporterVersion: '0.1.0',
          catalogProductIds: ['product_1'],
          channel: 'stable',
        },
      },
    });

    const archive = unzipSync(materialized.bytes);
    const packageJson = JSON.parse(new TextDecoder().decode(archive['package.json']));
    expect(packageJson).toMatchObject({
      name: 'com.yucp.songthing',
      version: '1.0.6',
      displayName: 'Song Thing - Your Spotify® library within VRChat - VRCFury Ready',
      yucp: {
        kind: 'alias-v1',
        aliasId: 'song-thing-your-spotify-library-within-vrchat-vrcfury-ready',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        packageDisplayName: protectedTitle,
      },
    });
    expect(packageJson.displayName).not.toContain('|');
  });

  it('rejects unsafe archive paths during materialization', async () => {
    const input = zipSync(
      {
        '../escape.txt': [strToU8('oops'), { mtime: ZIP_DATE_A }],
      },
      { level: 9 }
    );

    await expect(
      materializeBackstageReleaseArtifact({
        sourceBytes: input,
        deliveryName: 'unsafe.zip',
        contentType: 'application/zip',
      })
    ).rejects.toThrow('unsafe archive path');
  });

  it('prefers persisted source kind metadata over wrapper-looking delivery names', async () => {
    const input = buildUnitypackage(
      [
        { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
        { path: 'asset-guid/pathname', content: strToU8('Assets/Avatar/readme.txt') },
      ],
      TAR_MTIME_A
    );

    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: input,
      deliveryName: 'vrc-get-com.yucp.example-1.2.3.zip',
      contentType: 'application/zip',
      packageId: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      metadata: {
        [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]: 'unitypackage',
        [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY]: 'server-derived-v1',
      },
    });

    expect(materialized.deliveryName).toBe('vrc-get-com.yucp.example-1.2.3.zip');
    expect(Object.keys(unzipSync(materialized.bytes)).sort()).toEqual(['package.json']);
  });
});
