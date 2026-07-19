import { expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { normalizeEmail, sha256Hex } from '@yucp/shared/crypto';
import { unzipSync, zipSync } from 'fflate';
import { api, internal } from '../../../../convex/_generated/api';
import {
  Catalog,
  type CatalogDatabase,
  createConvexCatalogPublish,
  openCatalogDatabase,
  runCatalogMigrations,
} from '../../../../ops/catalog';
import {
  API_SECRET,
  BACKEND_URL,
  INTERNAL_SERVICE_AUTH_SECRET,
  SITE_URL,
} from '../../../../ops/convex-real/config';
import {
  assembleVersion,
  beginVersion,
  promoteVersion,
} from '../../../../ops/ingest-pipeline/ingestPipeline';
import { canonicalizeArtifact } from '../../../../ops/storage-core/canonicalizer';
import { loadCasConfig } from '../../../../ops/storage-core/config';
import {
  DESYNC_CHUNK_AVG_KIB,
  DESYNC_STORAGE_FORMAT_VERSION,
  deliveryManifestObjectId,
  parseDeliveryManifest,
} from '../../../../ops/storage-core/deliveryManifest';
import { signDeliveryUrl } from '../../../../ops/storage-core/deliverySigning';
import { s3CasStore, verifyDesyncCli } from '../../../../ops/storage-core/desyncCas';
import { runCommand } from '../../../../ops/storage-core/process';
import { createS3Bucket, getS3Object } from '../../../../ops/storage-core/s3Control';
import { waitForMinioReady } from '../../../../ops/testing/minioReadiness';
import { waitForPostgres } from '../../../../ops/testing/postgresReadiness';
import { createAuth } from '../../src/auth';
import { createApiServiceActorBinding } from '../../src/lib/apiActor';
import { createConnectUserProductAccessRoutes } from '../../src/routes/connectUserProductAccess';
import { createVpmRoutes } from '../../src/routes/vpm';
import {
  createBetterAuthSession,
  createBetterAuthUser,
  getRealApiHarness,
  installRealApiHarness,
  seedCreatorProfile,
  seedProductCatalog,
  seedSubject,
} from './support/realApiHarness';

const MINIO_IMAGE =
  'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e'; // minio/minio:RELEASE.2025-09-07T16-13-09Z
const POSTGRES_IMAGE =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'; // postgres:17-alpine
const TEST_CONTAINER_LABEL = 'com.yucp.test=buyer-delivery-flow';
const API_BASE_URL = 'http://127.0.0.1:3001';
const PACKAGE_ID = 'club.yucp.buyer-flow';
const FIRST_PACKAGE_VERSION = '1.0.0';
const SECOND_PACKAGE_VERSION = '2.0.0';
const OTHER_PACKAGE_ID = 'club.yucp.other-creator';
const OTHER_PACKAGE_VERSION = '1.0.0';
const PRODUCT_SLUG = 'buyer-flow-package';

type FetchCounts = {
  chunkGets: number;
  totalGets: number;
};

type AuditReceiver = {
  port: number;
  stop: () => Promise<void>;
};

type DeliveryWorkerProcess = {
  port: number;
  stop: () => Promise<void>;
};

type ReadyOutboxRow = {
  aggregate_id: string;
  created_at: Date;
  event_type: string;
  id: string;
  payload: Record<string, unknown>;
};

type VpmIndex = {
  packages: Record<
    string,
    {
      versions: Record<string, { url: string }>;
    }
  >;
};

installRealApiHarness();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function deterministicBytes(seed: string, byteLength: number): Buffer {
  return createHash('shake256', { outputLength: byteLength }).update(seed).digest();
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID()}`;
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

async function publishedPort(containerId: string, containerPort: string): Promise<string> {
  const output = (await runCommand('docker', ['port', containerId, containerPort])).stdout.trim();
  const match = /127\.0\.0\.1:(\d+)$/m.exec(output);
  if (!match?.[1]) {
    throw new Error(`Docker did not publish ${containerPort} on a random local port`);
  }
  return match[1];
}

async function removeContainer(containerId: string | undefined): Promise<void> {
  if (!containerId) return;
  try {
    await runCommand('docker', ['rm', '--force', containerId]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('No such container')) {
      throw error;
    }
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

async function runCleanup(errors: unknown[], cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
}

function countAuditEvent(
  value: unknown,
  counts: FetchCounts,
  input: { bucket: string; chunkPrefix: string }
): void {
  const events = Array.isArray(value) ? value : [value];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const apiEvent = Reflect.get(event, 'api');
    if (
      typeof apiEvent !== 'object' ||
      apiEvent === null ||
      Reflect.get(apiEvent, 'name') !== 'GetObject' ||
      Reflect.get(apiEvent, 'bucket') !== input.bucket
    ) {
      continue;
    }
    const object = Reflect.get(apiEvent, 'object');
    if (typeof object !== 'string') continue;
    counts.totalGets += 1;
    if (object.startsWith(input.chunkPrefix)) {
      counts.chunkGets += 1;
    }
  }
}

async function startAuditReceiver(
  counts: FetchCounts,
  input: { bucket: string; chunkPrefix: string }
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
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}

async function waitForOriginChunkFetches(counts: FetchCounts, before: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (counts.chunkGets > before) {
      let stableCount = counts.chunkGets;
      let stableChecks = 0;
      while (stableChecks < 5 && Date.now() < deadline) {
        await delay(50);
        if (counts.chunkGets === stableCount) {
          stableChecks += 1;
        } else {
          stableCount = counts.chunkGets;
          stableChecks = 0;
        }
      }
      return counts.chunkGets - before;
    }
    await delay(50);
  }
  throw new Error('MinIO did not report origin chunk fetches within 10 seconds');
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return output;
      output += decoder.decode(value, { stream: true });
      const newline = output.indexOf('\n');
      if (newline !== -1) return output.slice(0, newline).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

async function startDeliveryWorker(vars: Record<string, string>): Promise<DeliveryWorkerProcess> {
  const child = Bun.spawn(['bun', 'x', 'tsx', 'services/delivery-worker/testDevServer.ts'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(vars).map(([name, value]) => [`BUYER_FLOW_${name}`, value])
      ),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderrPromise = new Response(child.stderr).text();
  let timedOut = false;
  const readyLine = await Promise.race([
    readFirstLine(child.stdout),
    delay(30_000).then(() => {
      timedOut = true;
      return '';
    }),
  ]);
  const match = /^DELIVERY_WORKER_READY (\d+)$/.exec(readyLine);
  if (!match?.[1]) {
    child.kill('SIGTERM');
    await child.exited;
    const stderr = await stderrPromise;
    throw new Error(
      timedOut
        ? `Delivery Worker did not start within 30 seconds${stderr ? `: ${stderr}` : ''}`
        : `Delivery Worker returned an invalid ready line: ${readyLine}${stderr ? `\n${stderr}` : ''}`
    );
  }

  return {
    port: Number(match[1]),
    async stop() {
      child.stdin.end();
      let stopTimedOut = false;
      const exitCode = await Promise.race([
        child.exited,
        delay(15_000).then(() => {
          stopTimedOut = true;
          return -1;
        }),
      ]);
      if (stopTimedOut) {
        child.kill('SIGTERM');
        await child.exited;
      }
      const stderr = await stderrPromise;
      if (stopTimedOut || exitCode !== 0) {
        throw new Error(
          stopTimedOut
            ? `Delivery Worker did not stop within 15 seconds${stderr ? `: ${stderr}` : ''}`
            : `Delivery Worker exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`
        );
      }
    },
  };
}

async function createCanonicalZipFixture(
  scratchPath: string,
  input: {
    fixtureName: string;
    packageId: string;
    payloadBytes: number;
    seed: string;
    version: string;
  }
): Promise<string> {
  const sourcePath = join(scratchPath, `${input.fixtureName}-source.zip`);
  const originalPackagePath = join(scratchPath, `${input.fixtureName}.zip`);
  const packageJson = Buffer.from(
    `${JSON.stringify(
      {
        name: input.packageId,
        version: input.version,
        displayName: 'Buyer Delivery Flow',
        description: 'Byte-exact full-chain delivery fixture',
      },
      null,
      2
    )}\n`
  );
  const payload = deterministicBytes(input.seed, input.payloadBytes);
  await writeFile(
    sourcePath,
    zipSync({
      'Runtime/payload.png': [payload, { level: 0, mtime: new Date('2026-01-01T00:00:00Z') }],
      'package.json': [packageJson, { level: 9, mtime: new Date('2026-01-01T00:00:00Z') }],
    })
  );
  await canonicalizeArtifact({
    inputPath: sourcePath,
    outputPath: originalPackagePath,
  });
  return originalPackagePath;
}

async function publishReadyOutboxEvent(sql: CatalogDatabase, versionId: string): Promise<void> {
  const readyEvents = await sql<ReadyOutboxRow[]>`
    SELECT id, aggregate_id, event_type, payload, created_at
    FROM catalog_outbox
    WHERE aggregate_id = ${versionId} AND event_type = 'catalog.version.ready'
  `;
  const readyEvent = readyEvents[0];
  if (!readyEvent) {
    throw new Error(`READY promotion did not emit its catalog outbox event: ${versionId}`);
  }
  await createConvexCatalogPublish({
    convexApiSecret: API_SECRET,
    convexUrl: BACKEND_URL,
    internalServiceAuthSecret: INTERNAL_SERVICE_AUTH_SECRET,
  })({
    id: readyEvent.id,
    aggregateId: readyEvent.aggregate_id,
    eventType: readyEvent.event_type,
    payload: readyEvent.payload,
    createdAt: readyEvent.created_at,
  });
}

function mutateSignature(signature: string): string {
  return `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`;
}

test('publishes first and repeat creator releases, materializes a purchase, and delivers by id and alias', async () => {
  await runCommand('docker', ['version', '--format', '{{.Server.Version}}']);
  await verifyDesyncCli();
  await removeLabeledContainers();

  const databaseName = 'buyer_delivery_flow';
  const databasePassword = randomBytes(24).toString('hex');
  const rootAccessKey = `root-${randomBytes(12).toString('hex')}`;
  const rootSecretKey = randomBytes(32).toString('hex');
  const readonlyAccessKey = `readonly-${randomBytes(12).toString('hex')}`;
  const readonlySecretKey = randomBytes(32).toString('hex');
  const deliveryHmacKey = randomBytes(32).toString('hex');
  const bucket = `buyer-delivery-${randomBytes(8).toString('hex')}`;
  const postgresName = `yucp-buyer-delivery-postgres-${randomUUID()}`;
  const minioName = `yucp-buyer-delivery-minio-${randomUUID()}`;
  const counts: FetchCounts = { chunkGets: 0, totalGets: 0 };
  let postgresContainer: string | undefined;
  let minioContainer: string | undefined;
  let scratchPath: string | undefined;
  let sql: CatalogDatabase | undefined;
  let worker: DeliveryWorkerProcess | undefined;
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

    auditReceiver = await startAuditReceiver(counts, {
      bucket,
      chunkPrefix: 'chunks/',
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
        'MINIO_AUDIT_WEBHOOK_ENABLE_BUYER_FLOW=on',
        '--env',
        `MINIO_AUDIT_WEBHOOK_ENDPOINT_BUYER_FLOW=http://host.docker.internal:${auditReceiver.port}/audit`,
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
    const minioEndpoint = `http://127.0.0.1:${minioPort}`;
    await waitForMinioReady({ endpoint: minioEndpoint });

    const casConfig = loadCasConfig({
      CAS_S3_ENDPOINT: minioEndpoint,
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

    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-buyer-delivery-flow-'));
    const firstPackagePath = await createCanonicalZipFixture(scratchPath, {
      fixtureName: 'buyer-package-v1',
      packageId: PACKAGE_ID,
      payloadBytes: 2 * 1024 * 1024,
      seed: 'buyer-delivery-flow-first-release',
      version: FIRST_PACKAGE_VERSION,
    });
    const secondPackagePath = await createCanonicalZipFixture(scratchPath, {
      fixtureName: 'buyer-package-v2',
      packageId: PACKAGE_ID,
      payloadBytes: 2 * 1024 * 1024,
      seed: 'buyer-delivery-flow-second-release',
      version: SECOND_PACKAGE_VERSION,
    });
    const otherCreatorPackagePath = await createCanonicalZipFixture(scratchPath, {
      fixtureName: 'other-creator-package-v1',
      packageId: OTHER_PACKAGE_ID,
      payloadBytes: 256 * 1024,
      seed: 'buyer-delivery-flow-other-creator-release',
      version: OTHER_PACKAGE_VERSION,
    });
    const firstPackageBytes = new Uint8Array(await readFile(firstPackagePath));
    const secondPackageBytes = new Uint8Array(await readFile(secondPackagePath));
    const otherCreatorPackageBytes = new Uint8Array(await readFile(otherCreatorPackagePath));
    const firstPackageSha256 = sha256Bytes(firstPackageBytes);
    const secondPackageSha256 = sha256Bytes(secondPackageBytes);
    expect(firstPackageBytes.byteLength).toBeGreaterThan(DESYNC_CHUNK_AVG_KIB * 1024);
    expect(secondPackageBytes.byteLength).toBeGreaterThan(DESYNC_CHUNK_AVG_KIB * 1024);
    expect(secondPackageSha256).not.toBe(firstPackageSha256);

    const harness = getRealApiHarness();
    const creator = await createBetterAuthUser({ name: 'Buyer Flow Creator' });
    await seedCreatorProfile({
      authUserId: creator.authUserId,
      name: 'Buyer Flow Creator',
    });
    const otherCreator = await createBetterAuthUser({ name: 'Second Package Creator' });
    await seedCreatorProfile({
      authUserId: otherCreator.authUserId,
      name: 'Second Package Creator',
    });
    const unauthorizedCreator = await createBetterAuthUser({ name: 'Namespace Challenger' });
    const buyer = await createBetterAuthUser({ name: 'Entitled Buyer' });
    const unentitledBuyer = await createBetterAuthUser({ name: 'Unentitled Buyer' });
    const buyerSubjectId = await seedSubject(buyer.authUserId);
    await seedSubject(unentitledBuyer.authUserId);
    expect(await harness.convex.collect('package_registry')).toHaveLength(0);
    expect(await harness.convex.collect('package_versions_ref')).toHaveLength(0);

    const firstRegistration = await harness.convex.mutation(
      internal.packageRegistry.registerPackage,
      {
        packageId: PACKAGE_ID,
        packageName: 'Buyer Delivery Flow',
        publisherId: uniqueName('publisher-first'),
        yucpUserId: creator.authUserId,
      }
    );
    expect(firstRegistration).toEqual({ registered: true, conflict: false, archived: false });
    const repeatedRegistration = await harness.convex.mutation(
      internal.packageRegistry.registerPackage,
      {
        packageId: PACKAGE_ID,
        packageName: 'Buyer Delivery Flow Updated',
        publisherId: uniqueName('publisher-repeat'),
        yucpUserId: creator.authUserId,
      }
    );
    expect(repeatedRegistration).toEqual({ registered: true, conflict: false, archived: false });
    const otherCreatorRegistration = await harness.convex.mutation(
      internal.packageRegistry.registerPackage,
      {
        packageId: OTHER_PACKAGE_ID,
        packageName: 'Other Creator Package',
        publisherId: uniqueName('publisher-other'),
        yucpUserId: otherCreator.authUserId,
      }
    );
    expect(otherCreatorRegistration).toEqual({
      registered: true,
      conflict: false,
      archived: false,
    });
    const unauthorizedRegistration = await harness.convex.mutation(
      internal.packageRegistry.registerPackage,
      {
        packageId: PACKAGE_ID,
        packageName: 'Namespace Challenger Package',
        publisherId: uniqueName('publisher-unauthorized'),
        yucpUserId: unauthorizedCreator.authUserId,
      }
    );
    expect(unauthorizedRegistration).toEqual({
      registered: false,
      conflict: true,
      archived: false,
    });

    const legacyPackageId = 'com.yucp.legacy-package';
    const now = Date.now();
    await harness.convex.insert('package_registry', {
      packageId: legacyPackageId,
      packageName: 'Legacy Package',
      publisherId: uniqueName('publisher-legacy'),
      yucpUserId: creator.authUserId,
      registeredAt: now,
      updatedAt: now,
    });
    const legacyRegistration = await harness.convex.query(api.packageRegistry.lookupRegistration, {
      apiSecret: API_SECRET,
      actor: await createApiServiceActorBinding({
        service: 'api-server',
        scopes: ['verification-intents:service'],
      }),
      packageId: legacyPackageId,
    });
    expect(legacyRegistration).toEqual({
      packageId: legacyPackageId,
      yucpUserId: creator.authUserId,
      status: 'active',
    });
    const migratedLegacyRegistration = await harness.convex.mutation(
      internal.packageRegistry.registerPackage,
      {
        packageId: legacyPackageId,
        packageName: 'Legacy Package Updated',
        publisherId: uniqueName('publisher-legacy-repeat'),
        yucpUserId: creator.authUserId,
      }
    );
    expect(migratedLegacyRegistration).toEqual({
      registered: true,
      conflict: false,
      archived: false,
    });

    const providerProductRef = uniqueName('buyer-flow-store-product');
    const catalogProductId = await seedProductCatalog({
      authUserId: creator.authUserId,
      canonicalSlug: PRODUCT_SLUG,
      productId: PACKAGE_ID,
      provider: 'gumroad',
      providerProductRef,
      displayName: 'Buyer Delivery Flow',
    });
    const otherCatalogProductId = await seedProductCatalog({
      authUserId: otherCreator.authUserId,
      canonicalSlug: 'other-creator-package',
      productId: OTHER_PACKAGE_ID,
      provider: 'gumroad',
      providerProductRef: uniqueName('other-store-product'),
      displayName: 'Other Creator Package',
    });

    const firstUploading = await beginVersion({
      catalog,
      catalogProductId: String(catalogProductId),
      packageId: PACKAGE_ID,
      version: FIRST_PACKAGE_VERSION,
    });
    const firstAssembled = await assembleVersion({
      catalog,
      inputPath: firstPackagePath,
      store: s3CasStore(casConfig),
      versionId: firstUploading.id,
    });
    expect(firstAssembled.state).toBe('ASSEMBLED');
    expect(firstAssembled.canonicalSha256).toBe(firstPackageSha256);
    const firstReady = await promoteVersion({
      catalog,
      store: s3CasStore(casConfig),
      versionId: firstAssembled.id,
    });
    expect(firstReady.state).toBe('READY');
    await publishReadyOutboxEvent(sql, firstReady.id);

    await delay(10);
    const secondUploading = await beginVersion({
      catalog,
      catalogProductId: String(catalogProductId),
      packageId: PACKAGE_ID,
      version: SECOND_PACKAGE_VERSION,
    });
    const secondAssembled = await assembleVersion({
      catalog,
      inputPath: secondPackagePath,
      store: s3CasStore(casConfig),
      versionId: secondUploading.id,
    });
    expect(secondAssembled.state).toBe('ASSEMBLED');
    expect(secondAssembled.canonicalSha256).toBe(secondPackageSha256);
    const secondReady = await promoteVersion({
      catalog,
      store: s3CasStore(casConfig),
      versionId: secondAssembled.id,
    });
    expect(secondReady.state).toBe('READY');
    await publishReadyOutboxEvent(sql, secondReady.id);

    await delay(10);
    const otherUploading = await beginVersion({
      catalog,
      catalogProductId: String(otherCatalogProductId),
      packageId: OTHER_PACKAGE_ID,
      version: OTHER_PACKAGE_VERSION,
    });
    const otherAssembled = await assembleVersion({
      catalog,
      inputPath: otherCreatorPackagePath,
      store: s3CasStore(casConfig),
      versionId: otherUploading.id,
    });
    expect(otherAssembled.state).toBe('ASSEMBLED');
    expect(otherAssembled.canonicalSha256).toBe(sha256Bytes(otherCreatorPackageBytes));
    const otherReady = await promoteVersion({
      catalog,
      store: s3CasStore(casConfig),
      versionId: otherAssembled.id,
    });
    expect(otherReady.state).toBe('READY');
    await publishReadyOutboxEvent(sql, otherReady.id);

    const manifestResponse = await getS3Object(
      casConfig,
      `${casConfig.indexPrefix}${deliveryManifestObjectId(secondReady.id)}`
    );
    const deliveryManifest = parseDeliveryManifest(
      JSON.parse(await manifestResponse.text()) as unknown
    );
    expect(deliveryManifest.chunks.length).toBeGreaterThan(1);
    expect(deliveryManifest.totalSize).toBe(secondPackageBytes.byteLength);

    const publishedVersions = await harness.convex.collect('package_versions_ref');
    expect(publishedVersions).toHaveLength(3);
    expect(publishedVersions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          catalogProductId,
          packageId: PACKAGE_ID,
          version: FIRST_PACKAGE_VERSION,
          versionId: firstReady.id,
          state: 'SUPERSEDED',
        }),
        expect.objectContaining({
          catalogProductId,
          packageId: PACKAGE_ID,
          version: SECOND_PACKAGE_VERSION,
          versionId: secondReady.id,
          state: 'READY',
          totalSize: secondPackageBytes.byteLength,
          contentType: 'application/zip',
        }),
        expect.objectContaining({
          catalogProductId: otherCatalogProductId,
          packageId: OTHER_PACKAGE_ID,
          version: OTHER_PACKAGE_VERSION,
          versionId: otherReady.id,
          state: 'READY',
        }),
      ])
    );

    const buyerEmailHash = await sha256Hex(normalizeEmail(buyer.email));
    const providerUserId = uniqueName('gumroad-buyer');
    const externalAccountId = await harness.convex.insert('external_accounts', {
      provider: 'gumroad',
      providerUserId,
      emailHash: buyerEmailHash,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await harness.convex.insert('buyer_provider_links', {
      subjectId: buyerSubjectId,
      provider: 'gumroad',
      externalAccountId,
      status: 'active',
      linkedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await harness.convex.insert('bindings', {
      authUserId: creator.authUserId,
      subjectId: buyerSubjectId,
      externalAccountId,
      bindingType: 'verification',
      status: 'active',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const externalOrderId = uniqueName('gumroad-order');
    await harness.convex.insert('purchase_facts', {
      authUserId: creator.authUserId,
      provider: 'gumroad',
      externalOrderId,
      buyerEmailHash,
      providerUserId,
      providerProductId: providerProductRef,
      paymentStatus: 'completed',
      lifecycleStatus: 'active',
      purchasedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const materialized = await harness.convex.mutation(
      internal.backgroundSync.projectBackfilledPurchasesForProduct,
      {
        authUserId: creator.authUserId,
        productId: PACKAGE_ID,
        provider: 'gumroad',
        providerProductRef,
      }
    );
    expect(materialized).toMatchObject({
      purchaseFactsFound: 1,
      linkedToSubject: 1,
      entitlementsGranted: 1,
      skippedInactive: 0,
      unresolved: 0,
    });
    const repeatedMaterialization = await harness.convex.mutation(
      internal.backgroundSync.projectBackfilledPurchasesForProduct,
      {
        authUserId: creator.authUserId,
        productId: PACKAGE_ID,
        provider: 'gumroad',
        providerProductRef,
      }
    );
    expect(repeatedMaterialization).toMatchObject({
      purchaseFactsFound: 1,
      linkedToSubject: 0,
      entitlementsGranted: 0,
      skippedInactive: 0,
      unresolved: 0,
    });
    const entitlements = await harness.convex.collect('entitlements');
    expect(entitlements).toEqual([
      expect.objectContaining({
        authUserId: creator.authUserId,
        catalogProductId,
        productId: PACKAGE_ID,
        sourceProvider: 'gumroad',
        sourceReference: `gumroad:${externalOrderId}`,
        status: 'active',
        subjectId: buyerSubjectId,
      }),
    ]);

    worker = await startDeliveryWorker({
      CAS_S3_ENDPOINT: minioEndpoint,
      CAS_S3_REGION: casConfig.region,
      CAS_S3_BUCKET: casConfig.bucket,
      CAS_S3_READONLY_ACCESS_KEY_ID: readonlyAccessKey,
      CAS_S3_READONLY_SECRET_ACCESS_KEY: readonlySecretKey,
      CAS_INDEX_PREFIX: casConfig.indexPrefix,
      CAS_CHUNK_PREFIX: casConfig.chunkPrefix,
      DELIVERY_HMAC_KEY: deliveryHmacKey,
      STORAGE_FORMAT_VERSION: DESYNC_STORAGE_FORMAT_VERSION,
    });
    const deliveryBaseUrl = `http://127.0.0.1:${worker.port}`;
    const auth = createAuth({
      baseUrl: API_BASE_URL,
      trustedOrigin: API_BASE_URL,
      convexSiteUrl: SITE_URL,
      convexUrl: BACKEND_URL,
    });
    const connectRoutes = createConnectUserProductAccessRoutes({
      auth,
      config: {
        apiBaseUrl: API_BASE_URL,
        frontendBaseUrl: 'http://127.0.0.1:3000',
        convexSiteUrl: SITE_URL,
        convexApiSecret: API_SECRET,
        convexUrl: BACKEND_URL,
        deliveryBaseUrl,
        deliveryHmacKey,
        discordClientId: 'buyer-flow-discord-client',
        discordClientSecret: 'buyer-flow-discord-secret',
        encryptionSecret: 'buyer-flow-encryption-secret',
      },
    });
    const vpmRoutes = createVpmRoutes({
      auth,
      config: {
        apiBaseUrl: API_BASE_URL,
        frontendBaseUrl: 'http://127.0.0.1:3000',
        convexApiSecret: API_SECRET,
        convexUrl: BACKEND_URL,
        deliveryBaseUrl,
        deliveryHmacKey,
        vpmBaseUrl: API_BASE_URL,
      },
    });

    const buyerSession = await createBetterAuthSession(buyer.authUserId);
    const unentitledSession = await createBetterAuthSession(unentitledBuyer.authUserId);
    const requestHeaders = (session: string): HeadersInit => ({
      cookie: `yucp.session_token=${session}`,
      origin: API_BASE_URL,
    });

    for (const productReference of [String(catalogProductId), PRODUCT_SLUG, providerProductRef]) {
      const accessResponse = await connectRoutes.getBuyerProductAccess(
        new Request(`${API_BASE_URL}/api/connect/user/product-access/${productReference}`, {
          headers: requestHeaders(buyerSession),
        }),
        productReference
      );
      expect(accessResponse.status).toBe(200);
      await expect(accessResponse.json()).resolves.toMatchObject({
        product: {
          catalogProductId: String(catalogProductId),
          canonicalSlug: PRODUCT_SLUG,
        },
        accessState: {
          hasActiveEntitlement: true,
          requiresVerification: false,
        },
      });

      const unentitledResponse = await connectRoutes.downloadBuyerProductAccess(
        new Request(
          `${API_BASE_URL}/api/connect/user/product-access/${productReference}/download`,
          {
            headers: requestHeaders(unentitledSession),
          }
        ),
        productReference
      );
      expect(unentitledResponse.status).toBe(403);
      await expect(unentitledResponse.json()).resolves.toEqual({
        error: 'Active entitlement required',
      });

      const entitledResponse = await connectRoutes.downloadBuyerProductAccess(
        new Request(
          `${API_BASE_URL}/api/connect/user/product-access/${productReference}/download`,
          {
            headers: requestHeaders(buyerSession),
          }
        ),
        productReference
      );
      expect(entitledResponse.status).toBe(302);
      expect(entitledResponse.headers.get('location')).toContain(`/d/${secondReady.id}?`);
    }

    const repoTokenResponse = await vpmRoutes.mintRepoToken(
      new Request(`${API_BASE_URL}/api/vpm/repo-token`, {
        method: 'POST',
        headers: requestHeaders(buyerSession),
      })
    );
    expect(repoTokenResponse.status).toBe(200);
    const repoToken = (await repoTokenResponse.json()) as {
      indexUrl: string;
      token: string;
    };
    expect(repoToken.indexUrl).toBe(
      `${API_BASE_URL}/api/vpm/${encodeURIComponent(repoToken.token)}/index.json`
    );

    const indexResponse = await vpmRoutes.serveIndex(
      new Request(repoToken.indexUrl),
      repoToken.token
    );
    expect(indexResponse.status).toBe(200);
    const indexText = await indexResponse.text();
    const index = JSON.parse(indexText) as VpmIndex;
    expect(index.packages[PACKAGE_ID]?.versions[FIRST_PACKAGE_VERSION]).toBeUndefined();
    expect(index.packages[OTHER_PACKAGE_ID]).toBeUndefined();
    const packageVersion = index.packages[PACKAGE_ID]?.versions[SECOND_PACKAGE_VERSION];
    expect(packageVersion).toBeDefined();
    if (!packageVersion) {
      throw new Error('VPM index did not list the READY package version');
    }
    const deliveryUrl = new URL(packageVersion.url);
    expect(deliveryUrl.origin).toBe(deliveryBaseUrl);
    expect(deliveryUrl.pathname).toBe(`/d/${secondReady.id}`);
    expect(deliveryUrl.searchParams.get('exp')).toBeTruthy();
    expect(deliveryUrl.searchParams.get('sig')).toBeTruthy();

    const chunksBeforeDownload = counts.chunkGets;
    const downloadedResponse = await fetch(deliveryUrl, { redirect: 'follow' });
    expect(downloadedResponse.status).toBe(200);
    expect(downloadedResponse.headers.get('content-type')).toBe('application/zip');
    expect(downloadedResponse.headers.get('content-length')).toBe(
      secondPackageBytes.byteLength.toString()
    );
    const downloadedBytes = new Uint8Array(await downloadedResponse.arrayBuffer());
    const originChunkFetches = await waitForOriginChunkFetches(counts, chunksBeforeDownload);
    const downloadedSha256 = sha256Bytes(downloadedBytes);
    expect(originChunkFetches).toBeGreaterThan(0);
    expect(downloadedBytes.byteLength).toBe(secondPackageBytes.byteLength);
    expect(downloadedSha256).toBe(secondPackageSha256);
    expect(downloadedBytes).toEqual(secondPackageBytes);
    expect(downloadedBytes.byteLength).toBeGreaterThan(Buffer.byteLength(indexText));
    expect(Buffer.from(downloadedBytes.subarray(0, 2)).toString('ascii')).toBe('PK');
    const downloadedZip = unzipSync(downloadedBytes);
    expect(downloadedZip['Runtime/payload.png']?.byteLength).toBe(2 * 1024 * 1024);
    expect(JSON.parse(Buffer.from(downloadedZip['package.json'] ?? []).toString('utf8'))).toEqual(
      expect.objectContaining({ name: PACKAGE_ID, version: SECOND_PACKAGE_VERSION })
    );

    const tamperedUrl = new URL(deliveryUrl);
    tamperedUrl.searchParams.set('sig', mutateSignature(tamperedUrl.searchParams.get('sig') ?? ''));
    const tamperedResponse = await fetch(tamperedUrl);
    expect(tamperedResponse.status).toBe(403);
    expect(tamperedResponse.headers.get('x-delivery-storage-fetches')).toBe('0');
    await tamperedResponse.arrayBuffer();

    const expiredSignature = await signDeliveryUrl({
      expiresAt: Date.now() - 60_000,
      key: deliveryHmacKey,
      versionId: secondReady.id,
    });
    const expiredUrl = new URL(deliveryUrl);
    expiredUrl.searchParams.set('exp', expiredSignature.exp);
    expiredUrl.searchParams.set('sig', expiredSignature.sig);
    const expiredResponse = await fetch(expiredUrl);
    expect(expiredResponse.status).toBe(403);
    expect(expiredResponse.headers.get('x-delivery-storage-fetches')).toBe('0');
    await expiredResponse.arrayBuffer();

    console.log('BUYER_DELIVERY_FLOW_E2E_RESULT');
    console.log(`first-release-sha256=${firstPackageSha256}`);
    console.log(`second-release-sha256=${secondPackageSha256}`);
    console.log(`downloaded-sha256=${downloadedSha256}`);
    console.log(`second-release-length=${secondPackageBytes.byteLength}`);
    console.log(`downloaded-length=${downloadedBytes.byteLength}`);
    console.log(`manifest-chunks=${deliveryManifest.chunks.length} multi-chunk=yes`);
    console.log('canonical-id=302 slug=302 provider-ref=302 unentitled=403');
    console.log('first-release=SUPERSEDED second-release=READY other-creator=READY');
    console.log('namespace-conflict=denied purchase-materialization=active-repeat-idempotent');
    console.log('legacy-package=migrated-active');
    console.log('tampered-sig=403 expired-sig=403');
    console.log(`origin-chunk-fetches=${originChunkFetches}`);
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
    throw new AggregateError(cleanupErrors, 'Buyer delivery flow teardown failed');
  }
}, 300_000);
