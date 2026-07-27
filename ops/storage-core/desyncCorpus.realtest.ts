import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
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
  listPackageCorpusFiles,
  materializePackageCorpusCase,
  type PackageCorpusCase,
  type PackageCorpusFormat,
} from './packageCorpusEvaluation';

type LogicalFile = {
  path: string;
  relativePath: string;
};

type LogicalVersion = {
  files: LogicalFile[];
  name: string;
};

type IndexedFile = LogicalFile & {
  chunks: InspectedChunk[];
  indexPath: string;
  sha256: string;
};

type IndexedVersion = {
  files: IndexedFile[];
  name: string;
};

type VariantResult = {
  chunkProfile: string;
  compression: 'desync-native' | 'uncompressed';
  elapsedMs: number;
  exactReconstruction: boolean;
  indexBytes: number;
  inspectionJsonBytes: number;
  inputBytes: number;
  packBytes: number;
  packCount: number;
  packOverheadBytes: number;
  storeBytes: number;
  storeChunkObjects: number;
  reuse: {
    changedLargeFiles: Array<{
      path: string;
      reusedChunkBytes: number;
      reusedChunkIds: number;
    }>;
    reusedChunkBytes: number;
    reusedChunkIds: number;
    smallFileDirectReuseKiB: number[];
  };
  versions: Array<{
    addedStoreBytes: number;
    chunkReferences: number;
    distinctChunks: number;
    name: string;
    packRequests: number;
  }>;
};

type CorpusResult = {
  files: Array<{ bytes: number; path: string }>;
  format: PackageCorpusFormat | 'unitypackage-raw-pressure';
  name: string;
  variants: Array<{
    inputShape: 'logical-files' | 'raw-archive';
    measurement: VariantResult;
  }>;
};

const PACK_PAYLOAD_BYTES = 64 * 1024 * 1024;
const CHUNK_PROFILE = '64:256:1024';

async function rawVersions(corpusCase: PackageCorpusCase): Promise<LogicalVersion[]> {
  return corpusCase.files.map((filePath, index) => ({
    files: [{ path: filePath, relativePath: basename(filePath) }],
    name: `v${index}-${basename(filePath)}`,
  }));
}

