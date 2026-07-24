import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localCasStore, verifyDesyncCli } from './desyncCas';
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
});
