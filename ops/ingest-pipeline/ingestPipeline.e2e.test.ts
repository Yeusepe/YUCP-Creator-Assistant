import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  Catalog,
  type CatalogDatabase,
  openCatalogDatabase,
  runCatalogMigrations,
} from '../catalog';
import { CANONICAL_FORMAT_TAGS, canonicalizeArtifact } from '../storage-core/canonicalizer';
import { deliveryManifestObjectId } from '../storage-core/deliveryManifest';
import {
  inspectDesyncIndex,
  localCasStore,
  measureLocalStore,
  verifyDesyncCli,
} from '../storage-core/desyncCas';
import { createUnityPackageFixture } from '../testing/unityPackageFixture';
import { ingestVersion, retrieveVersion } from './ingestPipeline';

const postgresImage = 'postgres:17-alpine';
const databaseName = 'ingest_test';
const databasePassword = 'ingest-test-password';
const containerName = `yucp-ingest-e2e-${randomUUID()}`;

let sql: CatalogDatabase | undefined;
let catalog: Catalog | undefined;
let containerStarted = false;
let scratchPath: string | undefined;
let rawV1Path: string | undefined;
let rawV2Path: string | undefined;
let changedInnerFiles: string[] = [];

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CatalogRow {
  id: string;
  state: string;
  format_tag: string | null;
  canonical_sha256: string | null;
  cas_index_id: string | null;
  error: string | null;
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

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastResult: CommandResult | undefined;

  while (Date.now() < deadline) {
    lastResult = await runDocker([
      'exec',
      containerName,
      'pg_isready',
      '--username',
      'postgres',
      '--dbname',
      databaseName,
    ]);
    if (lastResult.exitCode === 0) {
      return;
    }
    await Bun.sleep(250);
  }

  const logs = await runDocker(['logs', containerName]);
  throw new Error(
    `PostgreSQL did not become ready within 60 seconds.\n${lastResult?.stderr ?? ''}\n${logs.stderr}\n${logs.stdout}`
  );
}

