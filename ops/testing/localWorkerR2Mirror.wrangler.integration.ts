import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CasConfig } from '../storage-core/config';
import { createS3Bucket, putS3Object } from '../storage-core/s3Control';
import { loadStorageRoleConfig, MINIO_IMAGE } from './disposableStorageHarness';
import {
  type LocalWorkerR2Mirror,
  type MirroredStorageRole,
  startLocalWorkerR2Mirror,
} from './localWorkerR2Mirror';
import { type LocalWranglerWorker, startLocalWranglerWorker } from './localWranglerWorker';
import { waitForMinioReady } from './minioReadiness';

// Round-trip check for the local dev storage coupling: objects written to MinIO must reach
// the R2-native workers through the mirror and the shared wrangler persistence root.

const execFileAsync = promisify(execFile);
const WORKER_CONFIG = resolve('services/materialization-source-worker/wrangler.jsonc');

async function workerText(
  worker: LocalWranglerWorker,
  path: string
): Promise<{ body: string; status: number }> {
  const response = await fetch(new URL(path, worker.baseUrl));
  return { body: await response.text(), status: response.status };
}

async function main(): Promise<void> {
  const runId = randomBytes(6).toString('hex');
  const containerName = `yucp-r2-mirror-test-${runId}`;
  const rootAccessKey = `yucp-root-${randomBytes(5).toString('hex')}`;
  const rootSecretKey = randomBytes(24).toString('base64url');
  const persistPath = await mkdtemp(join(tmpdir(), 'yucp-r2-mirror-persist-'));
  let containerStarted = false;
  let mirror: LocalWorkerR2Mirror | undefined;
  let worker: LocalWranglerWorker | undefined;
  try {
    await execFileAsync(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        containerName,
        '--env',
        'MINIO_ROOT_USER',
        '--env',
        'MINIO_ROOT_PASSWORD',
        '--publish',
        '127.0.0.1::9000',
        '--tmpfs',
        '/data',
        MINIO_IMAGE,
        'server',
        '/data',
        '--address',
        ':9000',
      ],
      {
        env: {
          ...process.env,
          MINIO_ROOT_PASSWORD: rootSecretKey,
          MINIO_ROOT_USER: rootAccessKey,
        },
        windowsHide: true,
      }
    );
    containerStarted = true;
    const portOutput = await execFileAsync('docker', ['port', containerName, '9000/tcp'], {
      windowsHide: true,
    });
    const minioPort = portOutput.stdout.match(/:(\d+)\s*$/m)?.[1];
    assert.ok(minioPort, 'Docker returned no published MinIO port');
    const endpoint = `http://127.0.0.1:${minioPort}`;
    await waitForMinioReady({ endpoint });

    const buckets = {} as Record<MirroredStorageRole, CasConfig>;
    for (const role of ['common', 'metadata', 'protected'] as const) {
      buckets[role] = loadStorageRoleConfig({
        accessKeyId: rootAccessKey,
        bucket: `yucp-${runId}-${role}`,
        endpoint,
        secretAccessKey: rootSecretKey,
      });
      await createS3Bucket(buckets[role]);
    }
    await putS3Object({
      body: 'seeded common chunk',
      config: buckets.common,
      contentType: 'application/octet-stream',
      key: 'chunks/aa/seeded-chunk',
    });
    await putS3Object({
      body: '{"seeded":true}',
      config: buckets.metadata,
      contentType: 'application/json',
      key: 'indexes/seeded-index',
    });

    mirror = await startLocalWorkerR2Mirror({
      buckets,
      configPath: WORKER_CONFIG,
      intervalMs: 250,
      persistPath,
    });
    assert.ok((await mirror.copyOnce()) >= 0);

    process.env.YUCP_WRANGLER_PERSIST_PATH = persistPath;
    worker = await startLocalWranglerWorker({
      config: WORKER_CONFIG,
      entrypoint: resolve('ops/test-fixtures/r2-read-worker.mjs'),
      port: 0,
      vars: {},
    });

    const seededChunk = await workerText(worker, 'COMMON_BUCKET/chunks/aa/seeded-chunk');
    assert.deepEqual(seededChunk, { body: 'seeded common chunk', status: 200 });
    const seededIndex = await workerText(worker, 'METADATA_BUCKET/indexes/seeded-index');
    assert.deepEqual(seededIndex, { body: '{"seeded":true}', status: 200 });

    // A publish that lands in MinIO while the worker is already serving must become
    // visible through the worker's R2 binding after the next mirror pass.
    await putS3Object({
      body: '{"live":true}',
      config: buckets.metadata,
      contentType: 'application/json',
      key: 'indexes/live-index',
    });
    await putS3Object({
      body: 'live protected chunk',
      config: buckets.protected,
      contentType: 'application/octet-stream',
      key: 'chunks/bb/live-chunk',
    });
    await mirror.copyOnce();
    const liveIndex = await workerText(worker, 'METADATA_BUCKET/indexes/live-index');
    assert.deepEqual(liveIndex, { body: '{"live":true}', status: 200 });
    const liveChunk = await workerText(worker, 'PROTECTED_BUCKET/chunks/bb/live-chunk');
    assert.deepEqual(liveChunk, { body: 'live protected chunk', status: 200 });

    const missing = await workerText(worker, 'METADATA_BUCKET/indexes/never-written');
    assert.equal(missing.status, 404);

    process.stdout.write('Local worker R2 mirror integration passed.\n');
  } finally {
    delete process.env.YUCP_WRANGLER_PERSIST_PATH;
    await worker?.stop();
    await mirror?.stop();
    if (containerStarted) {
      await execFileAsync('docker', ['rm', '--force', containerName], {
        windowsHide: true,
      }).catch(() => undefined);
    }
    await rm(persistPath, { force: true, recursive: true });
  }
}

void main();
