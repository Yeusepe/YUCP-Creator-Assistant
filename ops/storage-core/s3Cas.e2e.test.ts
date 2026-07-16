import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { canonicalizeArtifact } from './canonicalizer';
import { loadCasConfig } from './config';
import {
  inspectDesyncIndex,
  reconstructArtifactFromStore,
  s3CasStore,
  storeArtifactToStore,
  verifyDesyncCli,
} from './desyncCas';
import { runCommand } from './process';
import { createS3Bucket, deleteS3Objects, getS3Object, listS3Objects } from './s3Control';

const MINIO_IMAGE = 'minio/minio:RELEASE.2025-09-07T16-13-09Z';
const TEST_CONTAINER_LABEL = 'com.yucp.test=cas-s3';

let containerId: string | undefined;
let scratchPath: string | undefined;

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

function assertScratchPath(path: string): void {
  const relativePath = relative(resolve(tmpdir()), resolve(path));
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`Refusing to clean scratch path outside the system temp directory: ${path}`);
  }
}

async function waitForMinio(endpoint: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/minio/health/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // The throwaway server is still starting.
    }
    await Bun.sleep(250);
  }
  throw new Error('Throwaway MinIO did not become ready within 60 seconds');
}

beforeAll(async () => {
  await runCommand('docker', ['version', '--format', '{{.Server.Version}}']);
  await verifyDesyncCli();
});

afterAll(async () => {
  if (containerId) {
    try {
      await runCommand('docker', ['rm', '--force', containerId]);
    } catch {
      // Docker --rm may already have removed a stopped throwaway container.
    }
  }
  if (scratchPath) {
    assertScratchPath(scratchPath);
    await rm(scratchPath, { force: true, recursive: true });
  }
});

describe('desync S3 CAS against throwaway MinIO', () => {
  it('round-trips remote chunks and indexes byte-exactly and deduplicates a second version', async () => {
    const accessKeyId = `test-${randomBytes(12).toString('hex')}`;
    const secretAccessKey = randomBytes(32).toString('hex');
    const bucket = `cas-test-${randomBytes(8).toString('hex')}`;
    const containerName = `yucp-cas-s3-${randomBytes(6).toString('hex')}`;
    const started = await runCommand('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--label',
      TEST_CONTAINER_LABEL,
      '--publish',
      '127.0.0.1::9000',
      '--env',
      `MINIO_ROOT_USER=${accessKeyId}`,
      '--env',
      `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
      MINIO_IMAGE,
      'server',
      '/data',
      '--address',
      ':9000',
    ]);
    containerId = started.stdout.trim();
    if (!containerId) {
      throw new Error('Docker did not return the throwaway MinIO container ID');
    }

    const publishedPort = (
      await runCommand('docker', ['port', containerId, '9000/tcp'])
    ).stdout.trim();
    const portMatch = publishedPort.match(/127\.0\.0\.1:(\d+)$/m);
    if (!portMatch?.[1]) {
      throw new Error('Docker did not publish the throwaway MinIO API on a random local port');
    }
    const endpoint = `http://127.0.0.1:${portMatch[1]}`;
    await waitForMinio(endpoint);

    const config = loadCasConfig({
      CAS_S3_ENDPOINT: endpoint,
      CAS_S3_REGION: 'us-east-1',
      CAS_S3_BUCKET: bucket,
      CAS_S3_ACCESS_KEY_ID: accessKeyId,
      CAS_S3_SECRET_ACCESS_KEY: secretAccessKey,
    });
    await createS3Bucket(config);
    const store = s3CasStore(config);

    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-cas-s3-e2e-'));
    const sharedPrefix = deterministicBytes('shared-prefix', 4 * 1024 * 1024);
    const sharedSuffix = deterministicBytes('shared-suffix', 4 * 1024 * 1024);
    const rawV1Path = join(scratchPath, 'artifact-v1.bin');
    const rawV2Path = join(scratchPath, 'artifact-v2.bin');
    await writeFile(
      rawV1Path,
      Buffer.concat([sharedPrefix, deterministicBytes('version-one', 256 * 1024), sharedSuffix])
    );
    await writeFile(
      rawV2Path,
      Buffer.concat([sharedPrefix, deterministicBytes('version-two', 256 * 1024), sharedSuffix])
    );

    const canonicalV1 = await canonicalizeArtifact({
      inputPath: rawV1Path,
      outputPath: join(scratchPath, 'canonical-v1.bin'),
    });
    const canonicalV2 = await canonicalizeArtifact({
      inputPath: rawV2Path,
      outputPath: join(scratchPath, 'canonical-v2.bin'),
    });

    await storeArtifactToStore({
      artifactPath: canonicalV1.path,
      indexId: 'v1.caibx',
      store,
    });
    const afterV1 = await listS3Objects(config);
    expect(afterV1.some((object) => object.key.startsWith(config.chunkPrefix))).toBeTrue();
    expect(afterV1.some((object) => object.key === `${config.indexPrefix}v1.caibx`)).toBeTrue();
    const v1Chunks = afterV1.filter((object) => object.key.startsWith(config.chunkPrefix));
    const inspectedV1Chunks = await inspectDesyncIndex({ indexId: 'v1.caibx', store });
    expect(inspectedV1Chunks).toHaveLength(v1Chunks.length);
    for (const chunk of v1Chunks) {
      const response = await getS3Object(config, chunk.key);
      const bytes = Buffer.from(await response.arrayBuffer());
      const chunkId = chunk.key.split('/').at(-1);
      if (!chunkId) {
        throw new Error(`S3 chunk object key did not contain a chunk ID: ${chunk.key}`);
      }
      expect(bytes.byteLength).toBe(chunk.size);
      expect(createHash('sha512-256').update(bytes).digest('hex')).toBe(chunkId);
    }

    const reconstructedV1Path = join(scratchPath, 'reconstructed-v1.bin');
    await reconstructArtifactFromStore({
      indexId: 'v1.caibx',
      outputPath: reconstructedV1Path,
      store,
    });
    expect(await sha256File(reconstructedV1Path)).toBe(await sha256File(canonicalV1.path));

    await storeArtifactToStore({
      artifactPath: canonicalV2.path,
      indexId: 'v2.caibx',
      store,
    });
    const afterV2 = await listS3Objects(config);
    const v1StoredBytes = afterV1.reduce((total, object) => total + object.size, 0);
    const v2DeltaBytes = afterV2.reduce((total, object) => total + object.size, 0) - v1StoredBytes;
    const v2DeltaObjects = afterV2.length - afterV1.length;
    expect(v2DeltaBytes).toBeGreaterThan(0);
    expect(v2DeltaBytes).toBeLessThan(v1StoredBytes / 3);

    const reconstructedV2Path = join(scratchPath, 'reconstructed-v2.bin');
    await reconstructArtifactFromStore({
      indexId: 'v2.caibx',
      outputPath: reconstructedV2Path,
      store,
    });
    expect(await sha256File(reconstructedV2Path)).toBe(await sha256File(canonicalV2.path));

    const objectsDeleted = await deleteS3Objects(
      config,
      afterV2.map((object) => object.key)
    );
    expect(objectsDeleted).toBe(afterV2.length);
    expect(await listS3Objects(config)).toEqual([]);

    console.log(
      `CAS_S3_E2E_RESULT roundTripSha256=match uncompressedChunks=yes v1Objects=${afterV1.length} v1StoredBytes=${v1StoredBytes} v2DeltaObjects=${v2DeltaObjects} v2DeltaBytes=${v2DeltaBytes} objectsDeleted=${objectsDeleted}`
    );
  });
});
