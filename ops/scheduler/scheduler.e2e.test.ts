import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  Catalog,
  type CatalogDatabase,
  type CatalogOutboxEvent,
  openCatalogDatabase,
  type RedriveRequest,
  runCatalogMigrations,
} from '../catalog';
import { ingestVersion, promoteVersion, retrieveVersion } from '../ingest-pipeline';
import { type CasConfig, loadCasConfig } from '../storage-core/config';
import { deliveryManifestObjectId, parseDeliveryManifest } from '../storage-core/deliveryManifest';
import {
  localCasStore,
  readCasIndexObject,
  type S3CasStore,
  s3CasStore,
  verifyDesyncCli,
} from '../storage-core/desyncCas';
import { createS3Bucket } from '../storage-core/s3Control';
import { waitForMinioReady } from '../testing/minioReadiness';
import { waitForPostgres } from '../testing/postgresReadiness';
import { createIngestScheduler, type IngestScheduler } from './scheduler';
import { buildSchedulerRuntime, type SchedulerRuntime } from './server';

const POSTGRES_IMAGE = 'postgres:17-alpine';
const MINIO_IMAGE = 'minio/minio:RELEASE.2025-09-07T16-13-09Z';
const databaseName = 'scheduler_test';
const databasePassword = 'scheduler-test-password';
const postgresContainerName = `yucp-scheduler-pg-${randomBytes(6).toString('hex')}`;
const minioContainerName = `yucp-scheduler-s3-${randomBytes(6).toString('hex')}`;
const intervalMs = 10;

