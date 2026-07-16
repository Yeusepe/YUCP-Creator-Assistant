import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { CANONICAL_FORMAT_TAGS, canonicalizeArtifact } from './canonicalizer';
import {
  measureLocalStore,
  reconstructArtifact,
  storeArtifact,
  verifyDesyncCli,
} from './desyncCas';
import { runCommand } from './process';

const scratchPaths: string[] = [];

function deterministicBytes(seed: string, byteLength: number): Buffer {
  return createHash('shake256', { outputLength: byteLength }).update(seed).digest();
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function writeFixtureTree(
  rootPath: string,
  versionSeed: string,
  timestamp: Date
): Promise<Map<string, string>> {
  const files = new Map<string, Buffer>([
    ['Assets/000-version.asset', deterministicBytes(versionSeed, 512 * 1024)],
    ['Assets/Audio/preview.ogg', deterministicBytes('shared-preview-ogg', 1536 * 1024)],
    ['Assets/Models/avatar.fbx', deterministicBytes('shared-avatar-fbx', 3 * 1024 * 1024)],
    [
      'Assets/Settings/package.asset',
      Buffer.from('Material:\n  shader: Standard\n  renderQueue: 2000\n'.repeat(12_000)),
    ],
    ['Assets/Textures/albedo.png', deterministicBytes('shared-albedo-png', 3 * 1024 * 1024)],
  ]);
  const hashes = new Map<string, string>();

  for (const [relativePath, bytes] of files) {
    const filePath = join(rootPath, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    await utimes(filePath, timestamp, timestamp);
    hashes.set(relativePath, createHash('sha256').update(bytes).digest('hex'));
  }
  for (const relativeDirectory of [
    'Assets/Audio',
    'Assets/Models',
    'Assets/Settings',
    'Assets/Textures',
    'Assets',
    '.',
  ]) {
    await utimes(join(rootPath, relativeDirectory), timestamp, timestamp);
  }
  return hashes;
}

async function createRawUnityPackage(
  sourcePath: string,
  outputPath: string,
  timestamp: Date
): Promise<void> {
  const tarPath = `${outputPath}.tar`;
  await runCommand('tar', [
    '--force-local',
    '--create',
    '--file',
    tarPath,
    '--format=gnu',
    '--sort=name',
    '--directory',
    sourcePath,
    '.',
  ]);
  await utimes(tarPath, timestamp, timestamp);
  await runCommand('gzip', ['--stdout', '--', tarPath], { stdoutPath: outputPath });
  await rm(tarPath, { force: true });
}

function assertScratchPath(scratchPath: string): void {
  const relativePath = relative(resolve(tmpdir()), resolve(scratchPath));
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(
      `Refusing to clean scratch path outside the system temp directory: ${scratchPath}`
    );
  }
}

afterAll(async () => {
  for (const scratchPath of scratchPaths) {
    assertScratchPath(scratchPath);
    await rm(scratchPath, { force: true, recursive: true });
  }
});

describe('local canonical storage core', () => {
  it('round-trips canonical artifacts and measures real cross-version desync deduplication', async () => {
    await verifyDesyncCli();
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-storage-core-e2e-'));
    scratchPaths.push(scratchPath);

    const v1TreePath = join(scratchPath, 'v1-tree');
    const v2TreePath = join(scratchPath, 'v2-tree');
    await mkdir(v1TreePath);
    await mkdir(v2TreePath);
    const v1Hashes = await writeFixtureTree(v1TreePath, 'version-one', new Date('2025-01-01'));
    const v2Hashes = await writeFixtureTree(v2TreePath, 'version-two', new Date('2026-01-01'));
    const changedInnerFiles = Array.from(v1Hashes.keys()).filter(
      (path) => v1Hashes.get(path) !== v2Hashes.get(path)
    );
    expect(changedInnerFiles).toEqual(['Assets/000-version.asset']);

    const rawV1Path = join(scratchPath, 'fixture-v1.unitypackage');
    const rawV2Path = join(scratchPath, 'fixture-v2.unitypackage');
    await createRawUnityPackage(v1TreePath, rawV1Path, new Date('2025-01-01'));
    await createRawUnityPackage(v2TreePath, rawV2Path, new Date('2026-01-01'));

    const canonicalV1Path = join(scratchPath, 'canonical-v1.unitypackage');
    const canonicalV1RepeatPath = join(scratchPath, 'canonical-v1-repeat.unitypackage');
    const canonicalV2Path = join(scratchPath, 'canonical-v2.unitypackage');
    const canonicalV2RepeatPath = join(scratchPath, 'canonical-v2-repeat.unitypackage');
    const canonicalV1 = await canonicalizeArtifact({
      inputPath: rawV1Path,
      outputPath: canonicalV1Path,
    });
    const canonicalV1Repeat = await canonicalizeArtifact({
      inputPath: rawV1Path,
      outputPath: canonicalV1RepeatPath,
    });
    const canonicalV2 = await canonicalizeArtifact({
      inputPath: rawV2Path,
      outputPath: canonicalV2Path,
    });
    const canonicalV2Repeat = await canonicalizeArtifact({
      inputPath: rawV2Path,
      outputPath: canonicalV2RepeatPath,
    });
    expect(canonicalV1.formatTag).toBe(CANONICAL_FORMAT_TAGS.tarGzip);
    expect(canonicalV2.formatTag).toBe(CANONICAL_FORMAT_TAGS.tarGzip);
    expect(await readFile(canonicalV1.path)).toEqual(await readFile(canonicalV1Repeat.path));
    expect(await readFile(canonicalV2.path)).toEqual(await readFile(canonicalV2Repeat.path));

    const rawZipPath = join(scratchPath, 'fixture.zip');
    const zipPackageJson = Buffer.from('{"name":"fixture","version":"1.0.0"}\n');
    const zipTexture = deterministicBytes('zip-already-compressed-texture', 256 * 1024);
    await writeFile(
      rawZipPath,
      zipSync({
        'Textures/albedo.png': [zipTexture, { level: 9, mtime: new Date(2026, 0, 1) }],
        'package.json': [zipPackageJson, { level: 9, mtime: new Date(2025, 0, 1) }],
      })
    );
    const canonicalZip = await canonicalizeArtifact({
      inputPath: rawZipPath,
      outputPath: join(scratchPath, 'fixture-canonical.zip'),
    });
    const canonicalZipRepeat = await canonicalizeArtifact({
      inputPath: rawZipPath,
      outputPath: join(scratchPath, 'fixture-canonical-repeat.zip'),
    });
    const canonicalZipBytes = await readFile(canonicalZip.path);
    expect(canonicalZip.formatTag).toBe(CANONICAL_FORMAT_TAGS.zip);
    expect(canonicalZipBytes).toEqual(await readFile(canonicalZipRepeat.path));
    const zipCompression = new Map<string, number>();
    const canonicalZipEntries = unzipSync(canonicalZipBytes, {
      filter: (entry) => {
        zipCompression.set(entry.name, entry.compression);
        return true;
      },
    });
    expect(canonicalZipEntries['Textures/albedo.png']).toEqual(zipTexture);
    expect(canonicalZipEntries['package.json']).toEqual(zipPackageJson);
    expect(zipCompression.get('Textures/albedo.png')).toBe(0);
    expect(zipCompression.get('package.json')).toBe(8);

    const canonicalStorePath = join(scratchPath, 'canonical-store');
    const canonicalV1IndexPath = join(scratchPath, 'canonical-v1.caibx');
    const canonicalV2IndexPath = join(scratchPath, 'canonical-v2.caibx');
    await storeArtifact({
      artifactPath: canonicalV1.path,
      indexPath: canonicalV1IndexPath,
      storePath: canonicalStorePath,
    });
    const singleCanonicalStore = await measureLocalStore(canonicalStorePath);
    const reconstructedV1Path = join(scratchPath, 'reconstructed-v1.unitypackage');
    await reconstructArtifact({
      indexPath: canonicalV1IndexPath,
      outputPath: reconstructedV1Path,
      storePath: canonicalStorePath,
    });
    expect(await sha256File(reconstructedV1Path)).toBe(await sha256File(canonicalV1.path));

    await storeArtifact({
      artifactPath: canonicalV2.path,
      indexPath: canonicalV2IndexPath,
      storePath: canonicalStorePath,
    });
    const twoVersionCanonicalStore = await measureLocalStore(canonicalStorePath);
    const reconstructedV2Path = join(scratchPath, 'reconstructed-v2.unitypackage');
    await reconstructArtifact({
      indexPath: canonicalV2IndexPath,
      outputPath: reconstructedV2Path,
      storePath: canonicalStorePath,
    });
    expect(await sha256File(reconstructedV2Path)).toBe(await sha256File(canonicalV2.path));

    const canonicalStoreRatio = twoVersionCanonicalStore.bytes / singleCanonicalStore.bytes;
    expect(twoVersionCanonicalStore.bytes).toBeGreaterThan(singleCanonicalStore.bytes);
    expect(canonicalStoreRatio).toBeLessThan(1.6);

    const rawStorePath = join(scratchPath, 'raw-store');
    await storeArtifact({
      artifactPath: rawV1Path,
      indexPath: join(scratchPath, 'raw-v1.caibx'),
      storePath: rawStorePath,
    });
    const singleRawStore = await measureLocalStore(rawStorePath);
    await storeArtifact({
      artifactPath: rawV2Path,
      indexPath: join(scratchPath, 'raw-v2.caibx'),
      storePath: rawStorePath,
    });
    const twoVersionRawStore = await measureLocalStore(rawStorePath);

    const sppPath = join(scratchPath, 'opaque-fixture.spp');
    const sppBytes = Buffer.concat([
      Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]),
      deterministicBytes('opaque-spp-hdf5-payload', 2 * 1024 * 1024),
    ]);
    await writeFile(sppPath, sppBytes);
    const canonicalSpp = await canonicalizeArtifact({
      inputPath: sppPath,
      outputPath: join(scratchPath, 'opaque-fixture.canonical'),
    });
    expect(canonicalSpp.formatTag).toBe(CANONICAL_FORMAT_TAGS.opaque);
    expect(await readFile(canonicalSpp.path)).toEqual(sppBytes);
    const sppStorePath = join(scratchPath, 'spp-store');
    const sppIndexPath = join(scratchPath, 'spp.caibx');
    await storeArtifact({
      artifactPath: canonicalSpp.path,
      indexPath: sppIndexPath,
      storePath: sppStorePath,
    });
    const reconstructedSppPath = join(scratchPath, 'reconstructed.spp');
    await reconstructArtifact({
      indexPath: sppIndexPath,
      outputPath: reconstructedSppPath,
      storePath: sppStorePath,
    });
    expect(await sha256File(reconstructedSppPath)).toBe(await sha256File(canonicalSpp.path));

    expect((await stat(rawV1Path)).size).toBeGreaterThan(0);
    console.log(
      [
        'CAS_E2E_RESULT',
        'byte-exact v1=yes v2=yes spp=yes; deterministic=yes',
        `single canonical version = ${singleCanonicalStore.bytes} bytes (${singleCanonicalStore.chunks} chunks)`,
        `two-version canonical store = ${twoVersionCanonicalStore.bytes} bytes (${twoVersionCanonicalStore.chunks} chunks)`,
        `canonical M/N = ${canonicalStoreRatio.toFixed(4)}`,
        `single raw version = ${singleRawStore.bytes} bytes (${singleRawStore.chunks} chunks)`,
        `raw two-version store = ${twoVersionRawStore.bytes} bytes (${twoVersionRawStore.chunks} chunks)`,
        `raw pair/single-raw = ${(twoVersionRawStore.bytes / singleRawStore.bytes).toFixed(4)}`,
        `raw R/canonical N = ${(twoVersionRawStore.bytes / singleCanonicalStore.bytes).toFixed(4)}`,
      ].join('\n')
    );
  });
});
