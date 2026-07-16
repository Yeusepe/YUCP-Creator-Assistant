import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { VerifyDeliveryUrlInput } from '../storage-core/deliverySigning';
import { verifyDeliveryUrl } from '../storage-core/deliverySigning';
import {
  buildDesyncS3StoreUrl,
  type CasStore,
  desyncS3ChildEnv,
  inspectDesyncIndex,
} from '../storage-core/desyncCas';
import { commandPathEnv, runCommand } from '../storage-core/process';
import { getS3Object } from '../storage-core/s3Control';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type ImporterCapability = VerifyDeliveryUrlInput;

export type ImportSeed = {
  artifactPath: string;
  indexId: string;
};

export type ImportVersionInput = {
  capability: ImporterCapability;
  expectedSha256: string;
  indexId: string;
  outputPath: string;
  seed?: ImportSeed;
  store: CasStore;
};

function assertRemoteIndexId(indexId: string): void {
  const segments = indexId.split('/');
  if (
    !indexId ||
    indexId.startsWith('/') ||
    indexId.includes('\\') ||
    indexId.includes('?') ||
    indexId.includes('#') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('S3 CAS index ID must be a safe relative object key');
  }
}

function storeLocation(store: CasStore): string {
  return store.kind === 'local' ? resolve(store.storePath) : buildDesyncS3StoreUrl(store.config);
}

function indexLocation(store: CasStore, indexId: string): string {
  if (store.kind === 'local') {
    return resolve(indexId);
  }
  assertRemoteIndexId(indexId);
  return buildDesyncS3StoreUrl(store.config, `${store.config.indexPrefix}${indexId}`);
}

function childEnv(store: CasStore): NodeJS.ProcessEnv {
  return store.kind === 's3' ? desyncS3ChildEnv(store.config) : commandPathEnv();
}

async function stageSeedIndex(input: {
  scratchPath: string;
  seed: ImportSeed;
  store: CasStore;
}): Promise<string> {
  const stagedIndexPath = join(input.scratchPath, 'seed.caibx');
  if (input.store.kind === 'local') {
    await writeFile(stagedIndexPath, await readFile(resolve(input.seed.indexId)), { mode: 0o600 });
    return stagedIndexPath;
  }

  assertRemoteIndexId(input.seed.indexId);
  const response = await getS3Object(
    input.store.config,
    `${input.store.config.indexPrefix}${input.seed.indexId}`
  );
  await writeFile(stagedIndexPath, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
  return stagedIndexPath;
}

async function measureFile(filePath: string): Promise<{ byteLength: number; sha256: string }> {
  const before = await stat(filePath);
  if (!before.isFile()) {
    throw new Error('Imported artifact is not a regular file');
  }

  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    byteLength += chunk.byteLength;
    hash.update(chunk);
  }
  const after = await stat(filePath);
  if (after.size !== before.size || byteLength !== before.size) {
    throw new Error('Imported artifact byte length changed during verification');
  }
  return { byteLength, sha256: hash.digest('hex') };
}

/**
 * desync seed contract: https://github.com/folbricht/desync#using-a-seed-file
 */
export async function importVersion(input: ImportVersionInput): Promise<string> {
  if (!(await verifyDeliveryUrl(input.capability))) {
    throw new Error('Invalid or expired importer capability');
  }
  if (!SHA256_PATTERN.test(input.expectedSha256)) {
    throw new Error('Expected importer SHA-256 must be a lowercase hexadecimal digest');
  }
  if (input.store.kind === 's3') {
    assertRemoteIndexId(input.indexId);
    if (input.seed) {
      assertRemoteIndexId(input.seed.indexId);
    }
  }

  const outputPath = resolve(input.outputPath);
  const seedArtifactPath = input.seed ? resolve(input.seed.artifactPath) : undefined;
  if (seedArtifactPath) {
    const seedStats = await stat(seedArtifactPath);
    if (!seedStats.isFile()) {
      throw new Error('Importer seed artifact is not a regular file');
    }
  }

  const outputDirectory = dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const scratchParent = seedArtifactPath ? dirname(seedArtifactPath) : outputDirectory;
  const scratchPath = await mkdtemp(join(scratchParent, '.yucp-importer-'));
  const storeUrl = storeLocation(input.store);
  const configPath = join(scratchPath, 'desync-config.json');
  let outputOwned = false;

  try {
    const chunks = await inspectDesyncIndex({ indexId: input.indexId, store: input.store });
    const expectedByteLength = chunks.reduce((total, chunk) => total + chunk.size, 0);
    if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength <= 0) {
      throw new Error('Importer index describes an invalid artifact byte length');
    }

    await writeFile(
      configPath,
      `${JSON.stringify({ 'store-options': { [storeUrl]: { uncompressed: true } } })}\n`,
      { mode: 0o600 }
    );
    const args = ['--config', configPath, 'extract', '--store', storeUrl];
    if (input.seed && seedArtifactPath) {
      const stagedIndexPath = await stageSeedIndex({
        scratchPath,
        seed: input.seed,
        store: input.store,
      });
      const relativeSeedIndex = relative(scratchPath, stagedIndexPath);
      const relativeSeedArtifact = relative(scratchPath, seedArtifactPath);
      if (relativeSeedIndex.includes(':') || relativeSeedArtifact.includes(':')) {
        throw new Error('Importer seed index and artifact must be on the same filesystem');
      }
      args.push('--seed', `${relativeSeedIndex}:${relativeSeedArtifact}`);
    }
    args.push('--', indexLocation(input.store, input.indexId), outputPath);

    await rm(outputPath, { force: true });
    outputOwned = true;
    await runCommand('desync', args, { cwd: scratchPath, env: childEnv(input.store) });
    const measured = await measureFile(outputPath);
    if (measured.byteLength !== expectedByteLength) {
      throw new Error(
        `Imported artifact byte length mismatch: expected ${expectedByteLength}, received ${measured.byteLength}`
      );
    }
    if (measured.sha256 !== input.expectedSha256) {
      throw new Error('Imported artifact SHA-256 mismatch');
    }
    return outputPath;
  } catch (error) {
    if (outputOwned) {
      await rm(outputPath, { force: true });
    }
    throw error;
  } finally {
    await rm(scratchPath, { force: true, recursive: true });
  }
}
