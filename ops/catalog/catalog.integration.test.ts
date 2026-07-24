import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForPostgres } from '../testing/postgresReadiness';
import {
  Catalog,
  type CatalogDatabase,
  CatalogInvariantError,
  IllegalCatalogTransitionError,
  openCatalogDatabase,
  reconcileCatalog,
  runCatalogMigrations,
} from './index';

const postgresImage =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'; // postgres:17-alpine
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

async function createReadyVersion(packageId: string, version: string, digestCharacter: string) {
  const activeCatalog = requireCatalog();
  const created = await activeCatalog.createVersion({ packageId, version });
  await activeCatalog.advanceVersion(created.id, 'UPLOADING', {
    event: { type: 'catalog.version.uploading' },
  });
  await activeCatalog.advanceVersion(created.id, 'ASSEMBLED', {
    fields: {
      canonicalSha256: digestCharacter.repeat(64),
      casIndexId: `s3:${packageId}/${version}.caibx`,
      formatTag: 'CANONICAL_TARGZ_V1',
    },
    event: { type: 'catalog.version.assembled' },
  });
  await activeCatalog.advanceVersion(created.id, 'PROMOTING', {
    event: { type: 'catalog.version.promoting' },
  });
  return await activeCatalog.advanceVersion(created.id, 'READY', {
    event: { type: 'catalog.version.ready' },
  });
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
  it('schema-length-cap: rejects package_id and version longer than 256 characters', async () => {
    const database = requireSql();
    const oversizedValue = 'x'.repeat(257);

    for (const input of [
      {
        constraintName: 'package_versions_package_id_check',
        packageId: oversizedValue,
        version: '1.0.0',
      },
      {
        constraintName: 'package_versions_version_check',
        packageId: 'schema-length-cap',
        version: oversizedValue,
      },
    ]) {
      let insertError: unknown;
      try {
        await database`
          INSERT INTO package_versions (id, package_id, version, state)
          VALUES (${randomUUID()}, ${input.packageId}, ${input.version}, 'CREATED')
        `;
      } catch (error) {
        insertError = error;
      }

      expect(insertError).toMatchObject({
        code: '23514',
        constraint_name: input.constraintName,
      });
    }
  });

  it('schema-identifier-content: rejects empty and whitespace-only package_id and version', async () => {
    const database = requireSql();

    for (const input of [
      {
        constraintName: 'package_versions_package_id_check',
        packageId: '',
        version: '1.0.0',
      },
      {
        constraintName: 'package_versions_package_id_check',
        packageId: '   ',
        version: '1.0.1',
      },
      {
        constraintName: 'package_versions_version_check',
        packageId: 'schema-identifier-empty-version',
        version: '',
      },
      {
        constraintName: 'package_versions_version_check',
        packageId: 'schema-identifier-whitespace-version',
        version: '   ',
      },
    ]) {
      let insertError: unknown;
      try {
        await database`
          INSERT INTO package_versions (id, package_id, version, state)
          VALUES (${randomUUID()}, ${input.packageId}, ${input.version}, 'CREATED')
        `;
      } catch (error) {
        insertError = error;
      }

      expect(insertError).toMatchObject({
        code: '23514',
        constraint_name: input.constraintName,
      });
    }
  });

  it('migration-checksums: applying twice is a no-op and changed source is rejected', async () => {
    const database = requireSql();
    const migrationDirectory = await mkdtemp(join(tmpdir(), 'yucp-catalog-migrations-'));
    const catalogMigrationsPath = fileURLToPath(new URL('./migrations/', import.meta.url));
    const fileName = '9000_checksum_probe.sql';
    const migrationPath = join(migrationDirectory, fileName);
    const source = `
      CREATE TABLE catalog_migration_checksum_probe (id int PRIMARY KEY);
      INSERT INTO catalog_migration_checksum_probe (id) VALUES (1);
    `;

    try {
      await Promise.all(
        (await readdir(catalogMigrationsPath)).map((migrationFileName) =>
          copyFile(
            join(catalogMigrationsPath, migrationFileName),
            join(migrationDirectory, migrationFileName)
          )
        )
      );
      await writeFile(migrationPath, source, 'utf8');
      await runCatalogMigrations(database, { migrationsPath: migrationDirectory });
      await runCatalogMigrations(database, { migrationsPath: migrationDirectory });

      const appliedRows = await database<{ checksum: string | null; row_count: number }[]>`
        SELECT
          migrations.checksum,
          (SELECT count(*)::int FROM catalog_migration_checksum_probe) AS row_count
        FROM catalog_schema_migrations migrations
        WHERE migrations.filename = ${fileName}
      `;
      expect([...appliedRows]).toEqual([
        {
          checksum: createHash('sha256').update(source).digest('hex'),
          row_count: 1,
        },
      ]);

      await writeFile(migrationPath, `${source}\n-- changed after application\n`, 'utf8');
      await expect(
        runCatalogMigrations(database, { migrationsPath: migrationDirectory })
      ).rejects.toThrow(`Catalog migration checksum mismatch for ${fileName}`);
    } finally {
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

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

  it('version-deletion: tombstones a base version without changing its ready update', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const base = await createReadyVersion('managed-package', '1.0.0', 'a');
    const update = await createReadyVersion('managed-package', '1.1.0', 'b');

    const deleted = await activeCatalog.deleteVersion(base.id, {
      reason: 'creator-request',
    });

    expect(deleted).toMatchObject({
      id: base.id,
      packageId: 'managed-package',
      version: '1.0.0',
      state: 'DELETED',
      deletionReason: 'creator-request',
    });
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(await activeCatalog.getVersion(update.id)).toMatchObject({
      id: update.id,
      state: 'READY',
    });
    expect(await activeCatalog.listVersions('managed-package')).toEqual([update]);
    expect(await activeCatalog.listVersions('managed-package', { includeDeleted: true })).toEqual([
      deleted,
      update,
    ]);

    const events = await database<
      { event_type: string; payload: { reason: string; previousState: string; state: string } }[]
    >`
      SELECT event_type, payload
      FROM catalog_outbox
      WHERE aggregate_id = ${base.id} AND event_type = 'catalog.version.deleted'
    `;
    expect([...events]).toEqual([
      {
        event_type: 'catalog.version.deleted',
        payload: expect.objectContaining({
          previousState: 'READY',
          reason: 'creator-request',
          state: 'DELETED',
        }),
      },
    ]);
  });

  it('package-deletion: tombstones only the selected package and keeps unrelated versions', async () => {
    const activeCatalog = requireCatalog();
    const first = await createReadyVersion('package-to-delete', '1.0.0', 'c');
    const second = await createReadyVersion('package-to-delete', '2.0.0', 'd');
    const failed = await activeCatalog.createVersion({
      packageId: 'package-to-delete',
      version: '3.0.0',
    });
    await activeCatalog.markFailed(failed.id, 'creator upload failed');
    const unrelated = await createReadyVersion('package-to-keep', '1.0.0', 'e');

    const deleted = await activeCatalog.deletePackageVersions('package-to-delete', {
      reason: 'creator-request',
    });

    expect(deleted.map(({ id }) => id)).toEqual([first.id, second.id, failed.id]);
    expect(deleted.every(({ state }) => state === 'DELETED')).toBeTrue();
    expect(deleted.find(({ id }) => id === failed.id)?.error).toBe('creator upload failed');
    expect(await activeCatalog.listVersions('package-to-delete')).toEqual([]);
    expect(await activeCatalog.listVersions('package-to-keep')).toEqual([unrelated]);
    expect(await activeCatalog.getVersion(unrelated.id)).toEqual(unrelated);
  });

  it('package-deletion-atomicity: leaves every version active when one version is in flight', async () => {
    const activeCatalog = requireCatalog();
    const ready = await createReadyVersion('package-with-live-upload', '1.0.0', 'f');
    const uploading = await activeCatalog.createVersion({
      packageId: 'package-with-live-upload',
      version: '2.0.0',
    });
    await activeCatalog.advanceVersion(uploading.id, 'UPLOADING', {
      event: { type: 'catalog.version.uploading' },
    });

    let deletionError: unknown;
    try {
      await activeCatalog.deletePackageVersions('package-with-live-upload', {
        reason: 'creator-request',
      });
    } catch (error) {
      deletionError = error;
    }
    expect(deletionError).toMatchObject({
      currentState: 'UPLOADING',
      targetState: 'DELETED',
      versionId: uploading.id,
    });

    expect(await activeCatalog.getVersion(ready.id)).toEqual(ready);
    expect(await activeCatalog.getVersion(uploading.id)).toMatchObject({ state: 'UPLOADING' });
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

    expect(failed.nextAttemptAt).toBeInstanceOf(Date);
    expect(failed.nextAttemptAt?.getTime()).toBeGreaterThan(failed.updatedAt.getTime());
    expect(failed).toMatchObject({
      state: 'FAILED',
      formatTag: null,
      canonicalSha256: null,
      casIndexId: null,
      error: 'failed before upload started',
      attempts: 1,
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
          expect(version).toMatchObject({ id: stuckVersionId, state: 'FAILED', attempts: 1 });
          redriveKeys.push(idempotencyKey);
        },
        publish: async (event) => {
          expect(event.aggregateId).toBe(stuckVersionId);
          publishedIds.push(event.id);
        },
      });

    expect(await reconcile()).toEqual({ versionsRedriven: 1, outboxEventsPublished: 3 });
    expect(redriveKeys).toHaveLength(1);
    expect(new Set(publishedIds).size).toBe(3);

    const persisted = await database<
      { state: string; attempts: number; is_stuck: boolean; unpublished_count: number }[]
    >`
      SELECT
        state,
        attempts,
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
      state: 'FAILED',
      attempts: 1,
      is_stuck: false,
      unpublished_count: 0,
    });

    expect(await reconcile()).toEqual({ versionsRedriven: 0, outboxEventsPublished: 0 });
    expect(redriveKeys).toHaveLength(1);
    expect(publishedIds).toHaveLength(3);
  });

  it('no-infinite-retry: a perpetually failing row is never re-driven after the attempt cap', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const versionId = await createUploadingVersion('perpetually-failing');
    const maxAttempts = 5;
    const initialFailure = await activeCatalog.markFailed(versionId, 'permanent dispatch failure');
    expect(initialFailure.attempts).toBe(1);
    await database`UPDATE catalog_outbox SET published_at = clock_timestamp()`;

    let redriveCalls = 0;
    const reconcile = () =>
      reconcileCatalog(database, {
        stuckThresholdMs: 60 * 60 * 1000,
        maxAttempts,
        retryBackoffBaseMs: 30_000,
        retryBackoffFactor: 2,
        retryBackoffCapMs: 60 * 60 * 1000,
        redrive: async ({ version }) => {
          redriveCalls += 1;
          expect(version).toMatchObject({
            id: versionId,
            state: 'FAILED',
            attempts: redriveCalls,
          });
          await activeCatalog.advanceVersion(versionId, 'UPLOADING', {
            event: { type: 'catalog.version.retrying' },
          });
          await activeCatalog.markFailed(versionId, 'permanent dispatch failure');
        },
        publish: async () => {},
      });

    for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
      await database`
        UPDATE package_versions
        SET next_attempt_at = clock_timestamp() - interval '1 millisecond'
        WHERE id = ${versionId}
      `;
      expect(await reconcile()).toMatchObject({ versionsRedriven: 1 });

      const rows = await database<
        {
          state: string;
          attempts: number;
          next_attempt_is_future: boolean;
          backoff_ms: number;
        }[]
      >`
        SELECT
          state,
          attempts,
          next_attempt_at > clock_timestamp() AS next_attempt_is_future,
          round(extract(epoch FROM (next_attempt_at - updated_at)) * 1000)::int AS backoff_ms
        FROM package_versions
        WHERE id = ${versionId}
      `;
      expect(rows[0]).toMatchObject({
        state: 'FAILED',
        attempts: attempt,
        next_attempt_is_future: true,
      });
      expect(Math.abs((rows[0]?.backoff_ms ?? 0) - 30_000 * 2 ** (attempt - 1))).toBeLessThan(100);
    }

    expect(await reconcile()).toMatchObject({ versionsRedriven: 0 });
    expect(redriveCalls).toBe(maxAttempts - initialFailure.attempts);
    expect(await requireCatalog().getVersion(versionId)).toMatchObject({
      state: 'FAILED',
      attempts: maxAttempts,
    });

    console.log(
      `CATALOG_FAILED_REDRIVE_RESULT\nattempt-cap=${maxAttempts}\ninitial-attempts=${initialFailure.attempts}\nredrive-calls=${redriveCalls}\nfinal-attempts=${maxAttempts}\nbounded=yes`
    );
  });

  it('backoff-skip: a future next_attempt_at prevents an otherwise stuck row from being touched', async () => {
    const database = requireSql();
    const versionId = await createUploadingVersion('future-backoff');
    await database`
      UPDATE package_versions
      SET
        attempts = 1,
        updated_at = clock_timestamp() - interval '2 hours',
        next_attempt_at = clock_timestamp() + interval '1 hour'
      WHERE id = ${versionId}
    `;
    await database`UPDATE catalog_outbox SET published_at = clock_timestamp()`;

    let redriveCalls = 0;
    const result = await reconcileCatalog(database, {
      stuckThresholdMs: 60 * 60 * 1000,
      maxAttempts: 5,
      redrive: async () => {
        redriveCalls += 1;
      },
      publish: async () => {},
    });

    expect(result).toEqual({ versionsRedriven: 0, outboxEventsPublished: 0 });
    expect(redriveCalls).toBe(0);
    expect(await requireCatalog().getVersion(versionId)).toMatchObject({
      state: 'UPLOADING',
      attempts: 1,
    });
  });

  it('batch-cap: processes only the oldest eligible rows up to the per-run limit', async () => {
    const database = requireSql();
    const versionIds = await Promise.all([
      createUploadingVersion('batch-oldest'),
      createUploadingVersion('batch-middle'),
      createUploadingVersion('batch-newest'),
    ]);
    for (const [index, versionId] of versionIds.entries()) {
      await database`
        UPDATE package_versions
        SET updated_at = clock_timestamp() - (${4 - index} * interval '1 hour')
        WHERE id = ${versionId}
      `;
    }
    await database`UPDATE catalog_outbox SET published_at = clock_timestamp()`;

    const redrivenIds: string[] = [];
    const result = await reconcileCatalog(database, {
      stuckThresholdMs: 60 * 60 * 1000,
      batchLimit: 2,
      redrive: async ({ version }) => {
        redrivenIds.push(version.id);
      },
      publish: async () => {},
    });

    expect(result).toEqual({ versionsRedriven: 2, outboxEventsPublished: 0 });
    expect(redrivenIds).toEqual(versionIds.slice(0, 2));
    const attempts = await database<{ id: string; attempts: number }[]>`
      SELECT id, attempts
      FROM package_versions
      ORDER BY version
    `;
    expect([...attempts]).toEqual([
      { id: versionIds[1], attempts: 1 },
      { id: versionIds[2], attempts: 0 },
      { id: versionIds[0], attempts: 1 },
    ]);
  });
});
