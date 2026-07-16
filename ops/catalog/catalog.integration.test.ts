import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  Catalog,
  type CatalogDatabase,
  CatalogInvariantError,
  IllegalCatalogTransitionError,
  openCatalogDatabase,
  reconcileCatalog,
  runCatalogMigrations,
} from './index';

const postgresImage = 'postgres:17-alpine';
const databaseName = 'catalog_test';
const databasePassword = 'catalog-test-password';
const containerName = `yucp-catalog-integration-${randomUUID()}`;

let sql: CatalogDatabase | undefined;
let catalog: Catalog | undefined;
let containerStarted = false;

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
    throw new Error('Catalog integration test was not initialized');
  }
  return catalog;
}

function requireSql(): CatalogDatabase {
  if (!sql) {
    throw new Error('Catalog integration database was not initialized');
  }
  return sql;
}

async function createUploadingVersion(version: string): Promise<string> {
  const activeCatalog = requireCatalog();
  const created = await activeCatalog.createVersion({
    packageId: 'package-reconciler',
    version,
  });
  await activeCatalog.advanceVersion(created.id, 'UPLOADING', {
    event: { type: 'catalog.version.uploading' },
  });
  return created.id;
}

beforeAll(async () => {
  try {
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
  } catch (error) {
    const activeSql = sql;
    sql = undefined;
    try {
      await activeSql?.end({ timeout: 1 });
    } finally {
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
    await removePostgresContainer();
  }
});

describe.serial('PostgreSQL catalog integration', () => {
  it('happy-path: persists the full lifecycle and every legal transition edge', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const sha256 = 'a'.repeat(64);
    const created = await activeCatalog.createVersion({
      packageId: 'avatar-package',
      version: '1.0.0',
    });

    expect(created).toMatchObject({ state: 'CREATED', formatTag: null });

    await activeCatalog.advanceVersion(created.id, 'UPLOADING', {
      event: { type: 'catalog.version.uploading' },
    });
    await activeCatalog.advanceVersion(created.id, 'ASSEMBLED', {
      fields: {
        formatTag: 'CANONICAL_TARGZ_V1',
        canonicalSha256: sha256,
        casIndexId: 'indexes/avatar-package/1.0.0.caibx',
      },
      event: { type: 'catalog.version.assembled' },
    });
    await activeCatalog.advanceVersion(created.id, 'PROMOTING', {
      event: { type: 'catalog.version.promoting' },
    });
    const ready = await activeCatalog.advanceVersion(created.id, 'READY', {
      event: { type: 'catalog.version.ready' },
    });

    expect(ready).toMatchObject({
      state: 'READY',
      formatTag: 'CANONICAL_TARGZ_V1',
      canonicalSha256: sha256,
      casIndexId: 'indexes/avatar-package/1.0.0.caibx',
      error: null,
    });
    expect(await activeCatalog.getVersion(created.id)).toMatchObject({
      state: 'READY',
      canonicalSha256: sha256,
      casIndexId: 'indexes/avatar-package/1.0.0.caibx',
    });

    const retryId = await createUploadingVersion('retry-edge');
    const failedUpload = await activeCatalog.markFailed(retryId, 'upload interrupted');
    expect(failedUpload).toMatchObject({ state: 'FAILED', error: 'upload interrupted' });
    const retried = await activeCatalog.advanceVersion(retryId, 'UPLOADING', {
      event: { type: 'catalog.version.retrying' },
    });
    expect(retried).toMatchObject({ state: 'UPLOADING', error: null });

    const assembledFailureId = await createUploadingVersion('assembled-failure-edge');
    await activeCatalog.advanceVersion(assembledFailureId, 'ASSEMBLED', {
      fields: {
        formatTag: 'CANONICAL_ZIP_V1',
        canonicalSha256: 'b'.repeat(64),
        casIndexId: 'indexes/assembled.caibx',
      },
      event: { type: 'catalog.version.assembled' },
    });
    expect(
      await activeCatalog.markFailed(assembledFailureId, 'assembly verification failed')
    ).toMatchObject({
      state: 'FAILED',
      error: 'assembly verification failed',
    });

    const promotingFailureId = await createUploadingVersion('promoting-failure-edge');
    await activeCatalog.advanceVersion(promotingFailureId, 'ASSEMBLED', {
      fields: {
        formatTag: 'CANONICAL_ZIP_V1',
        canonicalSha256: 'c'.repeat(64),
        casIndexId: 'indexes/promoting.caibx',
      },
      event: { type: 'catalog.version.assembled' },
    });
    await activeCatalog.advanceVersion(promotingFailureId, 'PROMOTING', {
      event: { type: 'catalog.version.promoting' },
    });
    expect(
      await activeCatalog.markFailed(promotingFailureId, 'promotion interrupted')
    ).toMatchObject({
      state: 'FAILED',
      error: 'promotion interrupted',
    });

    const readyEvents = await database<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM catalog_outbox
      WHERE aggregate_id = ${created.id} AND event_type = 'catalog.version.ready'
    `;
    expect(readyEvents[0]?.count).toBe(1);
  });

  it('assembled-invariant: rejects ASSEMBLED without a format tag', async () => {
    const activeCatalog = requireCatalog();
    const versionId = await createUploadingVersion('missing-format-tag');

    let transitionError: unknown;
    try {
      await activeCatalog.advanceVersion(versionId, 'ASSEMBLED', {
        fields: {
          canonicalSha256: 'd'.repeat(64),
          casIndexId: 'indexes/missing-format-tag.caibx',
        },
        event: { type: 'catalog.version.assembled' },
      });
    } catch (error) {
      transitionError = error;
    }

    expect(transitionError).toBeInstanceOf(CatalogInvariantError);
    expect(transitionError).toHaveProperty(
      'message',
      'ASSEMBLED requires formatTag, canonicalSha256, and casIndexId'
    );
    expect(await activeCatalog.getVersion(versionId)).toMatchObject({
      state: 'UPLOADING',
      formatTag: null,
      canonicalSha256: null,
      casIndexId: null,
    });
  });

  it('created-failure: records a failure directly from CREATED', async () => {
    const activeCatalog = requireCatalog();
    const created = await activeCatalog.createVersion({
      packageId: 'creation-failure-package',
      version: '1.0.0',
    });

    const failed = await activeCatalog.markFailed(created.id, 'failed before upload started');

    expect(failed).toMatchObject({
      state: 'FAILED',
      formatTag: null,
      canonicalSha256: null,
      casIndexId: null,
      error: 'failed before upload started',
    });
    expect(await activeCatalog.getVersion(created.id)).toEqual(failed);
  });

  it('illegal-transition-rejected: throws a typed error without changing the row', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const created = await activeCatalog.createVersion({
      packageId: 'illegal-transition-package',
      version: '1.0.0',
    });

    let transitionError: unknown;
    try {
      await activeCatalog.transition(created.id, 'READY', {
        fields: { canonicalSha256: 'd'.repeat(64), casIndexId: 'indexes/illegal.caibx' },
        event: { type: 'catalog.version.ready' },
      });
    } catch (error) {
      transitionError = error;
    }
    expect(transitionError).toBeInstanceOf(IllegalCatalogTransitionError);
    expect(transitionError).toMatchObject({
      versionId: created.id,
      currentState: 'CREATED',
      targetState: 'READY',
    });

    expect(await activeCatalog.getVersion(created.id)).toEqual(created);
    const outboxRows = await database<{ count: number }[]>`
      SELECT count(*)::int AS count FROM catalog_outbox WHERE aggregate_id = ${created.id}
    `;
    expect(outboxRows[0]?.count).toBe(1);
  });

  it('atomicity-rollback: an outbox constraint failure rolls back the state update', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const created = await activeCatalog.createVersion({
      packageId: 'atomicity-package',
      version: '1.0.0',
    });

    let transitionError: unknown;
    try {
      await activeCatalog.advanceVersion(created.id, 'UPLOADING', {
        event: { type: '' },
      });
    } catch (error) {
      transitionError = error;
    }
    expect(transitionError).toMatchObject({
      code: '23514',
      constraint_name: 'catalog_outbox_event_type_check',
    });

    expect(await activeCatalog.getVersion(created.id)).toEqual(created);
    const outboxRows = await database<{ count: number }[]>`
      SELECT count(*)::int AS count FROM catalog_outbox WHERE aggregate_id = ${created.id}
    `;
    expect(outboxRows[0]?.count).toBe(1);
  });

  it('reconciler-idempotent: re-drives stuck work and publishes each pending row once', async () => {
    const database = requireSql();
    const stuckVersionId = await createUploadingVersion('stuck-version');
    await database`
      UPDATE package_versions
      SET updated_at = clock_timestamp() - interval '2 hours'
      WHERE id = ${stuckVersionId}
    `;

    const redriveKeys: string[] = [];
    const publishedIds: string[] = [];
    const reconcile = () =>
      reconcileCatalog(database, {
        stuckThresholdMs: 60 * 60 * 1000,
        redrive: async ({ version, idempotencyKey }) => {
          expect(version).toMatchObject({ id: stuckVersionId, state: 'UPLOADING' });
          redriveKeys.push(idempotencyKey);
        },
        publish: async (event) => {
          expect(event.aggregateId).toBe(stuckVersionId);
          publishedIds.push(event.id);
        },
      });

    expect(await reconcile()).toEqual({ versionsRedriven: 1, outboxEventsPublished: 2 });
    expect(redriveKeys).toHaveLength(1);
    expect(new Set(publishedIds).size).toBe(2);

    const persisted = await database<
      { state: string; is_stuck: boolean; unpublished_count: number }[]
    >`
      SELECT
        state,
        updated_at <= clock_timestamp() - interval '1 hour' AS is_stuck,
        (
          SELECT count(*)::int
          FROM catalog_outbox
          WHERE aggregate_id = package_versions.id AND published_at IS NULL
        ) AS unpublished_count
      FROM package_versions
      WHERE id = ${stuckVersionId}
    `;
    expect(persisted[0]).toEqual({
      state: 'UPLOADING',
      is_stuck: false,
      unpublished_count: 0,
    });

    expect(await reconcile()).toEqual({ versionsRedriven: 0, outboxEventsPublished: 0 });
    expect(redriveKeys).toHaveLength(1);
    expect(publishedIds).toHaveLength(2);
  });
});