async function runVariant(input: {
  rootPath: string;
  uncompressed: boolean;
  versions: LogicalVersion[];
}): Promise<VariantResult> {
  const startedAt = performance.now();
  const store = await createDesyncEvaluationStore({
    rootPath: join(input.rootPath, 'store'),
    uncompressed: input.uncompressed,
  });
  const indexedVersions: IndexedVersion[] = [];
  const versionStoreMeasurements: Array<{ bytes: number; files: number }> = [];
  let inputBytes = 0;

  for (const [versionIndex, version] of input.versions.entries()) {
    const indexedFiles: IndexedFile[] = [];
    for (const [fileIndex, file] of version.files.entries()) {
      const fileStats = await stat(file.path);
      if (!fileStats.isFile()) {
        throw new Error(`Corpus logical path is not a file: ${file.path}`);
      }
      inputBytes += fileStats.size;
      const indexPath = join(
        input.rootPath,
        'indexes',
        `v${versionIndex}`,
        `${fileIndex.toString().padStart(6, '0')}.caibx`
      );
      await makeDesyncIndex({
        artifactPath: file.path,
        chunkSize: CHUNK_PROFILE,
        indexPath,
        store,
      });
      const chunks = await inspectDesyncIndexToFile({
        indexPath,
        outputPath: join(
          input.rootPath,
          'inspection',
          `v${versionIndex}`,
          `${fileIndex.toString().padStart(6, '0')}.json`
        ),
        store,
      });
      indexedFiles.push({
        ...file,
        chunks,
        indexPath,
        sha256: await sha256File(file.path),
      });
    }
    indexedVersions.push({ files: indexedFiles, name: version.name });
    versionStoreMeasurements.push(await measureDirectory(store.storePath));
  }

  const storeMeasurement = await measureDirectory(store.storePath);
  const indexMeasurement = await measureDirectory(join(input.rootPath, 'indexes'));
  const inspectionMeasurement = await measureDirectory(join(input.rootPath, 'inspection'));
  const packed = await packDesyncStore({
    maxPayloadBytes: PACK_PAYLOAD_BYTES,
    outputPath: join(input.rootPath, 'packs'),
    storePath: store.storePath,
  });
  const packBytes = packed.packs.reduce((total, pack) => total + pack.packBytes, 0);
  const packPayloadBytes = packed.packs.reduce((total, pack) => total + pack.payloadBytes, 0);

  const rebuiltStore = await createDesyncEvaluationStore({
    rootPath: join(input.rootPath, 'rebuilt'),
    uncompressed: input.uncompressed,
  });
  await rebuildDesyncStoreFromPackedRanges({
    locations: packed.locations.values(),
    targetStorePath: rebuiltStore.storePath,
  });
  await verifyDesyncEvaluationStore(rebuiltStore);

  for (const [versionIndex, version] of indexedVersions.entries()) {
    for (const [fileIndex, file] of version.files.entries()) {
      const outputPath = join(
        input.rootPath,
        'reconstructed',
        `v${versionIndex}`,
        `${fileIndex.toString().padStart(6, '0')}${extname(file.relativePath)}`
      );
      await extractDesyncArtifact({ indexPath: file.indexPath, outputPath, store: rebuiltStore });
      if ((await sha256File(outputPath)) !== file.sha256) {
        throw new Error(`Reconstructed corpus file hash mismatch: ${file.relativePath}`);
      }
    }
  }

  const versions = indexedVersions.map((version, versionIndex) => {
    const chunks = version.files.flatMap((file) => file.chunks);
    const distinctChunks = new Set(chunks.map((chunk) => chunk.id));
    return {
      addedStoreBytes:
        versionStoreMeasurements[versionIndex].bytes -
        (versionStoreMeasurements[versionIndex - 1]?.bytes ?? 0),
      chunkReferences: chunks.length,
      distinctChunks: distinctChunks.size,
      name: version.name,
      packRequests: distinctPackCount(
        [...distinctChunks].map((id) => ({ id, size: 1 })),
        packed.locations
      ),
    };
  });
  const firstVersion = indexedVersions[0];
  const secondVersion = indexedVersions[1];
  const firstChunks = new Map(
    firstVersion?.files
      .flatMap((file) => file.chunks)
      .map((chunk) => [chunk.id, chunk.size] as const) ?? []
  );
  const secondChunkIds = new Set(
    secondVersion?.files.flatMap((file) => file.chunks).map((chunk) => chunk.id) ?? []
  );
  const reusedChunkIds = [...firstChunks.keys()].filter((id) => secondChunkIds.has(id));
  const secondFilesByHash = new Map(
    secondVersion?.files.map((file) => [file.sha256, file] as const) ?? []
  );
  const smallFileDirectReuseKiB = [
    ...new Set(
      (firstVersion?.files ?? [])
        .filter((file) => {
          const secondFile = secondFilesByHash.get(file.sha256);
          return (
            file.chunks.length === 1 &&
            secondFile?.chunks.length === 1 &&
            secondFile.chunks[0].id === file.chunks[0].id
          );
        })
        .map((file) => file.chunks[0].size / 1024)
        .filter((sizeKiB) => [1, 4, 16, 32, 64].includes(sizeKiB))
    ),
  ].sort((left, right) => left - right);
  const secondFilesByPath = new Map(
    secondVersion?.files.map((file) => [file.relativePath, file] as const) ?? []
  );
  const changedLargeFiles = (firstVersion?.files ?? [])
    .filter((file) => file.chunks.reduce((sum, chunk) => sum + chunk.size, 0) > 64 * 1024)
    .flatMap((file) => {
      const secondFile = secondFilesByPath.get(file.relativePath);
      if (!secondFile || secondFile.sha256 === file.sha256) {
        return [];
      }
      const secondIds = new Set(secondFile.chunks.map((chunk) => chunk.id));
      const reused = file.chunks.filter((chunk) => secondIds.has(chunk.id));
      return [
        {
          path: file.relativePath,
          reusedChunkBytes: reused.reduce((sum, chunk) => sum + chunk.size, 0),
          reusedChunkIds: reused.length,
        },
      ];
    });

  return {
    chunkProfile: CHUNK_PROFILE,
    compression: input.uncompressed ? 'uncompressed' : 'desync-native',
    elapsedMs: Math.round(performance.now() - startedAt),
    exactReconstruction: true,
    indexBytes: indexMeasurement.bytes,
    inspectionJsonBytes: inspectionMeasurement.bytes,
    inputBytes,
    packBytes,
    packCount: packed.packs.length,
    packOverheadBytes: packBytes - packPayloadBytes,
    storeBytes: storeMeasurement.bytes,
    storeChunkObjects: storeMeasurement.files,
    reuse: {
      changedLargeFiles,
      reusedChunkBytes: reusedChunkIds.reduce(
        (sum, chunkId) => sum + (firstChunks.get(chunkId) ?? 0),
        0
      ),
      reusedChunkIds: reusedChunkIds.length,
      smallFileDirectReuseKiB,
    },
    versions,
  };
}

async function caseFileMeasurements(corpusCase: PackageCorpusCase) {
  return await Promise.all(
    corpusCase.files.map(async (filePath) => ({
      bytes: (await stat(filePath)).size,
      path: filePath,
    }))
  );
}

