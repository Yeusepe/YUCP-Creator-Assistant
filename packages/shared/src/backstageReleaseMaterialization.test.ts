import { describe, expect, it } from 'bun:test';
import { gzipSync, strToU8, unzipSync, zipSync } from 'fflate';
import { extractBackstagePackageMediaAssetsFromSource } from './backstagePackageMedia';
import {
  collectUnityPackageImportPaths,
  collectZipArchiveEntryPaths,
  materializeBackstageReleaseArtifact,
} from './backstageReleaseMaterialization';
import {
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY,
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY,
} from './backstageVpmDelivery';

const ZIP_DATE_A = new Date(315705600000);
const TAR_MTIME_A = 123;
const TAR_MTIME_B = 456;
const TEST_UNITYPACKAGE_DECOMPRESSED_LIMIT_BYTES = 1024 * 1024;
const TEST_UNITYPACKAGE_BOMB_DECOMPRESSED_BYTES = 1024 * 1024 + 512;
const ZIP_DECOMPRESSED_LIMIT_ERROR_MESSAGE = 'Backstage ZIP exceeds the decompressed size limit.';
const OVER_LIMIT_ZIP_ENTRY_DECLARED_BYTES = 0xffff_fff0;
const OVER_LIMIT_ZIP64_DECLARED_BYTES = 11 * 1024 * 1024 * 1024;

type MaterializedArtifact = Awaited<ReturnType<typeof materializeBackstageReleaseArtifact>>;

function materializedBytes(materialized: MaterializedArtifact): Uint8Array {
  expect(materialized.deliverable.kind).toBe('bytes');
  if (materialized.deliverable.kind !== 'bytes') {
    throw new Error('Expected a byte-based Backstage deliverable.');
  }
  return materialized.deliverable.bytes;
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

function buildUnitypackageEntryBomb(entryCount: number): Uint8Array {
  const tarBytes = new Uint8Array(entryCount * 512 + 1024);
  const header = buildTarHeader('repeated-guid/asset', 0, TAR_MTIME_A);
  for (let index = 0; index < entryCount; index += 1) {
    tarBytes.set(header, index * 512);
  }
  return gzipSync(tarBytes, { level: 9, mtime: TAR_MTIME_A });
}

function findZipSignature(bytes: Uint8Array, signature: readonly number[]): number {
  for (let offset = 0; offset + signature.length <= bytes.byteLength; offset += 1) {
    if (signature.every((value, index) => bytes[offset + index] === value)) {
      return offset;
    }
  }
  throw new Error(`ZIP signature ${signature.join(',')} was not found.`);
}

function writeUint16LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function writeUint32LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint64LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
  writeUint32LittleEndian(bytes, offset, value % 0x1_0000_0000);
  writeUint32LittleEndian(bytes, offset + 4, Math.floor(value / 0x1_0000_0000));
}

function patchZipCentralDirectoryDeclaredSizes(archive: Uint8Array, declaredBytes: number): void {
  const signature = [0x50, 0x4b, 0x01, 0x02] as const;
  let patchedEntries = 0;
  for (let offset = 0; offset + 46 <= archive.byteLength; offset += 1) {
    if (!signature.every((value, index) => archive[offset + index] === value)) {
      continue;
    }
    writeUint32LittleEndian(archive, offset + 24, declaredBytes);
    patchedEntries += 1;
  }
  if (patchedEntries === 0) {
    throw new Error('Expected at least one ZIP central-directory entry to patch.');
  }
}

function buildZipWithDeclaredDecompressedSizeOverLimit(): Uint8Array {
  const archive = zipSync({
    'Packages/com.yucp.example/package.json': new Uint8Array(),
    'Packages/com.yucp.example/Runtime/First.asset': new Uint8Array(),
    'Packages/com.yucp.example/Runtime/Second.asset': new Uint8Array(),
  });
  patchZipCentralDirectoryDeclaredSizes(archive, OVER_LIMIT_ZIP_ENTRY_DECLARED_BYTES);
  return archive;
}

