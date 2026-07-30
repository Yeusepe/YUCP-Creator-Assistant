import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOGICAL_FILE_CHUNK_IO_CONCURRENCY } from './boundedOrderedBatch';
import { localCasStore, produceFileChunks, verifyDesyncCli } from './desyncCas';
import { reconstructLogicalFile, storeLogicalFile } from './logicalFileCas';

const scratchPaths: string[] = [];

async function createScratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'yucp-logical-file-cas-test-'));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('logical file CAS', () => {
  test('stores a small file as one exact immutable chunk', async () => {
    const root = await createScratch();
    const sourcePath = join(root, 'small.shader');
    const outputPath = join(root, 'reconstructed.shader');
    const bytes = Uint8Array.from(Buffer.from('Shader "YUCP/Test" {}\n'));
    await writeFile(sourcePath, bytes);

    const recipe = await storeLogicalFile({
      bytes: bytes.byteLength,
      domain: 'common:global:v2',
      path: sourcePath,
      sha256: sha256(bytes),
      store: localCasStore(join(root, 'chunks')),
    });
    expect(recipe.bytes).toBe(bytes.byteLength);
    expect(recipe.sha256).toBe(sha256(bytes));
    expect(recipe.chunks).toHaveLength(1);
    expect(recipe.chunks[0]?.sha256).toBe(sha256(bytes));
    expect(recipe.chunks[0]?.id).not.toBe(sha256(bytes));

    await storeLogicalFile({
      bytes: bytes.byteLength,
      domain: 'common:global:v2',
      path: sourcePath,
      sha256: sha256(bytes),
      store: localCasStore(join(root, 'chunks')),
    });
    await reconstructLogicalFile({
      outputPath,
      recipe,
      store: localCasStore(join(root, 'chunks')),
    });
    expect(await readFile(outputPath)).toEqual(Buffer.from(bytes));
  });

  test('stores an empty file as one exact empty chunk', async () => {
    const root = await createScratch();
    const sourcePath = join(root, 'empty.asset');
    await writeFile(sourcePath, new Uint8Array());
    const digest = sha256(new Uint8Array());

    const recipe = await storeLogicalFile({
      bytes: 0,
      domain: 'common:global:v2',
      path: sourcePath,
      sha256: digest,
      store: localCasStore(join(root, 'chunks')),
    });

    expect(recipe.chunks).toEqual([
      { id: expect.stringMatching(/^[0-9a-f]{64}$/), sha256: digest, size: 0 },
    ]);
  });

  test('applies file-oriented CDC to a larger file and reconstructs it exactly', async () => {
    await verifyDesyncCli();
    const root = await createScratch();
    const sourcePath = join(root, 'large.asset');
    const outputPath = join(root, 'large.reconstructed.asset');
    const bytes = new Uint8Array(2 * 1024 * 1024);
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = (index * 31 + Math.floor(index / 4096)) % 251;
    }
    await writeFile(sourcePath, bytes);
    const digest = sha256(bytes);
    const store = localCasStore(join(root, 'chunks'));

    const recipe = await storeLogicalFile({
      bytes: bytes.byteLength,
      domain: 'common:global:v2',
      path: sourcePath,
      sha256: digest,
      store,
    });
    expect(recipe.chunks.length).toBeGreaterThan(1);

    await reconstructLogicalFile({ outputPath, recipe, store });
    expect(sha256(await readFile(outputPath))).toBe(digest);
  }, 30_000);

  test('preserves the prior output and removes temporary output after a chunk fails', async () => {
    await verifyDesyncCli();
    const root = await createScratch();
    const sourcePath = join(root, 'large.asset');
    const outputPath = join(root, 'large.reconstructed.asset');
    const priorOutput = Buffer.from('prior verified output');
    const bytes = new Uint8Array(2 * 1024 * 1024);
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = (index * 43 + Math.floor(index / 8192)) % 251;
    }
    await writeFile(sourcePath, bytes);
    await writeFile(outputPath, priorOutput);
    const store = localCasStore(join(root, 'chunks'));
    const recipe = await storeLogicalFile({
      bytes: bytes.byteLength,
      domain: 'common:global:v2',
      path: sourcePath,
      sha256: sha256(bytes),
      store,
    });
    expect(recipe.chunks.length).toBeGreaterThan(1);
    const corruptChunk = recipe.chunks[1];
    if (!corruptChunk) {
      throw new Error('Test fixture did not create a second chunk');
    }
    await writeFile(
      join(store.storePath, corruptChunk.id.slice(0, 4), corruptChunk.id),
      Buffer.alloc(corruptChunk.size, 0x7f)
    );

    await expect(reconstructLogicalFile({ outputPath, recipe, store })).rejects.toThrow(
      `CAS chunk failed verification: ${corruptChunk.id}`
    );

    expect(await readFile(outputPath)).toEqual(priorOutput);
    expect((await readdir(root)).filter((name) => name.includes('.tmp'))).toEqual([]);
  }, 30_000);

  test('aborts chunk publication after one bounded batch fails and settles every write', async () => {
    await verifyDesyncCli();
    const root = await createScratch();
    const sourcePath = join(root, 'publication.asset');
    // The fixture must produce more chunks than the widened chunk I/O pool so the
    // concurrency assertions below saturate the bound. Pseudorandom bytes keep the CDC
    // chunker near its average chunk size instead of collapsing to max-size chunks.
    const bytes = new Uint8Array(
      createHash('shake256', { outputLength: 24 * 1024 * 1024 })
        .update('bounded-batch-publication-fixture')
        .digest()
    );
    await writeFile(sourcePath, bytes);
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let settled = 0;

    await expect(
      produceFileChunks({
        artifactPath: sourcePath,
        onChunk: async ({ sha256: chunkSha256, size }) => {
          const operationIndex = started;
          started += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          try {
            await delay(operationIndex === 1 ? 2 : 20);
            if (operationIndex === 1) {
              throw new Error(`rejected chunk ${chunkSha256}`);
            }
            return { id: chunkSha256, sha256: chunkSha256, size };
          } finally {
            active -= 1;
            settled += 1;
          }
        },
      })
    ).rejects.toThrow('rejected chunk');

    expect(started).toBe(LOGICAL_FILE_CHUNK_IO_CONCURRENCY);
    expect(maximumActive).toBe(LOGICAL_FILE_CHUNK_IO_CONCURRENCY);
    expect(settled).toBe(started);
    expect(active).toBe(0);
  }, 30_000);
});
