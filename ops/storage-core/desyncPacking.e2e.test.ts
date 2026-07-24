import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDesyncCli } from './desyncCas';
import {
  createDesyncEvaluationStore,
  distinctPackCount,
  extractDesyncArtifact,
  inspectDesyncIndexToFile,
  makeDesyncIndex,
  measureDirectory,
  packDesyncStore,
  rebuildDesyncStoreFromPackedRanges,
  sha256File,
  verifyDesyncEvaluationStore,
} from './desyncPackingTestSupport';

function deterministicBytes(label: string, bytes: number): Buffer {
  const output = Buffer.allocUnsafe(bytes);
  let offset = 0;
  let counter = 0;
  while (offset < output.byteLength) {
    const block = createHash('sha256').update(label).update(String(counter)).digest();
    block.copy(output, offset, 0, Math.min(block.byteLength, output.byteLength - offset));
    offset += block.byteLength;
    counter += 1;
  }
  return output;
}

describe('desync packed-range transport evaluation', () => {
  let scratchPath: string;

  beforeAll(async () => {
    await verifyDesyncCli();
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-desync-pack-evaluation-'));
  });

  afterAll(async () => {
    if (scratchPath) {
      await rm(scratchPath, {
        force: true,
        maxRetries: 10,
        recursive: true,
        retryDelay: 100,
      });
    }
  });

  test('deduplicates shifted versions, packs exact native chunk objects, and reconstructs both versions', async () => {
    const sourceV1 = join(scratchPath, 'source-v1.bin');
    const sourceV2 = join(scratchPath, 'source-v2.bin');
    const stablePrefix = deterministicBytes('stable-prefix', 4 * 1024 * 1024);
    const stableSuffix = deterministicBytes('stable-suffix', 4 * 1024 * 1024);
    const inserted = deterministicBytes('inserted-v2', 192 * 1024);
    await writeFile(sourceV1, Buffer.concat([stablePrefix, stableSuffix]));
    await writeFile(sourceV2, Buffer.concat([stablePrefix, inserted, stableSuffix]));

    const originalStore = await createDesyncEvaluationStore({
      rootPath: join(scratchPath, 'original-store'),
      uncompressed: false,
    });
    const indexV1 = join(scratchPath, 'indexes', 'v1.caibx');
    const indexV2 = join(scratchPath, 'indexes', 'v2.caibx');
    await makeDesyncIndex({ artifactPath: sourceV1, indexPath: indexV1, store: originalStore });
    const afterV1 = await measureDirectory(originalStore.storePath);
    await makeDesyncIndex({ artifactPath: sourceV2, indexPath: indexV2, store: originalStore });
    const afterV2 = await measureDirectory(originalStore.storePath);
    const v2AddedBytes = afterV2.bytes - afterV1.bytes;
    expect(v2AddedBytes).toBeLessThan((await readFile(sourceV2)).byteLength / 2);

    const chunksV1 = await inspectDesyncIndexToFile({
      indexPath: indexV1,
      outputPath: join(scratchPath, 'v1-chunks.json'),
      store: originalStore,
    });
    const chunksV2 = await inspectDesyncIndexToFile({
      indexPath: indexV2,
      outputPath: join(scratchPath, 'v2-chunks.json'),
      store: originalStore,
    });
    expect(chunksV1.length).toBeGreaterThan(50);
    expect(chunksV2.length).toBeGreaterThan(50);

    const packed = await packDesyncStore({
      maxPayloadBytes: 2 * 1024 * 1024,
      outputPath: join(scratchPath, 'packs'),
      storePath: originalStore.storePath,
    });
    expect(packed.locations.size).toBe(afterV2.files);
    expect(packed.packs.length).toBeLessThan(afterV2.files);
    expect(distinctPackCount(chunksV1, packed.locations)).toBeLessThan(chunksV1.length);
    expect(distinctPackCount(chunksV2, packed.locations)).toBeLessThan(chunksV2.length);

    const rebuiltStore = await createDesyncEvaluationStore({
      rootPath: join(scratchPath, 'rebuilt-store'),
      uncompressed: false,
    });
    await rebuildDesyncStoreFromPackedRanges({
      locations: packed.locations.values(),
      targetStorePath: rebuiltStore.storePath,
    });
    await verifyDesyncEvaluationStore(rebuiltStore);

    const reconstructedV1 = join(scratchPath, 'reconstructed-v1.bin');
    const reconstructedV2 = join(scratchPath, 'reconstructed-v2.bin');
    await extractDesyncArtifact({
      indexPath: indexV1,
      outputPath: reconstructedV1,
      store: rebuiltStore,
    });
    await extractDesyncArtifact({
      indexPath: indexV2,
      outputPath: reconstructedV2,
      store: rebuiltStore,
    });
    expect(await sha256File(reconstructedV1)).toBe(await sha256File(sourceV1));
    expect(await sha256File(reconstructedV2)).toBe(await sha256File(sourceV2));
  }, 120_000);

  test('reconstruction fails closed even though desync verify returns success for corruption', async () => {
    const sourcePath = join(scratchPath, 'corruption-source.bin');
    await writeFile(sourcePath, deterministicBytes('corruption-source', 2 * 1024 * 1024));
    const originalStore = await createDesyncEvaluationStore({
      rootPath: join(scratchPath, 'corruption-original'),
      uncompressed: false,
    });
    const indexPath = join(scratchPath, 'corruption.caibx');
    await makeDesyncIndex({ artifactPath: sourcePath, indexPath, store: originalStore });
    const packed = await packDesyncStore({
      outputPath: join(scratchPath, 'corruption-packs'),
      storePath: originalStore.storePath,
    });
    const rebuiltStore = await createDesyncEvaluationStore({
      rootPath: join(scratchPath, 'corruption-rebuilt'),
      uncompressed: false,
    });
    await rebuildDesyncStoreFromPackedRanges({
      locations: packed.locations.values(),
      targetStorePath: rebuiltStore.storePath,
    });
    const firstLocation = packed.locations.values().next().value;
    if (!firstLocation) {
      throw new Error('Expected at least one packed chunk');
    }
    const chunkPath = join(
      rebuiltStore.storePath,
      firstLocation.chunkId.slice(0, 4),
      firstLocation.entryName
    );
    const corrupted = Buffer.from(await readFile(chunkPath));
    corrupted[Math.floor(corrupted.byteLength / 2)] ^= 0xff;
    await writeFile(chunkPath, corrupted);
    await verifyDesyncEvaluationStore(rebuiltStore);
    await expect(
      extractDesyncArtifact({
        indexPath,
        outputPath: join(scratchPath, 'corrupted-reconstruction.bin'),
        store: rebuiltStore,
      })
    ).rejects.toThrow();
  });
});