function buildZipWithZip64DeclaredDecompressedSize(declaredBytes: number): Uint8Array {
  const archive = zipSync({
    'Packages/com.yucp.example/package.json': new Uint8Array(),
  });
  const centralHeaderOffset = findZipSignature(archive, [0x50, 0x4b, 0x01, 0x02]);
  const endOfCentralDirectoryOffset = findZipSignature(archive, [0x50, 0x4b, 0x05, 0x06]);
  const fileNameLength = readUint16LittleEndian(archive, centralHeaderOffset + 28);
  const extraFieldLength = readUint16LittleEndian(archive, centralHeaderOffset + 30);
  const zip64ExtraFieldLength = 12;
  const zip64ExtraFieldOffset = centralHeaderOffset + 46 + fileNameLength;
  const patched = new Uint8Array(archive.byteLength + zip64ExtraFieldLength);
  patched.set(archive.subarray(0, zip64ExtraFieldOffset));
  writeUint16LittleEndian(patched, zip64ExtraFieldOffset, 0x0001);
  writeUint16LittleEndian(patched, zip64ExtraFieldOffset + 2, 8);
  writeUint64LittleEndian(patched, zip64ExtraFieldOffset + 4, declaredBytes);
  patched.set(
    archive.subarray(zip64ExtraFieldOffset),
    zip64ExtraFieldOffset + zip64ExtraFieldLength
  );

  writeUint32LittleEndian(patched, centralHeaderOffset + 24, 0xffff_ffff);
  writeUint16LittleEndian(
    patched,
    centralHeaderOffset + 30,
    extraFieldLength + zip64ExtraFieldLength
  );
  writeUint32LittleEndian(
    patched,
    endOfCentralDirectoryOffset + zip64ExtraFieldLength + 12,
    readUint32LittleEndian(archive, endOfCentralDirectoryOffset + 12) + zip64ExtraFieldLength
  );
  return patched;
}

describe('collectZipArchiveEntryPaths', () => {
  it('collects file names from a ZIP central directory', () => {
    const archive = zipSync({
      'Packages/com.yucp.example/package.json': strToU8('{"name":"com.yucp.example"}'),
      'Packages/com.yucp.example/Runtime/Example.cs': strToU8('export class Example {}'),
    });

    expect(collectZipArchiveEntryPaths(archive)).toEqual([
      'Packages/com.yucp.example/package.json',
      'Packages/com.yucp.example/Runtime/Example.cs',
    ]);
  });

  it('rejects absolute and drive-qualified ZIP entry paths', () => {
    const absolutePathArchive = zipSync({
      '/Assets/Foo.prefab': strToU8('prefab'),
    });
    const driveQualifiedArchive = zipSync({
      'C:/Foo.cs': strToU8('export class Foo {}'),
    });

    expect(() => collectZipArchiveEntryPaths(absolutePathArchive)).toThrow(
      'Backstage release artifact contains unsafe archive path: /Assets/Foo.prefab'
    );
    expect(() => collectZipArchiveEntryPaths(driveQualifiedArchive)).toThrow(
      'Backstage release artifact contains unsafe archive path: C:/Foo.cs'
    );
  });

  it('collects central-directory names without inflating unsupported entry contents', () => {
    const archive = zipSync({
      'Packages/com.yucp.example/package.json': strToU8('{"name":"com.yucp.example"}'),
    });
    const centralHeaderOffset = findZipSignature(archive, [0x50, 0x4b, 0x01, 0x02]);
    writeUint16LittleEndian(archive, 8, 99);
    writeUint16LittleEndian(archive, centralHeaderOffset + 10, 99);

    expect(() => unzipSync(archive)).toThrow('unknown compression type');
    expect(collectZipArchiveEntryPaths(archive)).toEqual([
      'Packages/com.yucp.example/package.json',
    ]);
  });

  it('rejects a ZIP whose summed declared decompressed size exceeds the limit without inflating', () => {
    const archive = buildZipWithDeclaredDecompressedSizeOverLimit();

    expect(() => collectZipArchiveEntryPaths(archive)).toThrow(
      ZIP_DECOMPRESSED_LIMIT_ERROR_MESSAGE
    );
  });

  it('rejects an over-limit ZIP64 uncompressed size from the extended information field', () => {
    const archive = buildZipWithZip64DeclaredDecompressedSize(OVER_LIMIT_ZIP64_DECLARED_BYTES);

    expect(() => collectZipArchiveEntryPaths(archive)).toThrow(
      ZIP_DECOMPRESSED_LIMIT_ERROR_MESSAGE
    );
  });

  it('rejects a central-directory entry-count mismatch', () => {
    const archive = zipSync({
      'Packages/com.yucp.example/package.json': strToU8('{"name":"com.yucp.example"}'),
    });
    const endOfCentralDirectoryOffset = findZipSignature(archive, [0x50, 0x4b, 0x05, 0x06]);
    writeUint16LittleEndian(archive, endOfCentralDirectoryOffset + 8, 2);
    writeUint16LittleEndian(archive, endOfCentralDirectoryOffset + 10, 2);

    expect(() => collectZipArchiveEntryPaths(archive)).toThrow('central directory entry count');
  });
});

