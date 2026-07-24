import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { verifyDesyncCli } from './desyncCas';
import {
  createDesyncEvaluationStore,
  distinctPackCount,
  extractDesyncTree,
  inspectDesyncIndexToFile,
  makeDesyncTreeIndex,
  measureDirectory,
  packDesyncStore,
  rebuildDesyncStoreFromPackedRanges,
  verifyDesyncEvaluationStore,
} from './desyncPackingTestSupport';
import { commandPathEnv, runCommand } from './process';

const CHUNK_PROFILES = ['16:64:256', '64:256:1024', '256:1024:4096', '1024:4096:16384'];
const PACK_PAYLOAD_BYTES = 64 * 1024 * 1024;

type TreeEntry = {
  bytes: number;
  path: string;
  sha256: string;
};

async function listFiles(directoryPath: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(currentPath: string): Promise<void> {
    for (const entry of await readdir(currentPath, { withFileTypes: true })) {
      const entryPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        paths.push(entryPath);
      } else {
        throw new Error(`Tree contains a non-file entry: ${entryPath}`);
      }
    }
  }
  await visit(resolve(directoryPath));
  return paths.sort((left, right) => left.localeCompare(right));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function describeTree(directoryPath: string): Promise<TreeEntry[]> {
  return await Promise.all(
    (await listFiles(directoryPath)).map(async (filePath) => ({
      bytes: (await stat(filePath)).size,
      path: relative(directoryPath, filePath).replaceAll('\\', '/'),
      sha256: await sha256File(filePath),
    }))
  );
}

async function findUnitySequence(corpusPath: string): Promise<string[]> {
  const patternValue = process.env.YUCP_STORAGE_CORPUS_CASE_PATTERN?.trim();
  const pattern = patternValue ? new RegExp(patternValue, 'i') : null;
  const groups = new Map<string, string[]>();
  for (const filePath of await listFiles(corpusPath)) {
    const name = basename(filePath);
    if (!/\.unitypackage$/i.test(name)) continue;
    const key = name.replace(/ \(\d+\)(?=\.unitypackage$)/i, '').toLowerCase();
    if (pattern && !pattern.test(key)) continue;
    const group = groups.get(key) ?? [];
    group.push(filePath);
    groups.set(key, group);
  }
  const sequence = [...groups.values()]
    .filter((files) => files.length >= 2)
    .sort((left, right) => left[0].localeCompare(right[0]))[0];
  if (!sequence) throw new Error('No matching multi-version .unitypackage sequence was found');
  return sequence.sort((left, right) => left.localeCompare(right));
}

async function extractUnityVersions(files: string[], rootPath: string): Promise<string[]> {
  const roots: string[] = [];
  for (const [index, filePath] of files.entries()) {
    const versionRoot = join(rootPath, `v${index}`);
    await mkdir(versionRoot, { recursive: true });
    await runCommand(
      'tar',
      ['--extract', '--gzip', '--file', filePath, '--directory', versionRoot],
      { env: commandPathEnv() }
    );
    roots.push(versionRoot);
  }
  return roots;
}

