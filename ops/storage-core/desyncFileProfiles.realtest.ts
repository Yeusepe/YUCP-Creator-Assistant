import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { verifyDesyncCli } from './desyncCas';
import {
  createDesyncEvaluationStore,
  distinctPackCount,
  extractDesyncArtifact,
  type InspectedChunk,
  inspectDesyncIndexToFile,
  makeDesyncIndex,
  measureDirectory,
  packDesyncStore,
  rebuildDesyncStoreFromPackedRanges,
  sha256File,
  verifyDesyncEvaluationStore,
} from './desyncPackingTestSupport';
import {
  discoverPackageCorpusCases,
  materializePackageCorpusCase,
  type PackageCorpusFormat,
  type PackageCorpusLogicalVersion,
} from './packageCorpusEvaluation';

const CHUNK_PROFILES = ['16:64:256', '64:256:1024', '256:1024:4096', '1024:4096:16384'];
const PACK_PAYLOAD_BYTES = 64 * 1024 * 1024;
const REQUIRED_SMALL_FILE_SIZES_KIB = [1, 4, 16, 32, 64];

type MaterializedCase = {
  format: PackageCorpusFormat;
  name: string;
  versions: PackageCorpusLogicalVersion[];
};

type IndexedFile = {
  bytes: number;
  chunks: InspectedChunk[];
  indexPath: string;
  relativePath: string;
  sha256: string;
  storage: 'cdc' | 'direct';
};

type IndexedVersion = {
  files: IndexedFile[];
  format: PackageCorpusFormat;
  name: string;
  versionIndex: number;
};

function profileMinimumBytes(profile: string): number {
  const minimumKiB = Number(profile.split(':')[0]);
  if (!Number.isSafeInteger(minimumKiB) || minimumKiB <= 0) {
    throw new Error(`Invalid desync chunk profile: ${profile}`);
  }
  return minimumKiB * 1024;
}

function directChunkPath(storePath: string, chunkId: string): string {
  return join(storePath, chunkId.slice(0, 4), chunkId);
}