describe('collectUnityPackageImportPaths', () => {
  it('collects managed paths from a normal unitypackage', () => {
    const archive = buildUnitypackage(
      [
        { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
        { path: 'asset-guid/asset.meta', content: strToU8('meta-bytes') },
        { path: 'asset-guid/pathname', content: strToU8('Assets/Avatar/readme.txt') },
      ],
      TAR_MTIME_A
    );

    expect(collectUnityPackageImportPaths(archive)).toEqual([
      'Assets/Avatar/readme.txt',
      'Assets/Avatar/readme.txt.meta',
    ]);
  });

  it('rejects a highly compressed unitypackage entry bomb before materializing', async () => {
    const archive = buildUnitypackageEntryBomb(100_001);

    await expect(
      materializeBackstageReleaseArtifact({
        sourceBytes: archive,
        deliveryName: 'entry-bomb.unitypackage',
        contentType: 'application/octet-stream',
        packageId: 'com.yucp.entry-bomb',
        version: '1.0.0',
      })
    ).rejects.toThrow('Backstage unitypackage exceeds the decompressed size/entry limit.');
  });

  it('rejects a gzip bomb when decompressed bytes exceed the configured hard limit', () => {
    const archive = gzipSync(new Uint8Array(TEST_UNITYPACKAGE_BOMB_DECOMPRESSED_BYTES), {
      level: 9,
      mtime: TAR_MTIME_A,
    });

    expect(() =>
      collectUnityPackageImportPaths(archive, {
        maxDecompressedBytes: TEST_UNITYPACKAGE_DECOMPRESSED_LIMIT_BYTES,
      })
    ).toThrow('Backstage unitypackage exceeds the decompressed size/entry limit.');
  });
});

describe('materializeBackstageReleaseArtifact', () => {
  it('materializes ZIP uploads as thin importer shims from precomputed managed paths', async () => {
    const managedPaths = ['package.json', 'Runtime/Example.cs', 'README.md'];

    const materialized = await materializeBackstageReleaseArtifact({
      deliveryName: 'example.zip',
      contentType: 'application/zip',
      packageId: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      managedPaths,
      metadata: {
        description: 'Generated on the server',
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

    expect(materialized.originalSourceKind).toBe('zip');
    expect(materialized.sourceKind).toBe('zip');
    expect(materialized.deliveryName).toBe('vrc-get-com.yucp.example-1.2.3.zip');
    expect(materialized.deliverable.kind).toBe('bytes');
    expect(materializedBytes(materialized).byteLength).toBeLessThan(4 * 1024);

    const archive = unzipSync(materializedBytes(materialized));
    expect(Object.keys(archive)).toEqual(['package.json']);
    const packageJson = JSON.parse(new TextDecoder().decode(archive['package.json']));
    expect(packageJson.yucp.aliasId).toBe('creator-alias');
    expect(packageJson.yucp.installPlan.managedPaths).toEqual(managedPaths);
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
    expect(materializedBytes(first)).toEqual(materializedBytes(second));
    expect(first.deliverable.kind).toBe('bytes');
    expect(second.deliverable.kind).toBe('bytes');
    if (first.deliverable.kind !== 'bytes' || second.deliverable.kind !== 'bytes') {
      throw new Error('Expected byte-based unitypackage shim deliverables.');
    }
    expect(first.deliverable.sha256).toBe(second.deliverable.sha256);
    expect(first.deliverable.bytes).not.toEqual(firstInput);
    expect(first.contentType).toBe('application/zip');
    expect(first.deliveryName).toBe('vrc-get-com.yucp.example-1.2.3.zip');
    expect(first.sourceKind).toBe('zip');

    const archive = unzipSync(first.deliverable.bytes);
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

  it('extracts package-local banner and icon assets from upload metadata', async () => {
    const source = buildUnitypackage(
      [
        {
          path: 'metadata-guid/pathname',
          content: strToU8('Assets/YUCP_PackageInfo.json'),
        },
        {
          path: 'metadata-guid/asset',
          content: strToU8(
            JSON.stringify({
              packageName: 'Song Thing',
              icon: 'Assets/YUCP/icon.png',
              banner: 'Assets/YUCP/banner.webp',
            })
          ),
        },
        { path: 'icon-guid/pathname', content: strToU8('Assets/YUCP/icon.png') },
        { path: 'icon-guid/asset', content: strToU8('icon-bytes') },
        { path: 'banner-guid/pathname', content: strToU8('Assets/YUCP/banner.webp') },
        { path: 'banner-guid/asset', content: strToU8('banner-bytes') },
      ],
      TAR_MTIME_A
    );

    const media = await extractBackstagePackageMediaAssetsFromSource({
      sourceBytes: source,
      deliveryName: 'song-thing.unitypackage',
      contentType: 'application/octet-stream',
    });

    expect(
      media.map((asset) => ({
        kind: asset.kind,
        contentType: asset.contentType,
        sourcePath: asset.sourcePath,
        bytes: new TextDecoder().decode(asset.bytes),
      }))
    ).toEqual([
      {
        kind: 'banner',
        contentType: 'image/webp',
        sourcePath: 'Assets/YUCP/banner.webp',
        bytes: 'banner-bytes',
      },
      {
        kind: 'icon',
        contentType: 'image/png',
        sourcePath: 'Assets/YUCP/icon.png',
        bytes: 'icon-bytes',
      },
    ]);
  });

  it('extracts package-local media from zip uploads with generic browser content type', async () => {
    const source = zipSync(
      {
        'Packages/com.yucp.songthing/package.json': [
          strToU8(
            JSON.stringify({
              name: 'com.yucp.songthing',
              version: '1.0.12',
              icon: 'icon.png',
              banner: 'Images/banner.jpg',
            })
          ),
          { mtime: ZIP_DATE_A },
        ],
        'Packages/com.yucp.songthing/icon.png': [strToU8('icon-bytes'), { mtime: ZIP_DATE_A }],
        'Packages/com.yucp.songthing/Images/banner.jpg': [
          strToU8('banner-bytes'),
          { mtime: ZIP_DATE_A },
        ],
      },
      { level: 9 }
    );

    const media = await extractBackstagePackageMediaAssetsFromSource({
      sourceBytes: source,
      deliveryName: 'song-thing.zip',
      contentType: 'application/octet-stream',
      packageId: 'com.yucp.songthing',
    });

    expect(
      media.map((asset) => ({
        kind: asset.kind,
        contentType: asset.contentType,
        sourcePath: asset.sourcePath,
        bytes: new TextDecoder().decode(asset.bytes),
      }))
    ).toEqual([
      {
        kind: 'banner',
        contentType: 'image/jpeg',
        sourcePath: 'Images/banner.jpg',
        bytes: 'banner-bytes',
      },
      {
        kind: 'icon',
        contentType: 'image/png',
        sourcePath: 'icon.png',
        bytes: 'icon-bytes',
      },
    ]);
  });

  it('omits package visual metadata from importer shim package manifests', async () => {
    const input = buildUnitypackage(
      [
        { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
        { path: 'asset-guid/pathname', content: strToU8('Assets/Avatar/readme.txt') },
      ],
      TAR_MTIME_A
    );

    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: input,
      deliveryName: 'song-thing.unitypackage',
      contentType: 'application/octet-stream',
      packageId: 'com.yucp.songthing',
      version: '1.0.12',
      displayName: 'Song Thing',
      metadata: {
        icon: 'Assets/YUCP/icon.png',
        banner: 'Assets/YUCP/banner.png',
        iconUrl: 'https://cdn.test/icon.png',
        bannerUrl: 'https://cdn.test/banner.png',
        yucp: {
          kind: 'alias-v1',
          aliasId: 'song-thing',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          packageMetadata: {
            packageName: 'Song Thing',
            icon: 'Assets/YUCP/icon.png',
            banner: 'Assets/YUCP/banner.png',
          },
        },
      },
    });

    const archive = unzipSync(materializedBytes(materialized));
    const packageJson = JSON.parse(new TextDecoder().decode(archive['package.json']));

    expect(packageJson).not.toHaveProperty('icon');
    expect(packageJson).not.toHaveProperty('banner');
    expect(packageJson).not.toHaveProperty('iconUrl');
    expect(packageJson).not.toHaveProperty('bannerUrl');
    expect(packageJson.yucp.packageMetadata).toEqual({
      packageName: 'Song Thing',
    });
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
          minImporterVersion: '0.1.9',
          catalogProductIds: ['product_1'],
          channel: 'stable',
        },
      },
    });

    const archive = unzipSync(materializedBytes(materialized));
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

  it('records unitypackage payload paths in the alias install plan footprint', async () => {
    const input = buildUnitypackage(
      [
        { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
        { path: 'asset-guid/asset.meta', content: strToU8('fileFormatVersion: 2\n') },
        {
          path: 'asset-guid/pathname',
          content: strToU8('Assets/YUCP Assets/Song Thing/Marker.txt'),
        },
      ],
      TAR_MTIME_A
    );

    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: input,
      deliveryName: 'song-thing.unitypackage',
      contentType: 'application/octet-stream',
      packageId: 'com.yucp.songthing',
      version: '1.0.12',
      displayName: 'Song Thing',
      metadata: {
        yucp: {
          kind: 'alias-v1',
          aliasId: 'song-thing',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          catalogProductIds: ['product_1'],
          channel: 'stable',
          installPlan: {
            managedPaths: ['Assets/Publisher Supplied/Not In Artifact.txt'],
          },
        },
      },
    });

    const archive = unzipSync(materializedBytes(materialized));
    const packageJson = JSON.parse(new TextDecoder().decode(archive['package.json']));
    expect(packageJson.yucp.installPlan).toMatchObject({
      operation: 'install',
      managedPaths: [
        'Packages/com.yucp.songthing/package.json',
        'Assets/YUCP Assets/Song Thing/Marker.txt',
        'Assets/YUCP Assets/Song Thing/Marker.txt.meta',
      ],
    });
  });

  it('builds a unitypackage importer shim from precomputed managed paths without source bytes', async () => {
    const managedPaths = [
      'Packages/com.yucp.songthing/package.json',
      'Assets/YUCP Assets/Song Thing/Marker.txt',
      'Assets/YUCP Assets/Song Thing/Marker.txt.meta',
    ];

    const materialized = await materializeBackstageReleaseArtifact({
      deliveryName: 'song-thing.unitypackage',
      contentType: 'application/octet-stream',
      packageId: 'com.yucp.songthing',
      version: '1.0.12',
      displayName: 'Song Thing',
      managedPaths,
      metadata: {
        yucp: {
          kind: 'alias-v1',
          aliasId: 'song-thing',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
        },
      },
    });

    const archive = unzipSync(materializedBytes(materialized));
    const packageJson = JSON.parse(new TextDecoder().decode(archive['package.json']));
    expect(packageJson.yucp.aliasId).toBe('song-thing');
    expect(packageJson.yucp.installPlan.managedPaths).toEqual(managedPaths);
  });

  it('rejects an empty precomputed unitypackage install plan without source bytes', async () => {
    await expect(
      materializeBackstageReleaseArtifact({
        deliveryName: 'song-thing.unitypackage',
        contentType: 'application/octet-stream',
        packageId: 'com.yucp.songthing',
        version: '1.0.12',
        managedPaths: [],
        metadata: {
          yucp: {
            kind: 'alias-v1',
            aliasId: 'song-thing',
            installStrategy: 'server-authorized',
            importerPackage: 'com.yucp.importer',
          },
        },
      })
    ).rejects.toThrow('requires managedPaths or sourceBytes');
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
    expect(Object.keys(unzipSync(materializedBytes(materialized))).sort()).toEqual([
      'package.json',
    ]);
  });
});