describe('real desync caidx evaluation', () => {
  let scratchPath: string;

  beforeAll(async () => {
    await verifyDesyncCli();
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-desync-caidx-'));
  });

  afterAll(async () => {
    if (scratchPath && process.env.YUCP_STORAGE_KEEP_SCRATCH !== 'true') {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test(
    'measures native compressed caidx trees across chunk profiles and reconstructs every file',
    async () => {
      const corpusPath = process.env.YUCP_STORAGE_CORPUS_DIR?.trim();
      if (!corpusPath) throw new Error('YUCP_STORAGE_CORPUS_DIR is required');
      const sourcePackages = await findUnitySequence(corpusPath);
      const sourceRoots = await extractUnityVersions(
        sourcePackages,
        join(scratchPath, 'extracted')
      );
      const expectedTrees = await Promise.all(sourceRoots.map(describeTree));
      const inputBytes = expectedTrees.reduce(
        (total, tree) => total + tree.reduce((sum, entry) => sum + entry.bytes, 0),
        0
      );
      const results = [];

      for (const chunkProfile of CHUNK_PROFILES) {
        const profileRoot = join(scratchPath, chunkProfile.replaceAll(':', '-'));
        const store = await createDesyncEvaluationStore({
          rootPath: join(profileRoot, 'store'),
          uncompressed: false,
        });
        const indexes: string[] = [];
        const chunksByVersion: Array<Array<{ id: string; size: number }>> = [];
        const storeBytesByVersion: number[] = [];
        const startedAt = performance.now();

        for (const [versionIndex, sourceRoot] of sourceRoots.entries()) {
          const indexPath = join(profileRoot, 'indexes', `v${versionIndex}.caidx`);
          await makeDesyncTreeIndex({
            chunkSize: chunkProfile,
            indexPath,
            sourcePath: sourceRoot,
            store,
          });
          indexes.push(indexPath);
          chunksByVersion.push(
            await inspectDesyncIndexToFile({
              digest: 'sha512-256',
              indexPath,
              outputPath: join(profileRoot, 'inspection', `v${versionIndex}.json`),
              store,
            })
          );
          storeBytesByVersion.push((await measureDirectory(store.storePath)).bytes);
        }

        const packed = await packDesyncStore({
          maxPayloadBytes: PACK_PAYLOAD_BYTES,
          outputPath: join(profileRoot, 'packs'),
          storePath: store.storePath,
        });
        const rebuilt = await createDesyncEvaluationStore({
          rootPath: join(profileRoot, 'rebuilt'),
          uncompressed: false,
        });
        await rebuildDesyncStoreFromPackedRanges({
          locations: packed.locations.values(),
          targetStorePath: rebuilt.storePath,
        });
        await verifyDesyncEvaluationStore(rebuilt, 'sha512-256');

        for (const [versionIndex, indexPath] of indexes.entries()) {
          const outputPath = join(profileRoot, 'reconstructed', `v${versionIndex}`);
          await extractDesyncTree({ indexPath, outputPath, store: rebuilt });
          expect(await describeTree(outputPath)).toEqual(expectedTrees[versionIndex]);
        }

        const storeMeasurement = await measureDirectory(store.storePath);
        const indexMeasurement = await measureDirectory(join(profileRoot, 'indexes'));
        const inspectionMeasurement = await measureDirectory(join(profileRoot, 'inspection'));
        const packBytes = packed.packs.reduce((sum, pack) => sum + pack.packBytes, 0);
        const packPayloadBytes = packed.packs.reduce((sum, pack) => sum + pack.payloadBytes, 0);
        results.push({
          chunkProfile,
          elapsedMs: Math.round(performance.now() - startedAt),
          exactReconstruction: true,
          indexBytes: indexMeasurement.bytes,
          inputBytes,
          inspectionJsonBytes: inspectionMeasurement.bytes,
          packBytes,
          packCount: packed.packs.length,
          packOverheadBytes: packBytes - packPayloadBytes,
          storeBytes: storeMeasurement.bytes,
          storeChunkObjects: storeMeasurement.files,
          versions: chunksByVersion.map((chunks, versionIndex) => ({
            addedStoreBytes:
              storeBytesByVersion[versionIndex] - (storeBytesByVersion[versionIndex - 1] ?? 0),
            chunkReferences: chunks.length,
            distinctChunks: new Set(chunks.map((chunk) => chunk.id)).size,
            packRequests: distinctPackCount(chunks, packed.locations),
          })),
        });
      }

      const resultsPath = process.env.YUCP_STORAGE_CAIDX_RESULTS_PATH?.trim();
      if (resultsPath) {
        await writeFile(resolve(resultsPath), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
      }
      console.info(`STORAGE_CAIDX_RESULTS=${JSON.stringify(results)}`);
    },
    3 * 60 * 60 * 1000
  );
});
