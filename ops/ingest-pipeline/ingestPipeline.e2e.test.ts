import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  Catalog,
  type CatalogDatabase,
  openCatalogDatabase,
  runCatalogMigrations,
} from '../catalog';
import {
  deliveryAssemblyObjectId,
  deliveryManifestObjectId,
  parseDeliveryManifest,
} from '../storage-core/deliveryManifest';
import {
  localCasStore,
  measureLocalStore,
  readCasIndexObject,
  verifyDesyncCli,
} from '../storage-core/desyncCas';
import { waitForPostgres } from '../testing/postgresReadiness';
import { createUnityPackageRecordFixture } from '../testing/unityPackageFixture';
import { ingestVersion, promoteVersion, retrieveVersion } from './ingestPipeline';

const postgresImage =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'; // postgres:17-alpine
const databaseName = 'ingest_test';
const databasePassword = 'ingest-test-password';
const containerName = `yucp-ingest-e2e-${randomUUID()}`;

let sql: CatalogDatabase | undefined;
let catalog: Catalog | undefined;
let containerStarted = false;
let scratchPath: string | undefined;
let rawV1Path: string | undefined;
let rawV2Path: string | undefined;
let v1Hashes: Map<string, string> | undefined;
let v2Hashes: Map<string, string> | undefined;

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function runDocker(args: string[]): Promise<CommandResult> {
  const process = Bun.spawn(['docker', ...args], {
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
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

async function removePostgresContainer(): Promise<void> {
  if (!containerStarted) {
    return;
  }
  const result = await runDocker(['rm', '--force', containerName]);
  containerStarted = false;
  if (result.exitCode !== 0 && !result.stderr.includes('No such container')) {
    throw new Error(
      `Failed to remove PostgreSQL test container: ${result.stderr || result.stdout}`
    );
  }
}

function requireCatalog(): Catalog {
  if (!catalog) {
    throw new Error('Ingest end-to-end catalog was not initialized');
  }
  return catalog;
}

function requireSql(): CatalogDatabase {
  if (!sql) {
    throw new Error('Ingest end-to-end database was not initialized');
  }
  return sql;
}

function requireScratchPath(): string {
  if (!scratchPath) {
    throw new Error('Ingest end-to-end scratch directory was not initialized');
  }
  return scratchPath;
}

function requireFixturePath(path: string | undefined, name: string): string {
  if (!path) {
    throw new Error(`Unity package fixture ${name} was not initialized`);
  }
  return path;
}

function requireHashes(hashes: Map<string, string> | undefined, name: string): Map<string, string> {
  if (!hashes) {
    throw new Error(`Unity package hashes ${name} were not initialized`);
  }
  return hashes;
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

function localPipelineStores(root: string) {
  return {
    commonStore: localCasStore(join(root, 'common')),
    metadataStore: localCasStore(join(root, 'metadata')),
    protectedStore: localCasStore(join(root, 'protected')),
  };
}

async function readManifest(metadataRoot: string, versionId: string) {
  return parseDeliveryManifest(
    JSON.parse(
      await readCasIndexObject({
        indexId: join(metadataRoot, deliveryManifestObjectId(versionId)),
        store: localCasStore(metadataRoot),
      })
    )
  );
}

function chunkIds(manifest: ReturnType<typeof parseDeliveryManifest>): Set<string> {
  return new Set(manifest.files.flatMap((file) => file.chunks.map((chunk) => chunk.id)));
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
      containerName,
      '--env',
      `POSTGRES_PASSWORD=${databasePassword}`,
      '--env',
      `POSTGRES_DB=${databaseName}`,
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data',
      postgresImage,
    ]);
    containerStarted = true;
    await waitForPostgres({ containerName, databaseName, runDocker });

    const portOutput = await requireDocker(['port', containerName, '5432/tcp']);
    const portMatch = /127\.0\.0\.1:(\d+)$/.exec(portOutput);
    if (!portMatch?.[1]) {
      throw new Error(`Could not determine PostgreSQL test port from: ${portOutput}`);
    }
    sql = openCatalogDatabase(
      `postgres://postgres:${databasePassword}@127.0.0.1:${portMatch[1]}/${databaseName}`
    );
    await runCatalogMigrations(sql);
    catalog = new Catalog(sql);

    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-logical-e2e-'));
    rawV1Path = join(scratchPath, 'fixture-v1.unitypackage');
    rawV2Path = join(scratchPath, 'fixture-v2.unitypackage');
    v1Hashes = await createUnityPackageRecordFixture({
      outputPath: rawV1Path,
      timestamp: new Date('2025-01-01'),
      versionSeed: 'version-one',
    });
    v2Hashes = await createUnityPackageRecordFixture({
      outputPath: rawV2Path,
      timestamp: new Date('2026-01-01'),
      versionSeed: 'version-two',
    });
  } catch (error) {
    const activeSql = sql;
    sql = undefined;
    catalog = undefined;
    try {
      await activeSql?.end({ timeout: 1 });
    } finally {
      if (scratchPath) {
        assertScratchPath(scratchPath);
        await rm(scratchPath, { force: true, recursive: true });
        scratchPath = undefined;
      }
      await removePostgresContainer();
    }
    throw error;
  }
});

beforeEach(async () => {
  await requireSql()`TRUNCATE TABLE catalog_outbox, package_versions CASCADE`;
});

afterAll(async () => {
  const activeSql = sql;
  sql = undefined;
  catalog = undefined;
  try {
    await activeSql?.end({ timeout: 1 });
  } finally {
    if (scratchPath) {
      assertScratchPath(scratchPath);
      await rm(scratchPath, { force: true, recursive: true });
      scratchPath = undefined;
    }
    await removePostgresContainer();
  }
});