describe('real desync package corpus evaluation', () => {
  let scratchPath: string;

  beforeAll(async () => {
    await verifyDesyncCli();
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-desync-corpus-'));
  });

  afterAll(async () => {
    if (scratchPath && process.env.YUCP_STORAGE_KEEP_SCRATCH !== 'true') {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test(
    'measures real version sequences and verifies every packed-range reconstruction',
    async () => {
      const corpusPath = process.env.YUCP_STORAGE_CORPUS_DIR?.trim();
      if (!corpusPath) {
        throw new Error('YUCP_STORAGE_CORPUS_DIR is required for the real corpus test');
      }
      const corpusCases = await discoverPackageCorpusCases(corpusPath);
      if (corpusCases.length === 0) {
        throw new Error('No multi-version package sequences matched the corpus');
      }
      const results: CorpusResult[] = [];

      for (const [caseIndex, corpusCase] of corpusCases.entries()) {
        const caseRoot = join(scratchPath, `case-${caseIndex}`);
        const raw = await rawVersions(corpusCase);
        const variants: CorpusResult['variants'] = [];
        for (const uncompressed of [false, true]) {
          variants.push({
            inputShape: 'raw-archive',
            measurement: await runVariant({
              rootPath: join(caseRoot, `raw-${uncompressed ? 'uncompressed' : 'compressed'}`),
              uncompressed,
              versions: raw,
            }),
          });
        }
        if (corpusCase.format !== 'opaque') {
          const logical = await materializePackageCorpusCase(
            corpusCase,
            join(caseRoot, 'logical-versions')
          );
          for (const uncompressed of [false, true]) {
            variants.push({
              inputShape: 'logical-files',
              measurement: await runVariant({
                rootPath: join(caseRoot, `logical-${uncompressed ? 'uncompressed' : 'compressed'}`),
                uncompressed,
                versions: logical,
              }),
            });
          }
        }
        results.push({
          files: await caseFileMeasurements(corpusCase),
          format: corpusCase.format,
          name: corpusCase.name,
          variants,
        });
      }

      if (process.env.YUCP_STORAGE_INCLUDE_LARGEST === 'true') {
        const allUnityPackages = (await listPackageCorpusFiles(corpusPath)).filter((filePath) =>
          /\.unitypackage$/i.test(filePath)
        );
        const measured = await Promise.all(
          allUnityPackages.map(async (filePath) => ({
            bytes: (await stat(filePath)).size,
            path: filePath,
          }))
        );
        const largest = measured.sort((left, right) => right.bytes - left.bytes)[0];
        if (!largest) {
          throw new Error('The corpus has no .unitypackage for the pressure measurement');
        }
        const pressureCase: PackageCorpusCase = {
          files: [largest.path],
          format: 'unitypackage',
          name: `pressure-${basename(largest.path)}`,
        };
        results.push({
          files: [largest],
          format: 'unitypackage-raw-pressure',
          name: pressureCase.name,
          variants: [
            {
              inputShape: 'raw-archive',
              measurement: await runVariant({
                rootPath: join(scratchPath, 'pressure-raw-compressed'),
                uncompressed: false,
                versions: await rawVersions(pressureCase),
              }),
            },
          ],
        });
      }

      for (const result of results) {
        expect(result.variants.length).toBeGreaterThan(0);
        for (const variant of result.variants) {
          expect(variant.measurement.exactReconstruction).toBe(true);
          expect(variant.measurement.packCount).toBeGreaterThan(0);
          expect(variant.measurement.storeChunkObjects).toBeGreaterThan(0);
        }
      }
      const logicalAlphaResults = results.filter(
        (result) => result.name === 'alpha' && result.variants[0]?.inputShape === 'raw-archive'
      );
      const normalizedAlphaResults = logicalAlphaResults.flatMap((result) =>
        result.variants.filter((variant) => variant.inputShape === 'logical-files')
      );
      expect(normalizedAlphaResults.length).toBeGreaterThan(0);
      for (const variant of normalizedAlphaResults) {
        expect(variant.measurement.reuse.smallFileDirectReuseKiB).toEqual([1, 4, 16, 32, 64]);
        expect(
          variant.measurement.reuse.changedLargeFiles.some(
            (file) => file.reusedChunkIds > 0 && file.reusedChunkBytes > 0
          )
        ).toBe(true);
      }

      const resultsPath = process.env.YUCP_STORAGE_RESULTS_PATH?.trim();
      if (resultsPath) {
        await writeFile(resolve(resultsPath), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
      }
      console.info(`STORAGE_CORPUS_RESULTS=${JSON.stringify(results)}`);
    },
    3 * 60 * 60 * 1000
  );
});
