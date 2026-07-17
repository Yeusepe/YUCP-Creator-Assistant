import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  Catalog,
  type CatalogDatabase,
  openCatalogDatabase,
  runCatalogMigrations,
} from '../catalog';
import {
  beginVersion,
  ingestVersion,
  promoteVersion,
  resolvePipelineCasIndexId,
  retrieveVersion,
} from '../ingest-pipeline/ingestPipeline';
import { canonicalizeArtifact } from '../storage-core/canonicalizer';
import { type CasConfig, loadCasConfig } from '../storage-core/config';
import { deliveryManifestObjectId } from '../storage-core/deliveryManifest';
import {
  inspectDesyncIndex,
  type S3CasStore,
  s3CasStore,
  storeArtifactToStore,
  verifyDesyncCli,
} from '../storage-core/desyncCas';
import {
  createS3Bucket,
  getS3Object,
  listS3ObjectPage,
  listS3Objects,
  putS3Object,
} from '../storage-core/s3Control';
import { DEFAULT_GC_GRACE_PERIOD_MS, runChunkGarbageCollection } from './chunkGc';

const POSTGRES_IMAGE = 'postgres:17-alpine';
const MINIO_IMAGE = 'minio/minio:RELEASE.2025-09-07T16-13-09Z';
const DATABASE_NAME = 'chunk_gc_test';
const DATABASE_PASSWORD = 'chunk-gc-test-password';
const POSTGRES_CONTAINER = `yucp-chunk-gc-pg-${randomBytes(6).toString('hex')}`;
const MINIO_CONTAINER = `yucp-chunk-gc-s3-${randomBytes(6).toString('hex')}`;

