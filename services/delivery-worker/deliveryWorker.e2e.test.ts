import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { unstable_dev } from 'wrangler';
import {
  Catalog,
  type CatalogDatabase,
  openCatalogDatabase,
  runCatalogMigrations,
} from '../../ops/catalog';
import {
  assembleVersion,
  beginVersion,
  promoteVersion,
  resolvePipelineCasIndexId,
} from '../../ops/ingest-pipeline/ingestPipeline';
import { canonicalizeArtifact } from '../../ops/storage-core/canonicalizer';
import { loadCasConfig } from '../../ops/storage-core/config';
import {
  createDeliveryManifest,
  DESYNC_STORAGE_FORMAT_VERSION,
  deliveryManifestObjectId,
  parseDeliveryManifest,
} from '../../ops/storage-core/deliveryManifest';
import { signDeliveryUrl } from '../../ops/storage-core/deliverySigning';
import { inspectDesyncIndex, s3CasStore, verifyDesyncCli } from '../../ops/storage-core/desyncCas';
import { runCommand } from '../../ops/storage-core/process';
import {
  createS3Bucket,
  deleteS3Objects,
  getS3Object,
  listS3Objects,
  putS3Object,
} from '../../ops/storage-core/s3Control';
import { waitForPostgres } from '../../ops/testing/postgresReadiness';
import { createUnityPackageFixture } from '../../ops/testing/unityPackageFixture';

const MINIO_IMAGE = 'minio/minio:RELEASE.2025-09-07T16-13-09Z';
const POSTGRES_IMAGE = 'postgres:17-alpine';
const TEST_CONTAINER_LABEL = 'com.yucp.test=delivery';

type FetchCounts = {
  chunkGets: number;
  manifestGets: number;
  totalGets: number;
};

type AuditReceiver = {
  port: number;
  stop: () => Promise<void>;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function countAuditEvent(
  value: unknown,
  counts: FetchCounts,
  input: { bucket: string; chunkPrefix: string; indexPrefix: string }
): void {
  const events = Array.isArray(value) ? value : [value];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) {
      continue;
    }
    const api = Reflect.get(event, 'api');
    if (typeof api !== 'object' || api === null || Reflect.get(api, 'name') !== 'GetObject') {
      continue;
    }
    if (Reflect.get(api, 'bucket') !== input.bucket) {
      continue;
    }
    const object = Reflect.get(api, 'object');
    if (typeof object !== 'string') {
      continue;
    }
    counts.totalGets += 1;
    if (object.startsWith(input.chunkPrefix)) {
      counts.chunkGets += 1;
    }
    if (object.startsWith(input.indexPrefix)) {
      counts.manifestGets += 1;
    }
  }
}

async function startAuditReceiver(
  counts: FetchCounts,
  input: { bucket: string; chunkPrefix: string; indexPrefix: string }
): Promise<AuditReceiver> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/audit') {
      response.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    request.on('data', (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > 1024 * 1024) {
        request.destroy(new Error('MinIO audit event exceeded 1 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        countAuditEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')), counts, input);
        response.writeHead(200).end();
      } catch {
        response.writeHead(400).end();
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '0.0.0.0', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Local MinIO audit receiver did not bind a TCP port');
  }

  return {
    port: address.port,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}

async function waitForAuditIdle(counts: FetchCounts): Promise<void> {
  const deadline = Date.now() + 5000;
  let previous = -1;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    if (counts.totalGets === previous) {
      stableChecks += 1;
      if (stableChecks >= 5) {
        return;
      }
    } else {
      previous = counts.totalGets;
      stableChecks = 0;
    }
    await delay(50);
  }
  throw new Error('MinIO audit events did not become idle within 5 seconds');
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

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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
    await delay(250);
  }
  throw new Error('Throwaway MinIO did not become ready within 60 seconds');
}

async function publishedPort(containerId: string, containerPort: string): Promise<string> {
  const output = (await runCommand('docker', ['port', containerId, containerPort])).stdout.trim();
  const match = /127\.0\.0\.1:(\d+)$/m.exec(output);
  if (!match?.[1]) {
    throw new Error(`Docker did not publish ${containerPort} on a random local port`);
  }
  return match[1];
}

