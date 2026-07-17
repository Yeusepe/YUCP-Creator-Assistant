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
import { ingestVersion, retrieveVersion } from '../ingest-pipeline';
import { type CasConfig, loadCasConfig } from '../storage-core/config';
import {
  localCasStore,
  type S3CasStore,
  s3CasStore,
  verifyDesyncCli,
} from '../storage-core/desyncCas';
import { createS3Bucket } from '../storage-core/s3Control';
import { createIngestScheduler, type IngestScheduler } from './scheduler';

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
const schedulers = new Set<IngestScheduler>();
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

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await runDocker([
      'exec',
      postgresContainerName,
      'pg_isready',
      '--username',
      'postgres',
      '--dbname',
      databaseName,
    ]);
    if (result.exitCode === 0) {
      return;
    }
    await Bun.sleep(250);
  }
  const logs = await runDocker(['logs', postgresContainerName]);
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
  const logs = await runDocker(['logs', minioContainerName]);
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

    await waitForPostgres();
    const postgresPort = await publishedPort(postgresContainerName, '5432');
    const minioPort = await publishedPort(minioContainerName, '9000');
    const minioEndpoint = `http://127.0.0.1:${minioPort}`;
    await waitForMinio(minioEndpoint);

    sql = openCatalogDatabase(
      `postgres://postgres:${databasePassword}@127.0.0.1:${postgresPort}/${databaseName}`
    );
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
});