let sql: CatalogDatabase | undefined;
let catalog: Catalog | undefined;
let casConfig: CasConfig | undefined;
let store: S3CasStore | undefined;
let scratchPath: string | undefined;
const startedContainers = new Set<string>();

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runDocker(args: string[]): Promise<CommandResult> {
  const process = Bun.spawn(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function requireDocker(args: string[]): Promise<string> {
  const result = await runDocker(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed with exit code ${result.exitCode}\n${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

async function removeContainers(): Promise<void> {
  const failures: string[] = [];
  for (const name of startedContainers) {
    const result = await runDocker(['rm', '--force', name]);
    if (result.exitCode !== 0 && !result.stderr.includes('No such container')) {
      failures.push(`${name}: ${result.stderr || result.stdout}`);
    }
  }
  startedContainers.clear();
  if (failures.length > 0) {
    throw new Error(`Failed to remove test containers:\n${failures.join('\n')}`);
  }
}

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await runDocker([
      'exec',
      POSTGRES_CONTAINER,
      'pg_isready',
      '--username',
      'postgres',
      '--dbname',
      DATABASE_NAME,
    ]);
    if (result.exitCode === 0) {
      return;
    }
    await Bun.sleep(250);
  }
  const logs = await runDocker(['logs', POSTGRES_CONTAINER]);
  throw new Error(
    `PostgreSQL did not become ready within 60 seconds.\n${logs.stderr}\n${logs.stdout}`
  );
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
      // The throwaway MinIO server is still starting.
    }
    await Bun.sleep(250);
  }
  const logs = await runDocker(['logs', MINIO_CONTAINER]);
  throw new Error(`MinIO did not become ready within 60 seconds.\n${logs.stderr}\n${logs.stdout}`);
}

async function publishedPort(containerName: string, containerPort: string): Promise<string> {
  const output = await requireDocker(['port', containerName, `${containerPort}/tcp`]);
  const match = output.match(/127\.0\.0\.1:(\d+)$/m);
  if (!match?.[1]) {
    throw new Error(`Could not determine ${containerName} published port from: ${output}`);
  }
  return match[1];
}

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

function requireSql(): CatalogDatabase {
  if (!sql) {
    throw new Error('Chunk GC end-to-end database was not initialized');
  }
  return sql;
}

function requireCatalog(): Catalog {
  if (!catalog) {
    throw new Error('Chunk GC end-to-end catalog was not initialized');
  }
  return catalog;
}

function requireCasConfig(): CasConfig {
  if (!casConfig) {
    throw new Error('Chunk GC end-to-end CAS config was not initialized');
  }
  return casConfig;
}

function requireStore(): S3CasStore {
  if (!store) {
    throw new Error('Chunk GC end-to-end CAS store was not initialized');
  }
  return store;
}

function requireScratchPath(): string {
  if (!scratchPath) {
    throw new Error('Chunk GC end-to-end scratch directory was not initialized');
  }
  return scratchPath;
}

function chunkObjectIds(objects: { key: string }[], chunkPrefix: string): Set<string> {
  return new Set(
    objects
      .filter(({ key }) => key.startsWith(chunkPrefix))
      .map(({ key }) => key.split('/').at(-1))
      .filter((id): id is string => id !== undefined)
  );
}

async function chunkLastModified(
  config: CasConfig,
  chunkIds: Set<string>
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let continuationToken: string | undefined;
  do {
    const page = await listS3ObjectPage(config, {
      continuationToken,
      maxKeys: 1000,
      prefix: config.chunkPrefix,
    });
    for (const object of page.objects) {
      if (chunkIds.has(object.key.split('/').at(-1) ?? '')) {
        result.set(object.key, object.lastModified.getTime());
      }
    }
    continuationToken = page.nextContinuationToken;
  } while (continuationToken);
  return result;
}

async function cleanup(): Promise<void> {
  const activeSql = sql;
  sql = undefined;
  catalog = undefined;
  casConfig = undefined;
  store = undefined;
  try {
    await activeSql?.end({ timeout: 1 });
  } finally {
    try {
      if (scratchPath) {
        assertScratchPath(scratchPath);
        await rm(scratchPath, { force: true, recursive: true });
        scratchPath = undefined;
      }
    } finally {
      await removeContainers();
    }
  }
}

beforeAll(async () => {
  try {
    await verifyDesyncCli();
    await requireDocker(['version']);
    await requireDocker([
      'run',
      '--detach',
      '--rm',
      '--name',
      POSTGRES_CONTAINER,
      '--env',
      `POSTGRES_PASSWORD=${DATABASE_PASSWORD}`,
      '--env',
      `POSTGRES_DB=${DATABASE_NAME}`,
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data',
      POSTGRES_IMAGE,
    ]);
    startedContainers.add(POSTGRES_CONTAINER);

    const accessKeyId = `test-${randomBytes(12).toString('hex')}`;
    const secretAccessKey = randomBytes(32).toString('hex');
    await requireDocker([
      'run',
      '--detach',
      '--rm',
      '--name',
      MINIO_CONTAINER,
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
    startedContainers.add(MINIO_CONTAINER);

    await waitForPostgres();
    const postgresPort = await publishedPort(POSTGRES_CONTAINER, '5432');
    const minioPort = await publishedPort(MINIO_CONTAINER, '9000');
    const minioEndpoint = `http://127.0.0.1:${minioPort}`;
    await waitForMinio(minioEndpoint);

    sql = openCatalogDatabase(
      `postgres://postgres:${DATABASE_PASSWORD}@127.0.0.1:${postgresPort}/${DATABASE_NAME}`
    );
    await runCatalogMigrations(sql);
    catalog = new Catalog(sql);

    casConfig = loadCasConfig({
      CAS_S3_ENDPOINT: minioEndpoint,
      CAS_S3_REGION: 'us-east-1',
      CAS_S3_BUCKET: `chunk-gc-${randomBytes(8).toString('hex')}`,
      CAS_S3_ACCESS_KEY_ID: accessKeyId,
      CAS_S3_SECRET_ACCESS_KEY: secretAccessKey,
    });
    await createS3Bucket(casConfig);
    store = s3CasStore(casConfig);
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-chunk-gc-e2e-'));
  } catch (error) {
    await cleanup();
    throw error;
  }
});

afterAll(cleanup);

describe.serial('conservative chunk garbage collection', () => {
  it('protects old deduplicated chunks while their replacement upload is in flight', async () => {
    const activeSql = requireSql();
    const activeCatalog = requireCatalog();
    const config = requireCasConfig();
    const activeStore = requireStore();
    const scratch = requireScratchPath();
    const gracePeriodMs = 8_000;

    const rawPath = join(scratch, 'in-flight-dedup-source.bin');
    await writeFile(rawPath, deterministicBytes('gc-in-flight-dedup', 4 * 1024 * 1024));
    const canonical = await canonicalizeArtifact({
      inputPath: rawPath,
      outputPath: join(scratch, 'in-flight-dedup.canonical'),
    });
    const ready = await promoteVersion({
      catalog: activeCatalog,
      store: activeStore,
      versionId: (
        await ingestVersion({
          catalog: activeCatalog,
          store: activeStore,
          packageId: 'chunk-gc-in-flight-package',
          version: '1.0.0',
          inputPath: rawPath,
        })
      ).id,
    });
    if (!ready.casIndexId) {
      throw new Error('READY in-flight GC fixture must have a CAS index ID');
    }
    const chunks = await inspectDesyncIndex({
      indexId: resolvePipelineCasIndexId(activeStore, ready.casIndexId),
      store: activeStore,
    });
    const chunkIds = new Set(chunks.map(({ id }) => id));
    expect(chunkIds.size).toBeGreaterThan(0);
    const beforeLastModified = await chunkLastModified(config, chunkIds);
    expect(beforeLastModified.size).toBe(chunkIds.size);

    await Bun.sleep(gracePeriodMs + 500);
    const uploading = await beginVersion({
      catalog: activeCatalog,
      packageId: 'chunk-gc-in-flight-package',
      version: '2.0.0',
    });
    await storeArtifactToStore({
      artifactPath: canonical.path,
      indexId: `gc-in-flight-${uploading.id}.caibx`,
      store: activeStore,
    });

    const afterDedupLastModified = await chunkLastModified(config, chunkIds);
    expect(afterDedupLastModified).toEqual(beforeLastModified);

    await activeSql.begin(async (transaction) => {
      await transaction`DELETE FROM catalog_outbox WHERE aggregate_id = ${ready.id}`;
      await transaction`DELETE FROM package_versions WHERE id = ${ready.id}`;
    });
    const gc = await runChunkGarbageCollection({
      sql: activeSql,
      store: activeStore,
      gracePeriodMs,
      batchSize: 2,
    });
    const chunkIdsAfterGc = chunkObjectIds(await listS3Objects(config), config.chunkPrefix);
    for (const chunkId of chunkIds) {
      expect(chunkIdsAfterGc.has(chunkId)).toBeTrue();
    }
    expect(gc.keptObjects).toBeGreaterThanOrEqual(chunkIds.size);
    expect((await activeCatalog.getVersion(uploading.id))?.state).toBe('UPLOADING');
    await activeSql.begin(async (transaction) => {
      await transaction`DELETE FROM catalog_outbox WHERE aggregate_id = ${uploading.id}`;
      await transaction`DELETE FROM package_versions WHERE id = ${uploading.id}`;
    });
  }, 30_000);

  it('reclaims only v1 orphans while v2 remains byte-exact and fresh objects stay protected', async () => {
    const activeSql = requireSql();
    const activeCatalog = requireCatalog();
    const config = requireCasConfig();
    const activeStore = requireStore();
    const scratch = requireScratchPath();

    const sharedPrefix = deterministicBytes('gc-shared-prefix', 4 * 1024 * 1024);
    const sharedSuffix = deterministicBytes('gc-shared-suffix', 4 * 1024 * 1024);
    const rawV1Path = join(scratch, 'artifact-v1.bin');
    const rawV2Path = join(scratch, 'artifact-v2.bin');
    await writeFile(
      rawV1Path,
      Buffer.concat([sharedPrefix, deterministicBytes('gc-version-one', 256 * 1024), sharedSuffix])
    );
    await writeFile(
      rawV2Path,
      Buffer.concat([sharedPrefix, deterministicBytes('gc-version-two', 256 * 1024), sharedSuffix])
    );
    const canonicalV2 = await canonicalizeArtifact({
      inputPath: rawV2Path,
      outputPath: join(scratch, 'expected-v2.canonical'),
    });

    const assembledV1 = await ingestVersion({
      catalog: activeCatalog,
      store: activeStore,
      packageId: 'chunk-gc-package',
      version: '1.0.0',
      inputPath: rawV1Path,
    });
    const readyV1 = await promoteVersion({
      catalog: activeCatalog,
      store: activeStore,
      versionId: assembledV1.id,
    });
    const assembledV2 = await ingestVersion({
      catalog: activeCatalog,
      store: activeStore,
      packageId: 'chunk-gc-package',
      version: '2.0.0',
      inputPath: rawV2Path,
    });
    const readyV2 = await promoteVersion({
      catalog: activeCatalog,
      store: activeStore,
      versionId: assembledV2.id,
    });
    expect(readyV1.state).toBe('READY');
    expect(readyV2.state).toBe('READY');
    if (!readyV1.casIndexId || !readyV2.casIndexId) {
      throw new Error('READY GC fixtures must have CAS index IDs');
    }

    const v1Chunks = await inspectDesyncIndex({
      indexId: resolvePipelineCasIndexId(activeStore, readyV1.casIndexId),
      store: activeStore,
    });
    const v2Chunks = await inspectDesyncIndex({
      indexId: resolvePipelineCasIndexId(activeStore, readyV2.casIndexId),
      store: activeStore,
    });
    const v1ChunkIds = new Set(v1Chunks.map(({ id }) => id));
    const v2ChunkIds = new Set(v2Chunks.map(({ id }) => id));
    const v1UniqueIds = new Set([...v1ChunkIds].filter((id) => !v2ChunkIds.has(id)));
    const sharedIds = new Set([...v1ChunkIds].filter((id) => v2ChunkIds.has(id)));
    const v2UniqueIds = new Set([...v2ChunkIds].filter((id) => !v1ChunkIds.has(id)));
    expect(v1UniqueIds.size).toBeGreaterThan(0);
    expect(sharedIds.size).toBeGreaterThan(0);
    expect(v2UniqueIds.size).toBeGreaterThan(0);

    const v1IndexId = resolvePipelineCasIndexId(activeStore, readyV1.casIndexId);
    const v2IndexId = resolvePipelineCasIndexId(activeStore, readyV2.casIndexId);
    expect(v1IndexId).not.toBe(v2IndexId);
    const v1IndexKey = `${config.indexPrefix}${v1IndexId}`;
    const v2IndexKey = `${config.indexPrefix}${v2IndexId}`;
    const v1ManifestKey = `${config.indexPrefix}${deliveryManifestObjectId(readyV1.id)}`;
    const v2ManifestKey = `${config.indexPrefix}${deliveryManifestObjectId(readyV2.id)}`;

    await activeSql.begin(async (transaction) => {
      await transaction`DELETE FROM catalog_outbox WHERE aggregate_id = ${readyV1.id}`;
      await transaction`DELETE FROM package_versions WHERE id = ${readyV1.id}`;
    });
    expect(await activeCatalog.getVersion(readyV1.id)).toBeNull();

    const objectsBeforeDryRun = await listS3Objects(config);
    const chunkIdsBeforeGc = chunkObjectIds(objectsBeforeDryRun, config.chunkPrefix);
    const keysBeforeGc = new Set(objectsBeforeDryRun.map(({ key }) => key));
    for (const id of v1UniqueIds) {
      expect(chunkIdsBeforeGc.has(id)).toBeTrue();
    }
    expect(keysBeforeGc.has(v1IndexKey)).toBeTrue();
    expect(keysBeforeGc.has(v2IndexKey)).toBeTrue();
    expect(keysBeforeGc.has(v1ManifestKey)).toBeTrue();
    expect(keysBeforeGc.has(v2ManifestKey)).toBeTrue();

    const dryRun = await runChunkGarbageCollection({
      sql: activeSql,
      store: activeStore,
      gracePeriodMs: 0,
      batchSize: 2,
      dryRun: true,
    });
    expect(dryRun.deletedObjects).toBe(0);
    expect(dryRun.candidateObjects).toBeGreaterThanOrEqual(v1UniqueIds.size);
    expect((await listS3Objects(config)).map(({ key }) => key).sort()).toEqual(
      objectsBeforeDryRun.map(({ key }) => key).sort()
    );

    const firstRun = await runChunkGarbageCollection({
      sql: activeSql,
      store: activeStore,
      gracePeriodMs: 0,
      batchSize: 2,
    });
    expect(firstRun.deletedObjects).toBe(firstRun.candidateObjects);
    expect(firstRun.deletedObjects).toBeGreaterThanOrEqual(v1UniqueIds.size);
    expect(firstRun.deletedBytes).toBeGreaterThan(0);

    const objectsAfterGc = await listS3Objects(config);
    const chunkIdsAfterGc = chunkObjectIds(objectsAfterGc, config.chunkPrefix);
    const keysAfterGc = new Set(objectsAfterGc.map(({ key }) => key));
    for (const id of v1UniqueIds) {
      expect(chunkIdsAfterGc.has(id)).toBeFalse();
    }
    for (const id of v2ChunkIds) {
      expect(chunkIdsAfterGc.has(id)).toBeTrue();
    }
    expect(keysAfterGc.has(v1IndexKey)).toBeFalse();
    expect(keysAfterGc.has(v2IndexKey)).toBeTrue();
    expect(keysAfterGc.has(v1ManifestKey)).toBeFalse();
    expect(keysAfterGc.has(v2ManifestKey)).toBeTrue();

    const retrievedV2Path = await retrieveVersion({
      catalog: activeCatalog,
      store: activeStore,
      versionId: readyV2.id,
      outputPath: join(scratch, 'retrieved-v2-after-gc.bin'),
    });
    expect(await readFile(retrievedV2Path)).toEqual(await readFile(canonicalV2.path));
    expect(await sha256File(retrievedV2Path)).toBe(await sha256File(canonicalV2.path));

    const secondRun = await runChunkGarbageCollection({
      sql: activeSql,
      store: activeStore,
      gracePeriodMs: 0,
      batchSize: 2,
    });
    expect(secondRun.candidateObjects).toBe(0);
    expect(secondRun.deletedObjects).toBe(0);
    expect(secondRun.deletedBytes).toBe(0);

    expect(DEFAULT_GC_GRACE_PERIOD_MS).toBe(24 * 60 * 60 * 1000);
    const freshChunkId = createHash('sha256').update('fresh-unreferenced-gc-chunk').digest('hex');
    const freshChunkKey = `${config.chunkPrefix}gc-test/${freshChunkId}`;
    await putS3Object({
      body: 'fresh-unreferenced-gc-chunk',
      config,
      contentType: 'application/octet-stream',
      key: freshChunkKey,
    });
    const graceRun = await runChunkGarbageCollection({
      sql: activeSql,
      store: activeStore,
      batchSize: 2,
    });
    expect(graceRun.deletedObjects).toBe(0);
    expect(graceRun.graceProtectedObjects).toBeGreaterThanOrEqual(1);
    expect(await (await getS3Object(config, freshChunkKey)).text()).toBe(
      'fresh-unreferenced-gc-chunk'
    );

    console.log(
      `GC_E2E_RESULT v1-unique-deleted=${v1UniqueIds.size} shared+v2-chunks-kept=${v2ChunkIds.size} v2-retrievable-after-GC=yes grace-protects-fresh=yes idempotent=yes dryRun-noop=yes first-run-kept=${firstRun.keptObjects} first-run-deleted=${firstRun.deletedObjects}`
    );
  });
});