describe.serial('logical-tree ingest pipeline end to end', () => {
  it('publishes two versions, reuses physical chunks, and retrieves exact logical files', async () => {
    const root = join(requireScratchPath(), randomUUID());
    const stores = localPipelineStores(root);
    await mkdir(stores.metadataStore.storePath, { recursive: true });

    const assembledV1 = await ingestVersion({
      catalog: requireCatalog(),
      creatorId: 'creator-jammr',
      inputPath: requireFixturePath(rawV1Path, 'v1'),
      packageId: 'com.yucp.jammr',
      protectionPolicyId: 'common-only-v1',
      ...stores,
      version: '1.0.0',
    });
    const readyV1 = await promoteVersion({
      catalog: requireCatalog(),
      ...stores,
      versionId: assembledV1.id,
    });
    const manifestV1 = await readManifest(stores.metadataStore.storePath, readyV1.id);
    const measurementV1 = await measureLocalStore(stores.commonStore.storePath);

    const assembledV2 = await ingestVersion({
      catalog: requireCatalog(),
      creatorId: 'creator-jammr',
      inputPath: requireFixturePath(rawV2Path, 'v2'),
      packageId: 'com.yucp.jammr',
      protectionPolicyId: 'common-only-v1',
      ...stores,
      version: '1.1.0',
    });
    const readyV2 = await promoteVersion({
      catalog: requireCatalog(),
      ...stores,
      versionId: assembledV2.id,
    });
    const manifestV2 = await readManifest(stores.metadataStore.storePath, readyV2.id);
    const measurementV2 = await measureLocalStore(stores.commonStore.storePath);

    expect(readyV1.state).toBe('READY');
    expect(readyV2.state).toBe('READY');
    expect(manifestV1.releaseRoot).not.toBe(manifestV2.releaseRoot);
    const v1ChunkIds = chunkIds(manifestV1);
    const v2ChunkIds = chunkIds(manifestV2);
    expect([...v1ChunkIds].some((chunkId) => v2ChunkIds.has(chunkId))).toBe(true);
    expect(measurementV2.chunks).toBeLessThan(v1ChunkIds.size + v2ChunkIds.size);
    expect(measurementV2.bytes).toBeGreaterThan(measurementV1.bytes);

    const retrievedRoot = join(root, 'retrieved-v2');
    await retrieveVersion({
      catalog: requireCatalog(),
      outputPath: retrievedRoot,
      ...stores,
      versionId: readyV2.id,
    });
    for (const [logicalPath, expectedSha256] of requireHashes(v2Hashes, 'v2')) {
      const bytes = await readFile(join(retrievedRoot, ...logicalPath.split('/')));
      expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(expectedSha256);
    }
    expect(
      await stat(join(stores.metadataStore.storePath, deliveryAssemblyObjectId(readyV2.id))).catch(
        () => null
      )
    ).toBeNull();
  }, 60_000);

  it('rejects a corrupt canonical chunk before READY publication', async () => {
    const root = join(requireScratchPath(), randomUUID());
    const stores = localPipelineStores(root);
    await mkdir(stores.metadataStore.storePath, { recursive: true });
    const assembled = await ingestVersion({
      catalog: requireCatalog(),
      creatorId: 'creator-corrupt',
      inputPath: requireFixturePath(rawV1Path, 'v1'),
      packageId: 'com.yucp.corrupt',
      protectionPolicyId: 'common-only-v1',
      ...stores,
      version: '1.0.0',
    });
    const assembly = parseDeliveryManifest(
      JSON.parse(
        await readFile(
          join(stores.metadataStore.storePath, deliveryAssemblyObjectId(assembled.id)),
          'utf8'
        )
      )
    );
    const chunk = assembly.files[0]?.chunks[0];
    if (!chunk) {
      throw new Error('Assembly fixture did not produce a chunk');
    }
    await writeFile(
      join(stores.commonStore.storePath, chunk.id.slice(0, 4), chunk.id),
      Buffer.alloc(chunk.size, 0x7f)
    );

    await expect(
      promoteVersion({
        catalog: requireCatalog(),
        ...stores,
        versionId: assembled.id,
      })
    ).rejects.toThrow('verification');
    expect(
      await stat(
        join(stores.metadataStore.storePath, deliveryManifestObjectId(assembled.id))
      ).catch(() => null)
    ).toBeNull();
    expect((await requireCatalog().getVersion(assembled.id))?.state).toBe('FAILED');
  }, 60_000);

  it('keeps the normalized tree lossless for the first version', async () => {
    const root = join(requireScratchPath(), randomUUID());
    const stores = localPipelineStores(root);
    await mkdir(stores.metadataStore.storePath, { recursive: true });
    const assembled = await ingestVersion({
      catalog: requireCatalog(),
      creatorId: 'creator-lossless',
      inputPath: requireFixturePath(rawV1Path, 'v1'),
      packageId: 'com.yucp.lossless',
      protectionPolicyId: 'common-only-v1',
      ...stores,
      version: '1.0.0',
    });
    const outputRoot = join(root, 'retrieved-v1');
    await retrieveVersion({
      catalog: requireCatalog(),
      outputPath: outputRoot,
      ...stores,
      versionId: assembled.id,
    });

    for (const [logicalPath, expectedSha256] of requireHashes(v1Hashes, 'v1')) {
      const bytes = await readFile(join(outputRoot, ...logicalPath.split('/')));
      expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(expectedSha256);
    }
  }, 60_000);
});
