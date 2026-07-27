import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  Catalog,
  type CatalogDatabase,
  ExactStorageCatalog,
  openCatalogDatabase,
  runCatalogMigrations,
} from '../catalog';
import { type CasConfig, loadCasConfig } from '../storage-core/config';
import { parseDeliveryManifest } from '../storage-core/deliveryManifest';
import {
  localCasStore,
  readCasIndexObject,
  type S3CasStore,
  s3CasStore,
  verifyDesyncCli,
} from '../storage-core/desyncCas';
import { DurableExactStorage } from '../storage-core/durableExactStorage';
import { S3ExactStoragePort } from '../storage-core/exactStorage';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
import { createS3Bucket, deleteS3Objects, listS3Objects } from '../storage-core/s3Control';
import { waitForMinioReady } from '../testing/minioReadiness';
import { waitForPostgres } from '../testing/postgresReadiness';
import { createUnityPackageRecordFixture } from '../testing/unityPackageFixture';
import {
  ingestVersion,
  promoteVersion,
  resolvePipelineCasIndexId,
  retrieveVersion,
} from './ingestPipeline';

const POSTGRES_IMAGE =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'; // postgres:17-alpine
const MINIO_IMAGE =
  'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e'; // minio/minio:RELEASE.2025-09-07T16-13-09Z
const databaseName = 'pipeline_promote_test';
const databasePassword = 'pipeline-promote-test-password';
const postgresContainerName = `yucp-pipeline-promote-pg-${randomBytes(6).toString('hex')}`;
const minioContainerName = `yucp-pipeline-promote-s3-${randomBytes(6).toString('hex')}`;

let sql: CatalogDatabase | undefined;
let catalog: Catalog | undefined;
let commonStore: S3CasStore | undefined;
let metadataStore: S3CasStore | undefined;
let protectedStore: S3CasStore | undefined;
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

async function publishedPort(containerName: string, containerPort: string): Promise<string> {
  const output = await requireDocker(['port', containerName, `${containerPort}/tcp`]);
  const match = output.match(/127\.0\.0\.1:(\d+)$/m);
  if (!match?.[1]) {
    throw new Error(`Could not determine ${containerName} published port from: ${output}`);
  }
  return match[1];
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

function requireCatalog(): Catalog {
  if (!catalog) {
    throw new Error('Promotion end-to-end catalog was not initialized');
  }
  return catalog;
}

function requireSql(): CatalogDatabase {
  if (!sql) {
    throw new Error('Promotion end-to-end database was not initialized');
  }
  return sql;
}

function requireStores(): {
  commonStore: S3CasStore;
  metadataStore: S3CasStore;
  protectedStore: S3CasStore;
  scratchRoot: string;
} {
  if (!commonStore || !metadataStore || !protectedStore) {
    throw new Error('Promotion end-to-end role stores were not initialized');
  }
  return {
    commonStore,
    metadataStore,
    protectedStore,
    scratchRoot: requireScratchPath(),
  };
}

function requireScratchPath(): string {
  if (!scratchPath) {
    throw new Error('Promotion end-to-end scratch directory was not initialized');
  }
  return scratchPath;
}

async function eventTypes(versionId: string): Promise<string[]> {
  const rows = await requireSql()<{ event_type: string }[]>`
    SELECT event_type
    FROM catalog_outbox
    WHERE aggregate_id = ${versionId}
    ORDER BY created_at, id
  `;
  return rows.map((row) => row.event_type);
}

async function cleanup(): Promise<void> {
  const activeSql = sql;
  sql = undefined;
  catalog = undefined;
  commonStore = undefined;
  metadataStore = undefined;
  protectedStore = undefined;
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
      postgresContainerName,
      '--env',
      `POSTGRES_PASSWORD=${databasePassword}`,
      '--env',
      `POSTGRES_DB=${databaseName}`,
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data',
      POSTGRES_IMAGE,
    ]);
    startedContainers.add(postgresContainerName);

    const accessKeyId = `test-${randomBytes(12).toString('hex')}`;
    const secretAccessKey = randomBytes(32).toString('hex');
    await requireDocker([
      'run',
      '--detach',
      '--rm',
      '--name',
      minioContainerName,
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
    startedContainers.add(minioContainerName);

    await waitForPostgres({ containerName: postgresContainerName, databaseName, runDocker });
    const postgresPort = await publishedPort(postgresContainerName, '5432');
    const minioPort = await publishedPort(minioContainerName, '9000');
    const minioEndpoint = `http://127.0.0.1:${minioPort}`;
    await waitForMinioReady({ endpoint: minioEndpoint });

    sql = openCatalogDatabase(
      `postgres://postgres:${databasePassword}@127.0.0.1:${postgresPort}/${databaseName}`
    );
    await runCatalogMigrations(sql);
    catalog = new Catalog(sql);

    const bucketBase = `pipeline-promote-${randomBytes(8).toString('hex')}`;
    const roleConfig = (role: string): CasConfig =>
      loadCasConfig({
        CAS_S3_ENDPOINT: minioEndpoint,
        CAS_S3_REGION: 'us-east-1',
        CAS_S3_BUCKET: `${bucketBase}-${role}`,
        CAS_S3_ACCESS_KEY_ID: accessKeyId,
        CAS_S3_SECRET_ACCESS_KEY: secretAccessKey,
      });
    const commonConfig = roleConfig('common');
    const metadataConfig = roleConfig('metadata');
    const protectedConfig = roleConfig('protected');
    for (const config of [commonConfig, metadataConfig, protectedConfig]) {
      await createS3Bucket(config);
    }
    const durableStorage = new DurableExactStorage(
      new ExactStorageCatalog(requireSql()),
      new S3ExactStoragePort({
        common: commonConfig,
        metadata: metadataConfig,
        protected: protectedConfig,
      })
    );
    commonStore = s3CasStore(commonConfig, {
      durableStorage,
      storageRole: 'common',
    });
    metadataStore = s3CasStore(metadataConfig, {
      durableStorage,
      storageRole: 'metadata',
    });
    protectedStore = s3CasStore(protectedConfig, {
      durableStorage,
      storageRole: 'protected',
    });
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-pipeline-promote-e2e-'));
  } catch (error) {
    await cleanup();
    throw error;
  }
});