function requireCatalog(): Catalog {
  if (!catalog) {
    throw new Error('Ingest end-to-end test was not initialized');
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

function requireFixturePath(path: string | undefined, version: string): string {
  if (!path) {
    throw new Error(`Unitypackage fixture ${version} was not initialized`);
  }
  return path;
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

async function outboxEventTypes(versionId: string): Promise<string[]> {
  const rows = await requireSql()<
    {
      event_type: string;
    }[]
  >`
    SELECT event_type
    FROM catalog_outbox
    WHERE aggregate_id = ${versionId}
    ORDER BY created_at, id
  `;
  return rows.map((row) => row.event_type);
}

async function versionRow(packageId: string, version: string): Promise<CatalogRow> {
  const rows = await requireSql()<CatalogRow[]>`
    SELECT id, state, format_tag, canonical_sha256, cas_index_id, error
    FROM package_versions
    WHERE package_id = ${packageId} AND version = ${version}
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Missing package version row for ${packageId}@${version}`);
  }
  return row;
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
    await waitForPostgres();

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

    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-e2e-'));
    const v1TreePath = join(scratchPath, 'v1-tree');
    const v2TreePath = join(scratchPath, 'v2-tree');
    const v1Hashes = await createUnityPackageFixture({
      outputPath: join(scratchPath, 'fixture-v1.unitypackage'),
      timestamp: new Date('2025-01-01'),
      treePath: v1TreePath,
      versionSeed: 'version-one',
    });
    const v2Hashes = await createUnityPackageFixture({
      outputPath: join(scratchPath, 'fixture-v2.unitypackage'),
      timestamp: new Date('2026-01-01'),
      treePath: v2TreePath,
      versionSeed: 'version-two',
    });
    changedInnerFiles = Array.from(v1Hashes.keys()).filter(
      (path) => v1Hashes.get(path) !== v2Hashes.get(path)
    );

    rawV1Path = join(scratchPath, 'fixture-v1.unitypackage');
    rawV2Path = join(scratchPath, 'fixture-v2.unitypackage');
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
  await requireSql()`TRUNCATE TABLE catalog_outbox, package_versions`;
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

describe.serial('canonical ingest pipeline end to end', () => {
  it('assembles, retrieves byte-exact, and deduplicates two real versions', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const scratch = requireScratchPath();
    const fixtureV1 = requireFixturePath(rawV1Path, 'v1');
    const fixtureV2 = requireFixturePath(rawV2Path, 'v2');
    const storePath = join(scratch, 'shared-store');
    const indexDir = join(scratch, 'indexes');
    expect(changedInnerFiles).toEqual(['Assets/000-version.asset']);

    const expectedCanonical = await canonicalizeArtifact({
      inputPath: fixtureV1,
      outputPath: join(scratch, 'expected-v1.canonical'),
    });
    const expectedCanonicalSha256 = await sha256File(expectedCanonical.path);
    const assembledV1 = await ingestVersion({
      catalog: activeCatalog,
      storePath,
      indexDir,
      packageId: 'avatar-package',
      version: '1.0.0',
      inputPath: fixtureV1,
    });

    expect(assembledV1).toMatchObject({
      state: 'ASSEMBLED',
      formatTag: CANONICAL_FORMAT_TAGS.tarGzip,
      canonicalSha256: expectedCanonicalSha256,
      casIndexId: resolve(indexDir, `${expectedCanonicalSha256}.caibx`),
      error: null,
    });
    const persistedV1 = await versionRow('avatar-package', '1.0.0');
    expect(persistedV1).toMatchObject({
      state: 'ASSEMBLED',
      format_tag: CANONICAL_FORMAT_TAGS.tarGzip,
      canonical_sha256: expectedCanonicalSha256,
      cas_index_id: assembledV1.casIndexId,
      error: null,
    });
    expect(persistedV1.format_tag).not.toBeNull();
    expect(persistedV1.canonical_sha256).not.toBeNull();
    expect(persistedV1.cas_index_id).not.toBeNull();
    expect(await outboxEventTypes(assembledV1.id)).toEqual([
      'catalog.version.created',
      'catalog.version.uploading',
      'catalog.version.assembled',
    ]);

    await expect(
      readFile(resolve(indexDir, deliveryManifestObjectId(assembledV1.id)), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    if (!assembledV1.casIndexId) {
      throw new Error('Assembled version did not persist its desync index ID');
    }
    const indexChunks = await inspectDesyncIndex({
      indexId: assembledV1.casIndexId,
      store: localCasStore(storePath),
    });
    const manifestBytes = Buffer.concat(
      await Promise.all(
        indexChunks.map(async (chunk) => {
          const bytes = await readFile(join(storePath, chunk.id.slice(0, 4), chunk.id));
          expect(bytes.byteLength).toBe(chunk.size);
          return bytes;
        })
      )
    );
    expect(manifestBytes).toEqual(await readFile(expectedCanonical.path));

    const singleVersionStore = await measureLocalStore(storePath);
    const reconstructedV1Path = await retrieveVersion({
      catalog: activeCatalog,
      storePath,
      versionId: assembledV1.id,
      outputPath: join(scratch, 'retrieved-v1.unitypackage'),
    });
    expect(await sha256File(reconstructedV1Path)).toBe(expectedCanonicalSha256);
    expect(await readFile(reconstructedV1Path)).toEqual(await readFile(expectedCanonical.path));

    await database`
      UPDATE package_versions
      SET canonical_sha256 = ${'f'.repeat(64)}
      WHERE id = ${assembledV1.id}
    `;
    let mismatchError: unknown;
    try {
      await retrieveVersion({
        catalog: activeCatalog,
        storePath,
        versionId: assembledV1.id,
        outputPath: join(scratch, 'mismatched-v1.unitypackage'),
      });
    } catch (error) {
      mismatchError = error;
    } finally {
      await database`
        UPDATE package_versions
        SET canonical_sha256 = ${expectedCanonicalSha256}
        WHERE id = ${assembledV1.id}
      `;
    }
    expect(mismatchError).toHaveProperty(
      'message',
      expect.stringContaining('Reconstructed SHA-256 mismatch')
    );

    const assembledV2 = await ingestVersion({
      catalog: activeCatalog,
      storePath,
      indexDir,
      packageId: 'avatar-package',
      version: '2.0.0',
      inputPath: fixtureV2,
    });
    expect(assembledV2).toMatchObject({
      state: 'ASSEMBLED',
      formatTag: CANONICAL_FORMAT_TAGS.tarGzip,
      error: null,
    });
    const twoVersionStore = await measureLocalStore(storePath);
    const dedupRatio = twoVersionStore.bytes / singleVersionStore.bytes;
    expect(twoVersionStore.bytes).toBeGreaterThan(singleVersionStore.bytes);
    expect(dedupRatio).toBeLessThan(1.6);

    console.log(
      [
        'INGEST_E2E_RESULT',
        `happy=${assembledV1.state}`,
        'byte-exact-retrieve=yes',
        `delivery-manifest=withheld-until-ready index=ordered(${indexChunks.length} chunks)`,
        `single-version-store=${singleVersionStore.bytes} bytes (${singleVersionStore.chunks} chunks)`,
        `two-version-store=${twoVersionStore.bytes} bytes (${twoVersionStore.chunks} chunks)`,
        `dedup-ratio=${dedupRatio.toFixed(4)}`,
      ].join('\n')
    );
  });

  it('records failures from UPLOADING and directly from CREATED', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const scratch = requireScratchPath();
    const storePath = join(scratch, 'failure-store');
    const indexDir = join(scratch, 'failure-indexes');

    let uploadingError: unknown;
    try {
      await ingestVersion({
        catalog: activeCatalog,
        storePath,
        indexDir,
        packageId: 'failure-package',
        version: 'uploading-failure',
        inputPath: join(scratch, 'missing.unitypackage'),
      });
    } catch (error) {
      uploadingError = error;
    }
    expect(uploadingError).toBeInstanceOf(Error);
    const uploadingFailure = await versionRow('failure-package', 'uploading-failure');
    expect(uploadingFailure).toMatchObject({
      state: 'FAILED',
      format_tag: null,
      canonical_sha256: null,
      cas_index_id: null,
    });
    expect(uploadingFailure.error?.trim().length).toBeGreaterThan(0);
    expect(await outboxEventTypes(uploadingFailure.id)).toEqual([
      'catalog.version.created',
      'catalog.version.uploading',
      'catalog.version.failed',
    ]);

    await database`ALTER TABLE catalog_outbox DROP CONSTRAINT catalog_outbox_event_type_check`;
    await database`
      ALTER TABLE catalog_outbox
      ADD CONSTRAINT catalog_outbox_event_type_check CHECK (
        length(btrim(event_type)) > 0 AND event_type <> 'catalog.version.uploading'
      ) NOT VALID
    `;
    let createdError: unknown;
    try {
      await ingestVersion({
        catalog: activeCatalog,
        storePath,
        indexDir,
        packageId: 'failure-package',
        version: 'created-failure',
        inputPath: requireFixturePath(rawV1Path, 'v1'),
      });
    } catch (error) {
      createdError = error;
    } finally {
      await database`ALTER TABLE catalog_outbox DROP CONSTRAINT catalog_outbox_event_type_check`;
      await database`
        ALTER TABLE catalog_outbox
        ADD CONSTRAINT catalog_outbox_event_type_check CHECK (length(btrim(event_type)) > 0)
      `;
    }

    expect(createdError).toMatchObject({
      code: '23514',
      constraint_name: 'catalog_outbox_event_type_check',
    });
    const createdFailure = await versionRow('failure-package', 'created-failure');
    expect(createdFailure).toMatchObject({
      state: 'FAILED',
      format_tag: null,
      canonical_sha256: null,
      cas_index_id: null,
    });
    expect(createdFailure.error?.trim().length).toBeGreaterThan(0);
    expect(await outboxEventTypes(createdFailure.id)).toEqual([
      'catalog.version.created',
      'catalog.version.failed',
    ]);

    console.log(
      `INGEST_FAILURE_RESULT uploading=${uploadingFailure.state} created=${createdFailure.state}`
    );
  });
});