let sql: CatalogDatabase | undefined;
let catalog: Catalog | undefined;
let store: S3CasStore | undefined;
let scratchPath: string | undefined;
let catalogDatabaseUrl: string | undefined;
const schedulers = new Set<IngestScheduler>();
const schedulerRuntimes = new Set<SchedulerRuntime>();
const startedContainers = new Set<string>();

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runDocker(args: string[]): Promise<CommandResult> {
  const process = Bun.spawn(['docker', ...args], {
    stdin: 'ignore',
    stderr: 'pipe',
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

function requireSql(): CatalogDatabase {
  if (!sql) {
    throw new Error('Scheduler end-to-end database was not initialized');
  }
  return sql;
}

function requireCatalog(): Catalog {
  if (!catalog) {
    throw new Error('Scheduler end-to-end catalog was not initialized');
  }
  return catalog;
}

function requireStore(): S3CasStore {
  if (!store) {
    throw new Error('Scheduler end-to-end CAS store was not initialized');
  }
  return store;
}

function requireScratchPath(): string {
  if (!scratchPath) {
    throw new Error('Scheduler end-to-end scratch directory was not initialized');
  }
  return scratchPath;
}

function requireCatalogDatabaseUrl(): string {
  if (!catalogDatabaseUrl) {
    throw new Error('Scheduler end-to-end database URL was not initialized');
  }
  return catalogDatabaseUrl;
}

async function buildProductionSchedulerRuntime(): Promise<SchedulerRuntime> {
  const activeStore = requireStore();
  const sourceEnv = {
    INFISICAL_PROJECT_ID: 'scheduler-e2e-project',
    INFISICAL_CLIENT_ID: 'scheduler-e2e-client',
    INFISICAL_CLIENT_SECRET: 'scheduler-e2e-secret',
    SCHEDULER_BATCH_LIMIT: '1',
    SCHEDULER_INTERVAL_MS: String(intervalMs),
    SCHEDULER_STUCK_THRESHOLD_MS: '60000',
  } satisfies NodeJS.ProcessEnv;
  const runtime = await buildSchedulerRuntime(sourceEnv, async () => ({
    CONVEX_API_SECRET: 'scheduler-e2e-convex-api-secret',
    CONVEX_URL: 'https://scheduler-e2e.invalid',
    INTERNAL_SERVICE_AUTH_SECRET: 'scheduler-e2e-internal-auth-secret',
    CATALOG_DATABASE_URL: requireCatalogDatabaseUrl(),
    CAS_S3_ENDPOINT: activeStore.config.endpoint,
    CAS_S3_REGION: activeStore.config.region,
    CAS_S3_BUCKET: activeStore.config.bucket,
    CAS_S3_ACCESS_KEY_ID: activeStore.config.accessKeyId,
    CAS_S3_SECRET_ACCESS_KEY: activeStore.config.secretAccessKey,
  }));
  schedulerRuntimes.add(runtime);
  return runtime;
}

function assertScratchPath(path: string): void {
  const relativePath = relative(resolve(tmpdir()), resolve(path));
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Refusing to clean scratch path outside the system temp directory: ${path}`);
  }
}

function deterministicBytes(seed: string, byteLength: number): Buffer {
  return createHash('shake256', { outputLength: byteLength }).update(seed).digest();
}

async function waitFor(
  assertion: () => Promise<boolean>,
  description: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) {
      return;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForState(versionId: string, state: string): Promise<void> {
  await waitFor(
    async () => (await requireCatalog().getVersion(versionId))?.state === state,
    `package version ${versionId} to reach ${state}`
  );
}

async function dispatchPublishedEvent(event: CatalogOutboxEvent): Promise<void> {
  await requireSql()`
    INSERT INTO scheduler_test_dispatches (dispatch_key, dispatch_kind, version_id)
    VALUES (${event.id}, ${event.eventType}, ${event.aggregateId})
    ON CONFLICT (dispatch_key) DO NOTHING
  `;
}

async function dispatchRedrive(request: RedriveRequest): Promise<void> {
  await requireSql()`
    INSERT INTO scheduler_test_dispatches (dispatch_key, dispatch_kind, version_id)
    VALUES (${request.idempotencyKey}, 'catalog.version.redrive', ${request.version.id})
    ON CONFLICT (dispatch_key) DO NOTHING
  `;
}

async function dispatchCount(): Promise<number> {
  const rows = await requireSql()<{ count: number }[]>`
    SELECT count(*)::int AS count FROM scheduler_test_dispatches
  `;
  return rows[0]?.count ?? 0;
}

async function unpublishedCount(): Promise<number> {
  const rows = await requireSql()<{ count: number }[]>`
    SELECT count(*)::int AS count FROM catalog_outbox WHERE published_at IS NULL
  `;
  return rows[0]?.count ?? 0;
}

async function cleanup(): Promise<void> {
  for (const scheduler of schedulers) {
    await scheduler.stop();
  }
  schedulers.clear();
  for (const runtime of schedulerRuntimes) {
    await runtime.scheduler.stop();
    await runtime.database.end({ timeout: 1 });
  }
  schedulerRuntimes.clear();

  const activeSql = sql;
  sql = undefined;
  catalog = undefined;
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

    catalogDatabaseUrl = `postgres://postgres:${databasePassword}@127.0.0.1:${postgresPort}/${databaseName}`;
    sql = openCatalogDatabase(catalogDatabaseUrl);
    await runCatalogMigrations(sql);
    await sql`
      CREATE TABLE scheduler_test_dispatches (
        dispatch_key text PRIMARY KEY,
        dispatch_kind text NOT NULL,
        version_id text NOT NULL,
        dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;
    catalog = new Catalog(sql);

    const activeCasConfig: CasConfig = loadCasConfig({
      CAS_S3_ENDPOINT: minioEndpoint,
      CAS_S3_REGION: 'us-east-1',
      CAS_S3_BUCKET: `scheduler-${randomBytes(8).toString('hex')}`,
      CAS_S3_ACCESS_KEY_ID: accessKeyId,
      CAS_S3_SECRET_ACCESS_KEY: secretAccessKey,
    });
    await createS3Bucket(activeCasConfig);
    store = s3CasStore(activeCasConfig);
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-scheduler-e2e-'));
  } catch (error) {
    await cleanup();
    throw error;
  }
});

afterAll(cleanup);

describe.serial('ingest scheduler against throwaway MinIO and PostgreSQL', () => {
  it('rejects an interval above the setInterval ceiling', () => {
    expect(() =>
      createIngestScheduler({
        batchLimit: 1,
        catalog: requireCatalog(),
        database: requireSql(),
        intervalMs: 2_147_483_648,
        onError: () => undefined,
        publish: dispatchPublishedEvent,
        redrive: dispatchRedrive,
        store: requireStore(),
        stuckThresholdMs: 60_000,
      })
    ).toThrow('intervalMs must not exceed 2147483647');
  });

  it('drives later work, stops gracefully, avoids overlap, and continues after a tick error', async () => {
    const activeCatalog = requireCatalog();
    const activeSql = requireSql();
    const activeStore = requireStore();
    const scratch = requireScratchPath();
    const firstPath = join(scratch, 'first.bin');
    const secondPath = join(scratch, 'second.bin');
    const stopPath = join(scratch, 'stop-in-flight.bin');
    const afterStopPath = join(scratch, 'after-stop.bin');
    const badPath = join(scratch, 'bad-store.bin');
    const recoveryPath = join(scratch, 'recovery.bin');
    await Promise.all([
      writeFile(firstPath, deterministicBytes('scheduler-first', 512 * 1024)),
      writeFile(secondPath, deterministicBytes('scheduler-second', 512 * 1024)),
      writeFile(stopPath, deterministicBytes('scheduler-stop', 512 * 1024)),
      writeFile(afterStopPath, deterministicBytes('scheduler-after-stop', 512 * 1024)),
      writeFile(badPath, deterministicBytes('scheduler-bad-store', 512 * 1024)),
      writeFile(recoveryPath, deterministicBytes('scheduler-recovery', 512 * 1024)),
    ]);

    let activePublishes = 0;
    let maxConcurrentPublishes = 0;
    const errors: unknown[] = [];
    const scheduler = createIngestScheduler({
      batchLimit: 10,
      catalog: activeCatalog,
      database: activeSql,
      intervalMs,
      onError: (error) => {
        errors.push(error);
      },
      publish: async (event) => {
        activePublishes += 1;
        maxConcurrentPublishes = Math.max(maxConcurrentPublishes, activePublishes);
        try {
          await dispatchPublishedEvent(event);
          await Bun.sleep(75);
        } finally {
          activePublishes -= 1;
        }
      },
      redrive: dispatchRedrive,
      store: activeStore,
      stuckThresholdMs: 60_000,
    });
    schedulers.add(scheduler);

    const first = await ingestVersion({
      catalog: activeCatalog,
      inputPath: firstPath,
      packageId: 'scheduler-package',
      store: activeStore,
      version: '1.0.0',
    });
    expect(first.state).toBe('ASSEMBLED');
    scheduler.start();
    await waitForState(first.id, 'READY');

    const retrievedPath = await retrieveVersion({
      catalog: activeCatalog,
      outputPath: join(scratch, 'retrieved-first.bin'),
      store: activeStore,
      versionId: first.id,
    });
    expect(await readFile(retrievedPath)).toEqual(await readFile(firstPath));

    const second = await ingestVersion({
      catalog: activeCatalog,
      inputPath: secondPath,
      packageId: 'scheduler-package',
      store: activeStore,
      version: '2.0.0',
    });
    expect(second.state).toBe('ASSEMBLED');
    await waitForState(second.id, 'READY');
    await waitFor(async () => (await unpublishedCount()) === 0, 'the reconciler outbox to drain');
    await scheduler.stop();

    const stopInFlight = await ingestVersion({
      catalog: activeCatalog,
      inputPath: stopPath,
      packageId: 'scheduler-package',
      store: activeStore,
      version: '3.0.0',
    });
    const dispatchesBeforeRestart = await dispatchCount();
    scheduler.start();
    await waitFor(
      async () => (await dispatchCount()) > dispatchesBeforeRestart,
      'the restarted scheduler tick to enter its publish phase'
    );
    await scheduler.stop();
    expect(await activeCatalog.getVersion(stopInFlight.id)).toMatchObject({ state: 'READY' });

    const afterStop = await ingestVersion({
      catalog: activeCatalog,
      inputPath: afterStopPath,
      packageId: 'scheduler-package',
      store: activeStore,
      version: '4.0.0',
    });
    await Bun.sleep(intervalMs * 8);
    expect(await activeCatalog.getVersion(afterStop.id)).toMatchObject({ state: 'ASSEMBLED' });
    expect(maxConcurrentPublishes).toBe(1);
    expect(errors).toEqual([]);

    const badStoreVersion = await ingestVersion({
      catalog: activeCatalog,
      indexDir: join(scratch, 'bad-store-indexes'),
      inputPath: badPath,
      packageId: 'scheduler-errors',
      store: localCasStore(join(scratch, 'bad-store')),
      version: '1.0.0',
    });
    const recoveryVersion = await ingestVersion({
      catalog: activeCatalog,
      inputPath: recoveryPath,
      packageId: 'scheduler-errors',
      store: activeStore,
      version: '2.0.0',
    });
    const errorScheduler = createIngestScheduler({
      batchLimit: 1,
      catalog: activeCatalog,
      database: activeSql,
      intervalMs,
      onError: (error) => {
        errors.push(error);
      },
      publish: dispatchPublishedEvent,
      redrive: dispatchRedrive,
      store: activeStore,
      stuckThresholdMs: 60_000,
    });
    schedulers.add(errorScheduler);
    errorScheduler.start();

    await waitForState(badStoreVersion.id, 'FAILED');
    await waitForState(recoveryVersion.id, 'READY');
    await errorScheduler.stop();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toHaveProperty(
      'message',
      expect.stringContaining('CAS index store kind local does not match s3 store')
    );

    console.log(
      [
        'SCHEDULER_E2E_RESULT',
        'drives-to-READY=yes',
        'second-version-picked-up=yes',
        'graceful-stop=yes',
        'tick-error-does-not-crash=yes',
        `no-overlapping-ticks=${maxConcurrentPublishes === 1 ? 'yes' : 'no'}`,
      ].join('\n')
    );
  });

  it('automatically recovers a promotion failure from retained CAS assembly data', async () => {
    const activeCatalog = requireCatalog();
    const activeStore = requireStore();
    const scratch = requireScratchPath();
    const inputPath = join(scratch, 'automatic-redrive.bin');
    await writeFile(inputPath, deterministicBytes('scheduler-automatic-redrive', 512 * 1024));

    const assembled = await ingestVersion({
      catalog: activeCatalog,
      inputPath,
      packageId: 'scheduler-automatic-redrive',
      store: activeStore,
      version: '1.0.0',
    });
    expect(assembled).toMatchObject({
      state: 'ASSEMBLED',
      casIndexId: expect.any(String),
      canonicalSha256: expect.any(String),
    });

    await expect(
      promoteVersion({
        catalog: activeCatalog,
        store: localCasStore(join(scratch, 'transient-wrong-store')),
        versionId: assembled.id,
      })
    ).rejects.toThrow('CAS index store kind s3 does not match local store');
    const failed = await activeCatalog.getVersion(assembled.id);
    expect(failed).toMatchObject({
      state: 'FAILED',
      formatTag: assembled.formatTag,
      casIndexId: assembled.casIndexId,
      canonicalSha256: assembled.canonicalSha256,
    });
    await requireSql()`
      UPDATE package_versions
      SET next_attempt_at = clock_timestamp() - interval '1 millisecond'
      WHERE id = ${assembled.id}
    `;

    const runtime = await buildProductionSchedulerRuntime();
    runtime.scheduler.start();
    await waitForState(assembled.id, 'READY');
    await runtime.scheduler.stop();

    const manifest = parseDeliveryManifest(
      JSON.parse(
        await readCasIndexObject({
          indexId: deliveryManifestObjectId(assembled.id),
          store: activeStore,
        })
      )
    );
    expect(manifest.versionId).toBe(assembled.id);
    expect(manifest.chunks.length).toBeGreaterThan(0);
    const retrievedPath = await retrieveVersion({
      catalog: activeCatalog,
      outputPath: join(scratch, 'automatic-redrive-retrieved.bin'),
      store: activeStore,
      versionId: assembled.id,
    });
    expect(await readFile(retrievedPath)).toEqual(await readFile(inputPath));

    console.log(
      [
        'SCHEDULER_AUTO_REDRIVE_RESULT',
        'promotion-failure-left-FAILED=yes',
        'retained-cas-metadata=yes',
        'automatic-redrive-to-READY=yes',
        'delivery-manifest-readable=yes',
      ].join('\n')
    );
  });

  it('does not automatically recover a failure without CAS assembly data', async () => {
    const activeCatalog = requireCatalog();
    const activeSql = requireSql();
    const created = await activeCatalog.createVersion({
      packageId: 'scheduler-source-replay-required',
      version: '1.0.0',
    });
    const failed = await activeCatalog.markFailed(created.id, 'upload failed before assembly');
    expect(failed).toMatchObject({
      state: 'FAILED',
      casIndexId: null,
      canonicalSha256: null,
    });
    await activeSql`
      UPDATE package_versions
      SET next_attempt_at = clock_timestamp() - interval '1 millisecond'
      WHERE id = ${created.id}
    `;

    const runtime = await buildProductionSchedulerRuntime();
    runtime.scheduler.start();
    await Bun.sleep(intervalMs * 8);
    await runtime.scheduler.stop();

    expect(await activeCatalog.getVersion(created.id)).toMatchObject({
      state: 'FAILED',
      attempts: 2,
      casIndexId: null,
      canonicalSha256: null,
    });

    console.log(
      [
        'SCHEDULER_SOURCE_REPLAY_RESULT',
        'automatic-recovery=no',
        'state=FAILED',
        'cas-index=absent',
        'redrive-attempted=yes',
      ].join('\n')
    );
  });
});