afterAll(cleanup);

describe.serial('ingest promotion against throwaway MinIO and PostgreSQL', () => {
  it('reassembles before READY, retrieves byte-exact, rejects a missing chunk, and deduplicates', async () => {
    const activeCatalog = requireCatalog();
    const stores = requireStores();
    const commonConfig = stores.commonStore.config;
    const scratch = requireScratchPath();
    const rawV1Path = join(scratch, 'artifact-v1.unitypackage');
    const rawV2Path = join(scratch, 'artifact-v2.unitypackage');
    const expectedV1 = await createUnityPackageRecordFixture({
      outputPath: rawV1Path,
      timestamp: new Date('2026-07-24T00:00:00.000Z'),
      versionSeed: 'version-one',
    });
    await createUnityPackageRecordFixture({
      outputPath: rawV2Path,
      timestamp: new Date('2026-07-24T00:00:00.000Z'),
      versionSeed: 'version-two',
    });
    const assembledV1 = await ingestVersion({
      catalog: activeCatalog,
      creatorId: 'creator-pipeline',
      packageId: 'pipeline-package',
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      ...stores,
      version: '1.0.0',
      inputPath: rawV1Path,
    });
    expect(assembledV1).toMatchObject({ state: 'ASSEMBLED' });
    const wrongLocalStore = localCasStore(join(scratch, 'wrong-local-store'));
    await expect(
      retrieveVersion({
        catalog: activeCatalog,
        commonStore: stores.commonStore,
        metadataStore: wrongLocalStore,
        protectedStore: stores.protectedStore,
        versionId: assembledV1.id,
        outputPath: join(scratch, 'wrong-kind-retrieval'),
      })
    ).rejects.toThrow('CAS object store kind s3 does not match local store');
    const readyV1 = await promoteVersion({
      catalog: activeCatalog,
      ...stores,
      versionId: assembledV1.id,
    });
    expect(readyV1).toMatchObject({ state: 'READY', error: null });
    expect(await eventTypes(readyV1.id)).toEqual([
      'catalog.version.created',
      'catalog.version.uploading',
      'catalog.version.assembled',
      'catalog.version.promoting',
      'catalog.version.ready',
    ]);

    const retrievedV1Path = await retrieveVersion({
      catalog: activeCatalog,
      ...stores,
      versionId: readyV1.id,
      outputPath: join(scratch, 'retrieved-v1'),
    });
    for (const [relativePath, expectedSha256] of expectedV1) {
      expect(await sha256File(join(retrievedV1Path, relativePath))).toBe(expectedSha256);
    }

    const afterV1 = await listS3Objects(commonConfig);
    const v1Chunks = afterV1.filter((object) => object.key.startsWith(commonConfig.chunkPrefix));
    const v1ChunkBytes = v1Chunks.reduce((total, object) => total + object.size, 0);
    expect(v1Chunks.length).toBeGreaterThan(1);

    const assembledV2 = await ingestVersion({
      catalog: activeCatalog,
      creatorId: 'creator-pipeline',
      packageId: 'pipeline-package',
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      ...stores,
      version: '2.0.0',
      inputPath: rawV2Path,
    });
    const readyV2 = await promoteVersion({
      catalog: activeCatalog,
      ...stores,
      versionId: assembledV2.id,
    });
    expect(readyV2.state).toBe('READY');

    const afterV2 = await listS3Objects(commonConfig);
    const v2Chunks = afterV2.filter((object) => object.key.startsWith(commonConfig.chunkPrefix));
    const v2ChunkBytes = v2Chunks.reduce((total, object) => total + object.size, 0);
    const v2DeltaBytes = v2ChunkBytes - v1ChunkBytes;
    const v2DeltaChunks = v2Chunks.length - v1Chunks.length;
    expect(v2DeltaBytes).toBeGreaterThan(0);
    expect(v2DeltaBytes).toBeLessThan(v1ChunkBytes / 3);

    const assembledKindMismatch = await ingestVersion({
      catalog: activeCatalog,
      creatorId: 'creator-pipeline',
      packageId: 'pipeline-package',
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      ...stores,
      version: '2.5.0',
      inputPath: rawV1Path,
    });
    await expect(
      promoteVersion({
        catalog: activeCatalog,
        commonStore: stores.commonStore,
        metadataStore: wrongLocalStore,
        protectedStore: stores.protectedStore,
        scratchRoot: scratch,
        versionId: assembledKindMismatch.id,
      })
    ).rejects.toThrow('CAS object store kind s3 does not match local store');
    expect(await activeCatalog.getVersion(assembledKindMismatch.id)).toMatchObject({
      state: 'FAILED',
    });

    const assembledBad = await ingestVersion({
      catalog: activeCatalog,
      creatorId: 'creator-pipeline',
      packageId: 'pipeline-package',
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      ...stores,
      version: '3.0.0',
      inputPath: rawV1Path,
    });
    if (!assembledBad.assemblyObjectId) {
      throw new Error('Bad-store fixture did not persist a CAS index ID');
    }
    const badManifest = parseDeliveryManifest(
      JSON.parse(
        await readCasIndexObject({
          indexId: resolvePipelineCasIndexId(stores.metadataStore, assembledBad.assemblyObjectId),
          store: stores.metadataStore,
        })
      )
    );
    const badChunks = badManifest.files.flatMap((file) => file.chunks);
    const missingChunk = badChunks[0];
    if (!missingChunk) {
      throw new Error('Bad-store fixture did not produce a desync chunk');
    }
    const missingObject = (await listS3Objects(commonConfig, commonConfig.chunkPrefix)).find(
      (object) => object.key.endsWith(`/${missingChunk.id}`)
    );
    if (!missingObject) {
      throw new Error(`Could not find MinIO object for desync chunk ${missingChunk.id}`);
    }
    await deleteS3Objects(commonConfig, [missingObject.key]);

    let promotionError: unknown;
    try {
      await promoteVersion({
        catalog: activeCatalog,
        ...stores,
        versionId: assembledBad.id,
      });
    } catch (error) {
      promotionError = error;
    }
    expect(promotionError).toBeInstanceOf(Error);
    const failed = await activeCatalog.getVersion(assembledBad.id);
    expect(failed).toMatchObject({ state: 'FAILED' });
    expect(failed?.error?.trim().length).toBeGreaterThan(0);
    const failedEvents = await eventTypes(assembledBad.id);
    expect(failedEvents).toContain('catalog.version.failed');
    expect(failedEvents).not.toContain('catalog.version.ready');

    console.log(
      `PIPELINE_PROMOTE_E2E_RESULT lifecycle-to-READY=${readyV1.state} readiness-guard-FAILED-on-bad-store=${failed?.state} store-kind-mismatch=retrieve+promote dedup-through-S3=v1ChunkBytes:${v1ChunkBytes},v2DeltaChunks:${v2DeltaChunks},v2DeltaBytes:${v2DeltaBytes}`
    );
  });
});