async function removeContainer(containerId: string | undefined): Promise<void> {
  if (!containerId) {
    return;
  }
  try {
    await runCommand('docker', ['rm', '--force', containerId]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('No such container')) {
      throw error;
    }
  }
}

async function runCleanup(errors: unknown[], cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
}

async function removeLabeledContainers(): Promise<void> {
  const remaining = await runCommand('docker', [
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=${TEST_CONTAINER_LABEL}`,
  ]);
  const containerIds = remaining.stdout.trim().split(/\s+/).filter(Boolean);
  for (const containerId of containerIds) {
    await removeContainer(containerId);
  }
}

const sensitiveValues: string[] = [];

async function main(): Promise<void> {
  await runCommand('docker', ['version', '--format', '{{.Server.Version}}']);
  await runCommand('bun', ['x', 'wrangler', '--version']);
  await verifyDesyncCli();
  await removeLabeledContainers();

  const databaseName = 'delivery_test';
  const databasePassword = randomBytes(24).toString('hex');
  const rootAccessKey = `root-${randomBytes(12).toString('hex')}`;
  const rootSecretKey = randomBytes(32).toString('hex');
  const readonlyAccessKey = `readonly-${randomBytes(12).toString('hex')}`;
  const readonlySecretKey = randomBytes(32).toString('hex');
  const hmacKey = randomBytes(32).toString('hex');
  sensitiveValues.push(
    databasePassword,
    rootAccessKey,
    rootSecretKey,
    readonlyAccessKey,
    readonlySecretKey,
    hmacKey
  );
  const bucket = `delivery-${randomBytes(8).toString('hex')}`;
  const postgresName = `yucp-delivery-postgres-${randomUUID()}`;
  const minioName = `yucp-delivery-minio-${randomUUID()}`;
  let postgresContainer: string | undefined;
  let minioContainer: string | undefined;
  let scratchPath: string | undefined;
  let sql: CatalogDatabase | undefined;
  let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
  let auditReceiver: AuditReceiver | undefined;
  const cleanupErrors: unknown[] = [];

  try {
    postgresContainer = (
      await runCommand('docker', [
        'run',
        '--detach',
        '--rm',
        '--name',
        postgresName,
        '--label',
        TEST_CONTAINER_LABEL,
        '--env',
        `POSTGRES_PASSWORD=${databasePassword}`,
        '--env',
        `POSTGRES_DB=${databaseName}`,
        '--publish',
        '127.0.0.1::5432',
        '--tmpfs',
        '/var/lib/postgresql/data',
        POSTGRES_IMAGE,
      ])
    ).stdout.trim();
    if (!postgresContainer) {
      throw new Error('Docker did not return the throwaway PostgreSQL container ID');
    }
    await waitForPostgres({
      containerName: postgresContainer,
      databaseName,
      runDocker: (args) => runCommand('docker', args),
    });
    const postgresPort = await publishedPort(postgresContainer, '5432/tcp');
    sql = openCatalogDatabase(
      `postgres://postgres:${databasePassword}@127.0.0.1:${postgresPort}/${databaseName}`
    );
    await runCatalogMigrations(sql);
    const catalog = new Catalog(sql);

    const counts: FetchCounts = { chunkGets: 0, manifestGets: 0, totalGets: 0 };
    auditReceiver = await startAuditReceiver(counts, {
      bucket,
      chunkPrefix: 'chunks/',
      indexPrefix: 'indexes/',
    });

    minioContainer = (
      await runCommand('docker', [
        'run',
        '--detach',
        '--rm',
        '--name',
        minioName,
        '--label',
        TEST_CONTAINER_LABEL,
        '--add-host',
        'host.docker.internal:host-gateway',
        '--publish',
        '127.0.0.1::9000',
        '--env',
        `MINIO_ROOT_USER=${rootAccessKey}`,
        '--env',
        `MINIO_ROOT_PASSWORD=${rootSecretKey}`,
        // MinIO audit webhook contract:
        // https://docs.min.io/aistor/reference/aistor-server/settings/metrics-and-logging/webhook-audit-logs/
        '--env',
        'MINIO_AUDIT_WEBHOOK_ENABLE_DELIVERY=on',
        '--env',
        `MINIO_AUDIT_WEBHOOK_ENDPOINT_DELIVERY=http://host.docker.internal:${auditReceiver.port}/audit`,
        MINIO_IMAGE,
        'server',
        '/data',
        '--address',
        ':9000',
      ])
    ).stdout.trim();
    if (!minioContainer) {
      throw new Error('Docker did not return the throwaway MinIO container ID');
    }
    const minioPort = await publishedPort(minioContainer, '9000/tcp');
    const endpoint = `http://127.0.0.1:${minioPort}`;
    await waitForMinio(endpoint);

    const casConfig = loadCasConfig({
      CAS_S3_ENDPOINT: endpoint,
      CAS_S3_REGION: 'us-east-1',
      CAS_S3_BUCKET: bucket,
      CAS_S3_ACCESS_KEY_ID: rootAccessKey,
      CAS_S3_SECRET_ACCESS_KEY: rootSecretKey,
    });
    await createS3Bucket(casConfig);
    await runCommand('docker', [
      'exec',
      minioContainer,
      'mc',
      'alias',
      'set',
      'local',
      'http://127.0.0.1:9000',
      rootAccessKey,
      rootSecretKey,
      '--api',
      'S3v4',
    ]);
    await runCommand('docker', [
      'exec',
      minioContainer,
      'mc',
      'admin',
      'user',
      'add',
      'local',
      readonlyAccessKey,
      readonlySecretKey,
    ]);
    await runCommand('docker', [
      'exec',
      minioContainer,
      'mc',
      'admin',
      'policy',
      'attach',
      'local',
      'readonly',
      '--user',
      readonlyAccessKey,
    ]);

    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-delivery-e2e-'));
    const rawPath = join(scratchPath, 'delivery-fixture.unitypackage');
    await createUnityPackageFixture({
      byteScale: 0.125,
      outputPath: rawPath,
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      treePath: join(scratchPath, 'fixture-tree'),
      versionSeed: 'delivery-version',
    });
    const canonicalPath = join(scratchPath, 'delivery-fixture.canonical');
    const canonical = await canonicalizeArtifact({
      inputPath: rawPath,
      outputPath: canonicalPath,
    });
    const canonicalBytes = await readFile(canonical.path);
    const canonicalSha256 = await sha256File(canonical.path);

    const uploading = await beginVersion({
      catalog,
      packageId: 'delivery-package',
      version: '1.0.0',
    });
    const assembled = await assembleVersion({
      catalog,
      inputPath: rawPath,
      store: s3CasStore(casConfig),
      versionId: uploading.id,
    });
    assert.equal(assembled.state, 'ASSEMBLED');
    assert.equal(assembled.canonicalSha256, canonicalSha256);
    const ready = await promoteVersion({
      catalog,
      store: s3CasStore(casConfig),
      versionId: assembled.id,
    });
    assert.equal(ready.state, 'READY');

    const secondRawPath = join(scratchPath, 'delivery-fixture-v2.unitypackage');
    await createUnityPackageFixture({
      byteScale: 0.125,
      outputPath: secondRawPath,
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      treePath: join(scratchPath, 'fixture-tree-v2'),
      versionSeed: 'delivery-version-v2',
    });
    const secondCanonicalPath = join(scratchPath, 'delivery-fixture-v2.canonical');
    const secondCanonical = await canonicalizeArtifact({
      inputPath: secondRawPath,
      outputPath: secondCanonicalPath,
    });
    const secondCanonicalBytes = await readFile(secondCanonical.path);
    const secondCanonicalSha256 = await sha256File(secondCanonical.path);
    const secondUploading = await beginVersion({
      catalog,
      packageId: 'delivery-package',
      version: '2.0.0',
    });
    const secondAssembled = await assembleVersion({
      catalog,
      inputPath: secondRawPath,
      store: s3CasStore(casConfig),
      versionId: secondUploading.id,
    });
    assert.equal(secondAssembled.state, 'ASSEMBLED');
    assert.equal(secondAssembled.canonicalSha256, secondCanonicalSha256);
    const secondReady = await promoteVersion({
      catalog,
      store: s3CasStore(casConfig),
      versionId: secondAssembled.id,
    });
    assert.equal(secondReady.state, 'READY');

    const firstManifestResponse = await getS3Object(
      casConfig,
      `${casConfig.indexPrefix}${deliveryManifestObjectId(assembled.id)}`
    );
    const firstManifest = parseDeliveryManifest(JSON.parse(await firstManifestResponse.text()));
    const secondManifestResponse = await getS3Object(
      casConfig,
      `${casConfig.indexPrefix}${deliveryManifestObjectId(secondAssembled.id)}`
    );
    const secondManifest = parseDeliveryManifest(JSON.parse(await secondManifestResponse.text()));
    const firstChunkIds = new Set(firstManifest.chunks.map((chunk) => chunk.id));
    const secondChunkIds = new Set(secondManifest.chunks.map((chunk) => chunk.id));
    const sharedChunkIds = new Set(
      [...secondChunkIds].filter((chunkId) => firstChunkIds.has(chunkId))
    );
    const newChunkIds = new Set(
      [...secondChunkIds].filter((chunkId) => !firstChunkIds.has(chunkId))
    );
    assert.ok(sharedChunkIds.size > 0, 'The two versions must share at least one CAS chunk');
    assert.ok(newChunkIds.size > 0, 'The second version must contain at least one new CAS chunk');
    await waitForAuditIdle(counts);

    worker = await unstable_dev(resolve('services/delivery-worker/src/index.ts'), {
      config: resolve('services/delivery-worker/wrangler.toml'),
      experimental: {
        disableDevRegistry: true,
        disableExperimentalWarning: true,
        forceLocal: true,
        testMode: true,
        watch: false,
      },
      inspect: false,
      ip: '127.0.0.1',
      local: true,
      logLevel: 'none',
      persist: false,
      vars: {
        CAS_S3_ENDPOINT: endpoint,
        CAS_S3_REGION: casConfig.region,
        CAS_S3_BUCKET: casConfig.bucket,
        CAS_S3_READONLY_ACCESS_KEY_ID: readonlyAccessKey,
        CAS_S3_READONLY_SECRET_ACCESS_KEY: readonlySecretKey,
        CAS_INDEX_PREFIX: casConfig.indexPrefix,
        CAS_CHUNK_PREFIX: casConfig.chunkPrefix,
        DELIVERY_HMAC_KEY: hmacKey,
        STORAGE_FORMAT_VERSION: DESYNC_STORAGE_FORMAT_VERSION,
      },
    });
    const activeWorker = worker;
    const workerUrl = new URL(`http://127.0.0.1:${worker.port}`);

    const oversizedVersionId = `oversized-${randomUUID()}`;
    const oversizedManifest = JSON.stringify(
      createDeliveryManifest({
        storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
        versionId: oversizedVersionId,
        totalSize: 16_000,
        contentType: 'application/octet-stream',
        chunkAvgKib: 64,
        chunks: Array.from({ length: 16_000 }, () => ({ id: 'a'.repeat(64), size: 1 })),
      })
    );
    assert.ok(Buffer.byteLength(oversizedManifest) > 1024 * 1024);
    await putS3Object({
      body: oversizedManifest,
      config: casConfig,
      contentType: 'application/json',
      key: `${casConfig.indexPrefix}${deliveryManifestObjectId(oversizedVersionId)}`,
    });
    const oversizedSigned = await signDeliveryUrl({
      expiresAt: Date.now() + 5 * 60_000,
      key: hmacKey,
      versionId: oversizedVersionId,
    });
    const oversizedDeliveryUrl = new URL(`/d/${encodeURIComponent(oversizedVersionId)}`, workerUrl);
    oversizedDeliveryUrl.searchParams.set('exp', oversizedSigned.exp);
    oversizedDeliveryUrl.searchParams.set('sig', oversizedSigned.sig);
    const oversizedResponse = await fetch(oversizedDeliveryUrl);
    assert.equal(oversizedResponse.status, 422);
    assert.match(await oversizedResponse.text(), /use the importer path/i);

    const nonReadyRawPath = join(scratchPath, 'non-ready-delivery.bin');
    await writeFile(nonReadyRawPath, randomBytes(256 * 1024));
    const nonReadyUploading = await beginVersion({
      catalog,
      packageId: 'delivery-package',
      version: '3.0.0',
    });
    const nonReady = await assembleVersion({
      catalog,
      inputPath: nonReadyRawPath,
      store: s3CasStore(casConfig),
      versionId: nonReadyUploading.id,
    });
    assert.equal(nonReady.state, 'ASSEMBLED');
    const nonReadyManifestKey = `${casConfig.indexPrefix}${deliveryManifestObjectId(nonReady.id)}`;
    assert.deepEqual(await listS3Objects(casConfig, nonReadyManifestKey), []);
    const nonReadySigned = await signDeliveryUrl({
      expiresAt: Date.now() + 5 * 60_000,
      key: hmacKey,
      versionId: nonReady.id,
    });
    const nonReadyDeliveryUrl = new URL(`/d/${encodeURIComponent(nonReady.id)}`, workerUrl);
    nonReadyDeliveryUrl.searchParams.set('exp', nonReadySigned.exp);
    nonReadyDeliveryUrl.searchParams.set('sig', nonReadySigned.sig);
    const nonReadyDeliveryResponse = await fetch(nonReadyDeliveryUrl);
    assert.equal(nonReadyDeliveryResponse.status, 404);
    await nonReadyDeliveryResponse.arrayBuffer();

    const failedRawPath = join(scratchPath, 'failed-delivery.bin');
    await writeFile(failedRawPath, randomBytes(512 * 1024));
    const failedUploading = await beginVersion({
      catalog,
      packageId: 'delivery-package',
      version: '4.0.0',
    });
    const failedAssembled = await assembleVersion({
      catalog,
      inputPath: failedRawPath,
      store: s3CasStore(casConfig),
      versionId: failedUploading.id,
    });
    if (!failedAssembled.casIndexId) {
      throw new Error('Failed-version fixture did not persist a CAS index ID');
    }
    const failedChunks = await inspectDesyncIndex({
      indexId: resolvePipelineCasIndexId(s3CasStore(casConfig), failedAssembled.casIndexId),
      store: s3CasStore(casConfig),
    });
    const failedChunk = failedChunks[0];
    if (!failedChunk) {
      throw new Error('Failed-version fixture did not produce a CAS chunk');
    }
    await deleteS3Objects(casConfig, [
      `${casConfig.chunkPrefix}${failedChunk.id.slice(0, 4)}/${failedChunk.id}`,
    ]);
    const failedManifestKey = `${casConfig.indexPrefix}${deliveryManifestObjectId(failedAssembled.id)}`;
    await putS3Object({
      body: '{"stale":true}',
      config: casConfig,
      contentType: 'application/json',
      key: failedManifestKey,
    });
    await assert.rejects(
      promoteVersion({
        catalog,
        store: s3CasStore(casConfig),
        versionId: failedAssembled.id,
      })
    );
    assert.equal((await catalog.getVersion(failedAssembled.id))?.state, 'FAILED');
    assert.deepEqual(await listS3Objects(casConfig, failedManifestKey), []);
    const failedSigned = await signDeliveryUrl({
      expiresAt: Date.now() + 5 * 60_000,
      key: hmacKey,
      versionId: failedAssembled.id,
    });
    const failedDeliveryUrl = new URL(`/d/${encodeURIComponent(failedAssembled.id)}`, workerUrl);
    failedDeliveryUrl.searchParams.set('exp', failedSigned.exp);
    failedDeliveryUrl.searchParams.set('sig', failedSigned.sig);
    const failedDeliveryResponse = await fetch(failedDeliveryUrl);
    assert.equal(failedDeliveryResponse.status, 404);
    await failedDeliveryResponse.arrayBuffer();

    const signed = await signDeliveryUrl({
      expiresAt: Date.now() + 5 * 60_000,
      key: hmacKey,
      versionId: ready.id,
    });
    const deliveryUrl = new URL(`/d/${encodeURIComponent(ready.id)}`, workerUrl);
    deliveryUrl.searchParams.set('exp', signed.exp);
    deliveryUrl.searchParams.set('sig', signed.sig);

    const firstChunksBefore = counts.chunkGets;
    const firstResponse = await fetch(deliveryUrl);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get('content-length'), canonicalBytes.byteLength.toString());
    assert.equal(firstResponse.headers.get('content-type'), 'application/octet-stream');
    const firstBytes = new Uint8Array(await firstResponse.arrayBuffer());
    await waitForAuditIdle(counts);
    const firstOriginChunkGets = counts.chunkGets - firstChunksBefore;
    assert.ok(firstOriginChunkGets > 0);
    assert.equal(sha256Bytes(firstBytes), canonicalSha256);
    assert.deepEqual(firstBytes, new Uint8Array(canonicalBytes));

    const secondSigned = await signDeliveryUrl({
      expiresAt: Date.now() + 10 * 60_000,
      key: hmacKey,
      versionId: ready.id,
    });
    assert.notEqual(secondSigned.exp, signed.exp);
    assert.notEqual(secondSigned.sig, signed.sig);
    const secondDeliveryUrl = new URL(deliveryUrl);
    secondDeliveryUrl.searchParams.set('exp', secondSigned.exp);
    secondDeliveryUrl.searchParams.set('sig', secondSigned.sig);

    const secondChunksBefore = counts.chunkGets;
    const secondResponse = await fetch(secondDeliveryUrl);
    assert.equal(secondResponse.status, 200);
    const secondBytes = new Uint8Array(await secondResponse.arrayBuffer());
    await waitForAuditIdle(counts);
    const secondOriginChunkGets = counts.chunkGets - secondChunksBefore;
    assert.equal(secondOriginChunkGets, 0);
    assert.equal(sha256Bytes(secondBytes), canonicalSha256);

    const secondVersionSigned = await signDeliveryUrl({
      expiresAt: Date.now() + 15 * 60_000,
      key: hmacKey,
      versionId: secondReady.id,
    });
    const secondVersionDeliveryUrl = new URL(`/d/${encodeURIComponent(secondReady.id)}`, workerUrl);
    secondVersionDeliveryUrl.searchParams.set('exp', secondVersionSigned.exp);
    secondVersionDeliveryUrl.searchParams.set('sig', secondVersionSigned.sig);

    const corruptChunk = secondManifest.chunks.find((chunk) => newChunkIds.has(chunk.id));
    if (!corruptChunk) {
      throw new Error('The second version did not contain a unique chunk to corrupt');
    }
    const corruptChunkKey = `${casConfig.chunkPrefix}${corruptChunk.id.slice(0, 4)}/${corruptChunk.id}`;
    const originalChunk = new Uint8Array(
      await (await getS3Object(casConfig, corruptChunkKey)).arrayBuffer()
    );
    const corruptBytes = originalChunk.slice();
    corruptBytes[0] = (corruptBytes[0] ?? 0) ^ 0xff;
    try {
      await putS3Object({
        body: corruptBytes,
        config: casConfig,
        contentType: 'application/octet-stream',
        key: corruptChunkKey,
      });
      await assert.rejects(async () => {
        const corruptResponse = await activeWorker.fetch(secondVersionDeliveryUrl);
        await corruptResponse.arrayBuffer();
      });
    } finally {
      await putS3Object({
        body: originalChunk,
        config: casConfig,
        contentType: 'application/octet-stream',
        key: corruptChunkKey,
      });
    }
    const secondVersionChunksBefore = counts.chunkGets;
    const secondVersionResponse = await fetch(secondVersionDeliveryUrl);
    assert.equal(secondVersionResponse.status, 200);
    assert.equal(
      secondVersionResponse.headers.get('content-length'),
      secondCanonicalBytes.byteLength.toString()
    );
    const secondVersionBytes = new Uint8Array(await secondVersionResponse.arrayBuffer());
    await waitForAuditIdle(counts);
    const secondVersionOriginChunkGets = counts.chunkGets - secondVersionChunksBefore;
    assert.equal(secondVersionOriginChunkGets, newChunkIds.size);
    assert.equal(sha256Bytes(secondVersionBytes), secondCanonicalSha256);
    assert.deepEqual(secondVersionBytes, new Uint8Array(secondCanonicalBytes));

    const storageBeforeAuthFailures = counts.totalGets;
    const badUrl = new URL(deliveryUrl);
    badUrl.searchParams.set('sig', `${signed.sig[0] === '0' ? '1' : '0'}${signed.sig.slice(1)}`);
    const badResponse = await fetch(badUrl);
    assert.equal(badResponse.status, 403);
    assert.equal(badResponse.headers.get('x-delivery-storage-fetches'), '0');
    await badResponse.arrayBuffer();

    const expired = await signDeliveryUrl({
      expiresAt: Date.now() - 60_000,
      key: hmacKey,
      versionId: ready.id,
    });
    const expiredUrl = new URL(deliveryUrl);
    expiredUrl.searchParams.set('exp', expired.exp);
    expiredUrl.searchParams.set('sig', expired.sig);
    const expiredResponse = await fetch(expiredUrl);
    assert.equal(expiredResponse.status, 403);
    assert.equal(expiredResponse.headers.get('x-delivery-storage-fetches'), '0');
    await expiredResponse.arrayBuffer();
    await waitForAuditIdle(counts);
    const authFailureStorageGets = counts.totalGets - storageBeforeAuthFailures;
    assert.equal(authFailureStorageGets, 0);

    const rangeStart = Math.floor(canonicalBytes.byteLength / 2) - 4096;
    const rangeEnd = rangeStart + 128 * 1024 - 1;
    const rangeResponse = await fetch(deliveryUrl, {
      headers: { range: `bytes=${rangeStart}-${rangeEnd}` },
    });
    assert.equal(rangeResponse.status, 206);
    assert.equal(
      rangeResponse.headers.get('content-range'),
      `bytes ${rangeStart}-${rangeEnd}/${canonicalBytes.byteLength}`
    );
    const rangeBytes = new Uint8Array(await rangeResponse.arrayBuffer());
    assert.deepEqual(rangeBytes, new Uint8Array(canonicalBytes.subarray(rangeStart, rangeEnd + 1)));

    console.log('DELIVERY_E2E_RESULT');
    console.log(
      `byte-exact=yes sha256=match bytes=${canonicalBytes.byteLength} origin-chunks=${firstOriginChunkGets}`
    );
    console.log(
      `cross-signature-cache-hit=yes exp-different=yes sig-different=yes first-origin-chunk-gets=${firstOriginChunkGets} second-origin-chunk-gets=${secondOriginChunkGets}`
    );
    console.log(
      `cross-version-shared-chunks-cache-hit=yes shared-chunks=${sharedChunkIds.size} new-chunks=${newChunkIds.size} origin-chunk-gets=${secondVersionOriginChunkGets}`
    );
    console.log('corrupt-chunk-rejected=yes');
    console.log('non-ready-manifest=absent non-ready-delivery=404');
    console.log('failed-version-manifest-cleanup=yes failed-version-delivery=404');
    console.log('oversized-manifest=422 importer-guidance=yes');
    console.log(
      `bad-sig-403=yes expired-sig-403=yes auth-storage-fetches=${authFailureStorageGets}`
    );
    console.log(`range=yes start=${rangeStart} end=${rangeEnd} bytes=${rangeBytes.byteLength}`);
  } finally {
    await runCleanup(cleanupErrors, async () => worker?.stop());
    await runCleanup(cleanupErrors, async () => sql?.end({ timeout: 1 }));
    await runCleanup(cleanupErrors, async () => removeContainer(minioContainer));
    await runCleanup(cleanupErrors, async () => removeContainer(postgresContainer));
    await runCleanup(cleanupErrors, async () => auditReceiver?.stop());
    if (scratchPath) {
      const path = scratchPath;
      assertScratchPath(path);
      await runCleanup(cleanupErrors, async () => rm(path, { force: true, recursive: true }));
    }
    await runCleanup(cleanupErrors, removeLabeledContainers);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Local delivery e2e teardown failed');
  }
}

main().catch((error: unknown) => {
  let message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  for (const value of sensitiveValues) {
    message = message.replaceAll(value, '[REDACTED]');
  }
  console.error(`DELIVERY_E2E_FAILED\n${message}`);
  process.exitCode = 1;
});