async function putDirectChunk(input: {
  bytes: number;
  chunkId: string;
  sourcePath: string;
  storePath: string;
}): Promise<void> {
  const outputPath = directChunkPath(input.storePath, input.chunkId);
  const existing = await stat(outputPath).catch(() => null);
  if (existing) {
    if (!existing.isFile() || existing.size !== input.bytes) {
      throw new Error(`Direct chunk conflicts with an existing CAS object: ${input.chunkId}`);
    }
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await copyFile(input.sourcePath, outputPath);
}

function logicalTreeDigest(version: PackageCorpusLogicalVersion): Promise<string> {
  return Promise.all(
    version.files.map(async (file) => ({
      path: file.relativePath,
      sha256: await sha256File(file.path),
    }))
  ).then((files) =>
    createHash('sha256')
      .update(JSON.stringify(files.sort((left, right) => left.path.localeCompare(right.path))))
      .digest('hex')
  );
}

async function assertArchiveOrderAndFormatIndependence(cases: MaterializedCase[]): Promise<void> {
  const alphaUnity = cases.find(
    (corpusCase) => corpusCase.name === 'alpha' && corpusCase.format === 'unitypackage'
  );
  const alphaZip = cases.find(
    (corpusCase) => corpusCase.name === 'alpha' && corpusCase.format === 'zip'
  );
  if (!alphaUnity || !alphaZip) {
    throw new Error('The representative corpus is missing Alpha Unity and ZIP cases');
  }
  expect(alphaUnity.versions.length).toBe(alphaZip.versions.length);
  for (const [versionIndex, unityVersion] of alphaUnity.versions.entries()) {
    expect(await logicalTreeDigest(unityVersion)).toBe(
      await logicalTreeDigest(alphaZip.versions[versionIndex])
    );
  }
}

async function measureInputBytes(cases: MaterializedCase[]): Promise<number> {
  let bytes = 0;
  for (const corpusCase of cases) {
    for (const version of corpusCase.versions) {
      for (const file of version.files) {
        bytes += (await stat(file.path)).size;
      }
    }
  }
  return bytes;
}

function smallFileReuse(indexedVersions: IndexedVersion[]) {
  const filesByHash = new Map<string, IndexedFile[]>();
  for (const file of indexedVersions.flatMap((version) => version.files)) {
    const files = filesByHash.get(file.sha256) ?? [];
    files.push(file);
    filesByHash.set(file.sha256, files);
  }

  return [...filesByHash.values()]
    .filter(
      (files) =>
        files.length >= 2 &&
        files.every(
          (file) =>
            file.bytes === files[0].bytes &&
            file.chunks.length === files[0].chunks.length &&
            file.chunks.every((chunk, index) => chunk.id === files[0].chunks[index].id)
        )
    )
    .map((files) => ({
      bytes: files[0].bytes,
      chunkIds: files[0].chunks.map((chunk) => chunk.id),
      chunkObjects: files[0].chunks.length,
      paths: [...new Set(files.map((file) => file.relativePath))].sort(),
      sizeKiB: files[0].bytes / 1024,
      storage: files[0].storage,
    }))
    .filter((reuse) => REQUIRED_SMALL_FILE_SIZES_KIB.includes(reuse.sizeKiB))
    .sort((left, right) => left.sizeKiB - right.sizeKiB);
}

function changedLargeFileReuse(indexedVersions: IndexedVersion[]) {
  const results: Array<{
    format: PackageCorpusFormat;
    name: string;
    path: string;
    reusedBytes: number;
    reusedChunks: number;
  }> = [];
  const groups = new Map<string, IndexedVersion[]>();
  for (const version of indexedVersions) {
    const key = `${version.format}:${version.name}`;
    const versions = groups.get(key) ?? [];
    versions.push(version);
    groups.set(key, versions);
  }

  for (const versions of groups.values()) {
    const first = versions.find((version) => version.versionIndex === 0);
    const second = versions.find((version) => version.versionIndex === 1);
    if (!first || !second) {
      continue;
    }
    const secondFilesByPath = new Map(
      second.files.map((file) => [file.relativePath, file] as const)
    );
    for (const file of first.files) {
      const nextFile = secondFilesByPath.get(file.relativePath);
      if (!nextFile || file.sha256 === nextFile.sha256 || file.bytes <= 64 * 1024) {
        continue;
      }
      const nextChunkIds = new Set(nextFile.chunks.map((chunk) => chunk.id));
      const reused = file.chunks.filter((chunk) => nextChunkIds.has(chunk.id));
      results.push({
        format: first.format,
        name: first.name,
        path: file.relativePath,
        reusedBytes: reused.reduce((total, chunk) => total + chunk.size, 0),
        reusedChunks: reused.length,
      });
    }
  }
  return results;
}

async function runProfile(input: { cases: MaterializedCase[]; profile: string; rootPath: string }) {
  const startedAt = performance.now();
  const minimumBytes = profileMinimumBytes(input.profile);
  const store = await createDesyncEvaluationStore({
    rootPath: join(input.rootPath, 'store'),
    uncompressed: true,
  });
  const indexedVersions: IndexedVersion[] = [];
  const storeBytesByVersion: number[] = [];
  const directChunkIds = new Set<string>();

  for (const [caseIndex, corpusCase] of input.cases.entries()) {
    for (const [versionIndex, version] of corpusCase.versions.entries()) {
      const indexedFiles: IndexedFile[] = [];
      for (const [fileIndex, file] of version.files.entries()) {
        const fileStats = await stat(file.path);
        const sha256 = await sha256File(file.path);
        const indexPath = join(
          input.rootPath,
          'indexes',
          `${caseIndex.toString().padStart(3, '0')}-${corpusCase.format}-${corpusCase.name}`,
          `v${versionIndex}`,
          `${fileIndex.toString().padStart(6, '0')}`
        );

        if (fileStats.size < minimumBytes) {
          await putDirectChunk({
            bytes: fileStats.size,
            chunkId: sha256,
            sourcePath: file.path,
            storePath: store.storePath,
          });
          directChunkIds.add(sha256);
          await mkdir(dirname(indexPath), { recursive: true });
          await writeFile(
            `${indexPath}.direct.json`,
            `${JSON.stringify({ bytes: fileStats.size, chunkId: sha256, schemaVersion: 1 })}\n`
          );
          indexedFiles.push({
            bytes: fileStats.size,
            chunks: [{ id: sha256, size: fileStats.size }],
            indexPath: `${indexPath}.direct.json`,
            relativePath: file.relativePath,
            sha256,
            storage: 'direct',
          });
          continue;
        }

        const cdcIndexPath = `${indexPath}.caibx`;
        await makeDesyncIndex({
          artifactPath: file.path,
          chunkSize: input.profile,
          indexPath: cdcIndexPath,
          store,
        });
        const chunks = await inspectDesyncIndexToFile({
          indexPath: cdcIndexPath,
          outputPath: `${indexPath}.chunks.json`,
          store,
        });
        indexedFiles.push({
          bytes: fileStats.size,
          chunks,
          indexPath: cdcIndexPath,
          relativePath: file.relativePath,
          sha256,
          storage: 'cdc',
        });
      }
      indexedVersions.push({
        files: indexedFiles,
        format: corpusCase.format,
        name: corpusCase.name,
        versionIndex,
      });
      storeBytesByVersion.push((await measureDirectory(store.storePath)).bytes);
    }
  }

  await verifyDesyncEvaluationStore(store);
  const packed = await packDesyncStore({
    maxPayloadBytes: PACK_PAYLOAD_BYTES,
    outputPath: join(input.rootPath, 'packs'),
    storePath: store.storePath,
  });
  const rebuilt = await createDesyncEvaluationStore({
    rootPath: join(input.rootPath, 'rebuilt'),
    uncompressed: true,
  });
  await rebuildDesyncStoreFromPackedRanges({
    locations: packed.locations.values(),
    targetStorePath: rebuilt.storePath,
  });
  await verifyDesyncEvaluationStore(rebuilt);

  for (const [versionIndex, version] of indexedVersions.entries()) {
    for (const [fileIndex, file] of version.files.entries()) {
      const outputPath = join(
        input.rootPath,
        'reconstructed',
        `v${versionIndex}`,
        fileIndex.toString().padStart(6, '0')
      );
      await mkdir(dirname(outputPath), { recursive: true });
      if (file.storage === 'direct') {
        await copyFile(directChunkPath(rebuilt.storePath, file.chunks[0].id), outputPath);
      } else {
        await extractDesyncArtifact({
          indexPath: file.indexPath,
          outputPath,
          store: rebuilt,
        });
      }
      expect(await sha256File(outputPath)).toBe(file.sha256);
    }
  }

  const storeMeasurement = await measureDirectory(store.storePath);
  const indexMeasurement = await measureDirectory(join(input.rootPath, 'indexes'));
  const packBytes = packed.packs.reduce((total, pack) => total + pack.packBytes, 0);
  const packPayloadBytes = packed.packs.reduce((total, pack) => total + pack.payloadBytes, 0);
  const exactSmallReuse = smallFileReuse(indexedVersions);
  const largeFileReuse = changedLargeFileReuse(indexedVersions);

  return {
    addedStoreBytesByVersion: storeBytesByVersion.map(
      (bytes, index) => bytes - (storeBytesByVersion[index - 1] ?? 0)
    ),
    changedLargeFileReuse: largeFileReuse,
    directChunkObjects: directChunkIds.size,
    elapsedMs: Math.round(performance.now() - startedAt),
    exactReconstruction: true,
    exactSmallReuse,
    indexBytes: indexMeasurement.bytes,
    inputBytes: await measureInputBytes(input.cases),
    minimumBytes,
    packBytes,
    packCount: packed.packs.length,
    packOverheadBytes: packBytes - packPayloadBytes,
    profile: input.profile,
    storeBytes: storeMeasurement.bytes,
    storeChunkObjects: storeMeasurement.files,
    versionDeliveryRequests: indexedVersions.map((version) =>
      distinctPackCount(
        new Map(
          version.files.flatMap((file) => file.chunks).map((chunk) => [chunk.id, chunk] as const)
        ).values(),
        packed.locations
      )
    ),
  };
}

describe('file-oriented desync profile evaluation', () => {
  let scratchPath: string;

  beforeAll(async () => {
    await verifyDesyncCli();
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-desync-file-profiles-'));
  });

  afterAll(async () => {
    if (scratchPath && process.env.YUCP_STORAGE_KEEP_SCRATCH !== 'true') {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test(
    'compares physical cost and verifies exact global reuse on normalized logical files',
    async () => {
      const corpusPath = process.env.YUCP_STORAGE_CORPUS_DIR?.trim();
      if (!corpusPath) {
        throw new Error('YUCP_STORAGE_CORPUS_DIR is required for the profile evaluation');
      }
      const corpusCases = await discoverPackageCorpusCases(corpusPath);
      if (corpusCases.length === 0) {
        throw new Error('No multi-version package sequences matched the profile corpus');
      }
      const cases: MaterializedCase[] = [];
      for (const [caseIndex, corpusCase] of corpusCases.entries()) {
        cases.push({
          format: corpusCase.format,
          name: corpusCase.name,
          versions: await materializePackageCorpusCase(
            corpusCase,
            join(scratchPath, 'logical', `case-${caseIndex.toString().padStart(3, '0')}`)
          ),
        });
      }
      await assertArchiveOrderAndFormatIndependence(cases);

      const results = [];
      for (const profile of CHUNK_PROFILES) {
        const result = await runProfile({
          cases,
          profile,
          rootPath: join(scratchPath, 'profiles', profile.replaceAll(':', '-')),
        });
        expect(result.exactReconstruction).toBe(true);
        expect(result.exactSmallReuse.map((reuse) => reuse.sizeKiB)).toEqual(
          REQUIRED_SMALL_FILE_SIZES_KIB
        );
        expect(
          result.exactSmallReuse.some((reuse) => reuse.sizeKiB === 16 && reuse.paths.length > 1)
        ).toBe(true);
        results.push(result);
      }
      const selectedProfile = results.find((result) => result.profile === '64:256:1024');
      expect(selectedProfile).toBeDefined();
      if (!selectedProfile) {
        throw new Error('The selected 64:256:1024 profile result is missing');
      }
      expect(
        selectedProfile.exactSmallReuse
          .filter((reuse) => reuse.sizeKiB < 64)
          .every((reuse) => reuse.storage === 'direct' && reuse.chunkObjects === 1)
      ).toBe(true);
      expect(
        selectedProfile.exactSmallReuse.find((reuse) => reuse.sizeKiB === 64)?.chunkObjects
      ).toBe(1);
      expect(selectedProfile.changedLargeFileReuse.length).toBeGreaterThan(0);
      expect(
        selectedProfile.changedLargeFileReuse.every(
          (reuse) => reuse.reusedChunks > 0 && reuse.reusedBytes > 0
        )
      ).toBe(true);

      const resultsPath = process.env.YUCP_STORAGE_FILE_PROFILE_RESULTS_PATH?.trim();
      if (resultsPath) {
        await writeFile(resolve(resultsPath), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
      }
      console.info(`STORAGE_FILE_PROFILE_RESULTS=${JSON.stringify(results)}`);
    },
    3 * 60 * 60 * 1000
  );
});
