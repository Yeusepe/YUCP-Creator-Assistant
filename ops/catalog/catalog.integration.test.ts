import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_INSTALL_DPOP_ACCEPTED_FUTURE_SKEW_SECONDS,
  PACKAGE_INSTALL_DPOP_MAX_REPLAY_RESERVATION_LIFETIME_MS,
  PACKAGE_INSTALL_DPOP_PROOF_MAX_AGE_SECONDS,
} from '../storage-core/dpopReplayPolicy';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
import { waitForPostgres } from '../testing/postgresReadiness';
import {
  Catalog,
  type CatalogDatabase,
  CatalogInvariantError,
  ExactStorageCatalog,
  IllegalCatalogTransitionError,
  openCatalogDatabase,
  type PackageOperationAuthorizationRecord,
  PackageOperationAuthorizationStore,
  PackageVersionNotFoundError,
  reconcileCatalog,
  runCatalogMigrations,
  type StorageObjectVersion,
  TufRepositoryCatalog,
} from './index';

const postgresImage =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'; // postgres:17-alpine
const databaseName = 'catalog_test';
const databasePassword = 'catalog-test-password';
const containerName = `yucp-catalog-integration-${randomUUID()}`;

let sql: CatalogDatabase | undefined;
let catalog: Catalog | undefined;
let containerStarted = false;
let databaseUrl: string | undefined;

function operationAuthorizationRecord(
  overrides: Partial<PackageOperationAuthorizationRecord> = {}
): PackageOperationAuthorizationRecord {
  const issuedAt = new Date();
  return {
    aliasId: 'jammr',
    approvedActiveContentDigest: '66'.repeat(32),
    approvedPolicyVersion: 'active-content-policy-v1',
    buyerId: 'buyer-1',
    capabilityId: `operation-${randomBytes(24).toString('hex')}`,
    deviceKeyThumbprint: '44'.repeat(32),
    expectedCurrentReleaseRoot: '00'.repeat(32),
    expiresAt: new Date(issuedAt.getTime() + 4 * 60 * 1_000),
    idempotencyKey: `operation-${randomUUID()}`,
    issuedAt,
    oneUseNonce: randomBytes(32).toString('hex'),
    operation: 'install',
    projectIdentity: '55'.repeat(32),
    releaseRoot: '11'.repeat(32),
    tokenSha256: '77'.repeat(32),
    traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    ...overrides,
  };
}

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

function publicationFields(digestCharacter: string) {
  return {
    activeContentDigest: '1'.repeat(64),
    activePolicyVersion: 'active-content-policy-v1',
    bindingRoot: '2'.repeat(64),
    commonRoot: '3'.repeat(64),
    logicalBytes: 1_024,
    logicalFiles: 2,
    manifestSha256: '4'.repeat(64),
    protectedFiles: [],
    protectedSourceRoot: '5'.repeat(64),
    protectionPolicyDigest: '6'.repeat(64),
    protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
    releaseRoot: digestCharacter.repeat(64),
    vpmDependencies: {
      'com.example.runtime': '>=2.0.0',
    },
    vpmRepositories: {
      'Example Repository': 'https://packages.example.test/index.json',
    },
  };
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
      releaseRoot: digestCharacter.repeat(64),
      assemblyObjectId: `s3:${packageId}/${version}.caibx`,
      sourceFormat: 'CANONICAL_TARGZ_V1',
    },
    event: { type: 'catalog.version.assembled' },
  });
  await activeCatalog.advanceVersion(created.id, 'PROMOTING', {
    event: { type: 'catalog.version.promoting' },
  });
  return await activeCatalog.advanceVersion(created.id, 'READY', {
    fields: publicationFields(digestCharacter),
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

    databaseUrl = `postgres://postgres:${databasePassword}@127.0.0.1:${portMatch[1]}/${databaseName}`;
    sql = openCatalogDatabase(databaseUrl);
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
  await requireSql()`
    TRUNCATE TABLE
      catalog_outbox,
      package_install_dpop_replays,
      package_operation_authorizations,
      package_versions,
      tuf_repositories
    CASCADE
  `;
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
  it('persists one exchange outcome and returns it after database client restart', async () => {
    if (!databaseUrl) {
      throw new Error('catalog integration database URL is unavailable');
    }
    const store = new PackageOperationAuthorizationStore(requireSql());
    const record = operationAuthorizationRecord();
    await store.reserve(record);
    const claims = await Promise.all([
      store.beginExchange({
        buyerId: record.buyerId,
        capabilityId: record.capabilityId,
        deviceKeyThumbprint: record.deviceKeyThumbprint,
        tokenSha256: record.tokenSha256,
      }),
      store.beginExchange({
        buyerId: record.buyerId,
        capabilityId: record.capabilityId,
        deviceKeyThumbprint: record.deviceKeyThumbprint,
        tokenSha256: record.tokenSha256,
      }),
    ]);
    const claimed = claims.find(
      (claim): claim is { generation: number; status: 'claimed' } => claim.status === 'claimed'
    );
    expect(claimed).toBeDefined();
    expect(claims.filter((claim) => claim.status === 'in_progress')).toHaveLength(1);
    expect(
      await store.completeExchange({
        capabilityId: record.capabilityId,
        deliveryGrantId: 'grant-outcome-1',
        generation: claimed?.generation ?? 0,
        grantExpiresAt: new Date(record.issuedAt.getTime() + 5 * 60 * 1_000),
        grantIssuedAt: record.issuedAt,
        grantTokenSha256: 'ab'.repeat(32),
        materializationJobId: 'job-outcome-1',
        renewableUntil: new Date(record.issuedAt.getTime() + 60 * 60 * 1_000),
        sessionId: 'session-outcome-1',
        versionId: 'version-outcome-1',
      })
    ).toBe(true);

    const restartedDatabase = openCatalogDatabase(databaseUrl);
    try {
      await expect(
        new PackageOperationAuthorizationStore(restartedDatabase).beginExchange({
          buyerId: record.buyerId,
          capabilityId: record.capabilityId,
          deviceKeyThumbprint: record.deviceKeyThumbprint,
          tokenSha256: record.tokenSha256,
        })
      ).resolves.toEqual({
        deliveryGrantId: 'grant-outcome-1',
        grantExpiresAt: new Date(record.issuedAt.getTime() + 5 * 60 * 1_000),
        grantIssuedAt: record.issuedAt,
        grantTokenSha256: 'ab'.repeat(32),
        materializationJobId: 'job-outcome-1',
        renewableUntil: new Date(record.issuedAt.getTime() + 60 * 60 * 1_000),
        sessionId: 'session-outcome-1',
        status: 'ready',
        versionId: 'version-outcome-1',
      });
    } finally {
      await restartedDatabase.end({ timeout: 1 });
    }
  });

  it('returns the original consumed authorization for an exact operation retry', async () => {
    const store = new PackageOperationAuthorizationStore(requireSql());
    const record = operationAuthorizationRecord();
    await store.reserve(record);
    const claimed = await store.beginExchange({
      buyerId: record.buyerId,
      capabilityId: record.capabilityId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      tokenSha256: record.tokenSha256,
    });
    if (claimed.status !== 'claimed') {
      throw new Error(`expected claimed exchange, received ${claimed.status}`);
    }
    expect(
      await store.completeExchange({
        capabilityId: record.capabilityId,
        deliveryGrantId: 'grant-retry-1',
        generation: claimed.generation,
        grantExpiresAt: new Date(record.issuedAt.getTime() + 5 * 60 * 1_000),
        grantIssuedAt: record.issuedAt,
        grantTokenSha256: 'ab'.repeat(32),
        renewableUntil: new Date(record.issuedAt.getTime() + 60 * 60 * 1_000),
        sessionId: 'session-retry-1',
        versionId: 'version-retry-1',
      })
    ).toBe(true);

    const retried = await store.reserve(
      operationAuthorizationRecord({
        buyerId: record.buyerId,
        capabilityId: `operation-${'ab'.repeat(24)}`,
        deviceKeyThumbprint: record.deviceKeyThumbprint,
        idempotencyKey: record.idempotencyKey,
        oneUseNonce: 'bc'.repeat(32),
        tokenSha256: 'cd'.repeat(32),
      })
    );

    expect(retried.status).toBe('consumed');
    expect(retried.record).toMatchObject({
      capabilityId: record.capabilityId,
      consumedAt: expect.any(Date),
      tokenSha256: record.tokenSha256,
    });
  });

  it('renews one READY install session idempotently without resetting its policy bound', async () => {
    const store = new PackageOperationAuthorizationStore(requireSql());
    const record = operationAuthorizationRecord();
    await store.reserve(record);
    const exchange = await store.beginExchange({
      buyerId: record.buyerId,
      capabilityId: record.capabilityId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      tokenSha256: record.tokenSha256,
    });
    if (exchange.status !== 'claimed') {
      throw new Error(`expected claimed exchange, received ${exchange.status}`);
    }
    const initialGrantDigest = 'ab'.repeat(32);
    const renewableUntil = new Date(record.issuedAt.getTime() + 60 * 60 * 1_000);
    expect(
      await store.completeExchange({
        capabilityId: record.capabilityId,
        deliveryGrantId: 'grant-renewal-initial',
        generation: exchange.generation,
        grantExpiresAt: new Date(record.issuedAt.getTime() + 5 * 60 * 1_000),
        grantIssuedAt: record.issuedAt,
        grantTokenSha256: initialGrantDigest,
        renewableUntil,
        sessionId: 'session-renewal-1',
        versionId: 'version-renewal-1',
      })
    ).toBe(true);

    const first = await store.beginRenewal({
      buyerId: record.buyerId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      grantTokenSha256: initialGrantDigest,
      sessionId: 'session-renewal-1',
      traceId: '0123456789abcdef0123456789abcdef',
    });
    if (first.status !== 'claimed') {
      throw new Error(`expected claimed renewal, received ${first.status}`);
    }
    const concurrent = await store.beginRenewal({
      buyerId: record.buyerId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      grantTokenSha256: initialGrantDigest,
      sessionId: 'session-renewal-1',
      traceId: '0123456789abcdef0123456789abcdef',
    });
    expect(concurrent).toEqual({ status: 'in_progress' });
    const renewedGrantDigest = 'bc'.repeat(32);
    expect(
      await store.completeRenewal({
        capabilityId: first.capabilityId,
        generation: first.generation,
        grantId: 'grant-renewal-initial',
        expiresAt: new Date(first.issuedAt.getTime() + 5 * 60 * 1_000),
        grantTokenSha256: renewedGrantDigest,
        issuedAt: first.issuedAt,
      })
    ).toBe(true);

    const retried = await store.beginRenewal({
      buyerId: record.buyerId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      grantTokenSha256: initialGrantDigest,
      sessionId: 'session-renewal-1',
      traceId: '0123456789abcdef0123456789abcdef',
    });
    expect(retried).toEqual({
      capabilityId: record.capabilityId,
      generation: 1,
      grantId: 'grant-renewal-initial',
      expiresAt: new Date(first.issuedAt.getTime() + 5 * 60 * 1_000),
      grantTokenSha256: renewedGrantDigest,
      issuedAt: first.issuedAt,
      renewableUntil,
      status: 'ready',
    });
    const substituted = await store.beginRenewal({
      buyerId: record.buyerId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      grantTokenSha256: 'cd'.repeat(32),
      sessionId: 'session-renewal-1',
      traceId: '0123456789abcdef0123456789abcdef',
    });
    expect(substituted).toEqual({ status: 'invalid' });
    const differentTrace = await store.beginRenewal({
      buyerId: record.buyerId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      grantTokenSha256: renewedGrantDigest,
      sessionId: 'session-renewal-1',
      traceId: '1123456789abcdef0123456789abcdef',
    });
    expect(differentTrace).toEqual({ status: 'invalid' });
    const retryable = await store.beginRenewal({
      buyerId: record.buyerId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      grantTokenSha256: renewedGrantDigest,
      sessionId: 'session-renewal-1',
      traceId: '0123456789abcdef0123456789abcdef',
    });
    if (retryable.status !== 'claimed') {
      throw new Error(`expected claimed renewal, received ${retryable.status}`);
    }
    expect(
      await store.releaseRenewal({
        capabilityId: retryable.capabilityId,
        generation: retryable.generation,
      })
    ).toBe(true);
    const reclaimed = await store.beginRenewal({
      buyerId: record.buyerId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      grantTokenSha256: renewedGrantDigest,
      sessionId: 'session-renewal-1',
      traceId: '0123456789abcdef0123456789abcdef',
    });
    expect(reclaimed).toMatchObject({
      capabilityId: record.capabilityId,
      generation: retryable.generation + 1,
      status: 'claimed',
    });
  });

  it('advances a lost renewal response after its persisted grant slice expires', async () => {
    const store = new PackageOperationAuthorizationStore(requireSql());
    const record = operationAuthorizationRecord();
    await store.reserve(record);
    const exchange = await store.beginExchange({
      buyerId: record.buyerId,
      capabilityId: record.capabilityId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      tokenSha256: record.tokenSha256,
    });
    if (exchange.status !== 'claimed') {
      throw new Error(`expected claimed exchange, received ${exchange.status}`);
    }
    const firstDigest = 'ab'.repeat(32);
    const secondDigest = 'bc'.repeat(32);
    const renewableUntil = new Date(record.issuedAt.getTime() + 60 * 60 * 1_000);
    expect(
      await store.completeExchange({
        capabilityId: record.capabilityId,
        deliveryGrantId: 'grant-lost-initial',
        generation: exchange.generation,
        grantExpiresAt: new Date(record.issuedAt.getTime() + 5 * 60 * 1_000),
        grantIssuedAt: record.issuedAt,
        grantTokenSha256: firstDigest,
        renewableUntil,
        sessionId: 'session-lost-renewal',
        versionId: 'version-lost-renewal',
      })
    ).toBe(true);
    const firstRenewal = await store.beginRenewal({
      buyerId: record.buyerId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      grantTokenSha256: firstDigest,
      sessionId: 'session-lost-renewal',
      traceId: '0123456789abcdef0123456789abcdef',
    });
    if (firstRenewal.status !== 'claimed') {
      throw new Error(`expected claimed renewal, received ${firstRenewal.status}`);
    }
    expect(
      await store.completeRenewal({
        capabilityId: firstRenewal.capabilityId,
        expiresAt: new Date(firstRenewal.issuedAt.getTime() + 5 * 60 * 1_000),
        generation: firstRenewal.generation,
        grantId: 'grant-lost-initial',
        grantTokenSha256: secondDigest,
        issuedAt: firstRenewal.issuedAt,
      })
    ).toBe(true);
    await requireSql()`
      UPDATE package_operation_authorizations
      SET
        outcome_grant_issued_at = clock_timestamp() - interval '6 minutes',
        outcome_grant_expires_at = clock_timestamp() - interval '1 minute'
      WHERE capability_id = ${record.capabilityId}
    `;

    const advanced = await store.beginRenewal({
      buyerId: record.buyerId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      grantTokenSha256: firstDigest,
      sessionId: 'session-lost-renewal',
      traceId: '0123456789abcdef0123456789abcdef',
    });

    expect(advanced).toMatchObject({
      capabilityId: record.capabilityId,
      generation: 2,
      grantId: 'grant-lost-initial',
      renewableUntil,
      status: 'claimed',
    });
  });

  it('reclaims released and expired exchange leases without losing authorization', async () => {
    const store = new PackageOperationAuthorizationStore(requireSql());
    const record = operationAuthorizationRecord();
    await store.reserve(record);
    const first = await store.beginExchange({
      buyerId: record.buyerId,
      capabilityId: record.capabilityId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      tokenSha256: record.tokenSha256,
    });
    if (first.status !== 'claimed') {
      throw new Error(`expected claimed exchange, received ${first.status}`);
    }
    expect(
      await store.releaseExchange({
        capabilityId: record.capabilityId,
        generation: first.generation,
      })
    ).toBe(true);
    const second = await store.beginExchange({
      buyerId: record.buyerId,
      capabilityId: record.capabilityId,
      deviceKeyThumbprint: record.deviceKeyThumbprint,
      tokenSha256: record.tokenSha256,
    });
    expect(second).toMatchObject({ generation: 2, status: 'claimed' });
    await requireSql()`
      UPDATE package_operation_authorizations
      SET exchange_lease_until = clock_timestamp() - interval '1 second'
      WHERE capability_id = ${record.capabilityId}
    `;
    await expect(
      store.beginExchange({
        buyerId: record.buyerId,
        capabilityId: record.capabilityId,
        deviceKeyThumbprint: record.deviceKeyThumbprint,
        tokenSha256: record.tokenSha256,
      })
    ).resolves.toMatchObject({ generation: 3, status: 'claimed' });
  });

  it('treats traceparent as exact idempotency context', async () => {
    const store = new PackageOperationAuthorizationStore(requireSql());
    const record = operationAuthorizationRecord();
    expect((await store.reserve(record)).status).toBe('created');
    expect(
      (
        await store.reserve({
          ...operationAuthorizationRecord({
            buyerId: record.buyerId,
            deviceKeyThumbprint: record.deviceKeyThumbprint,
            idempotencyKey: record.idempotencyKey,
          }),
          traceparent: '00-1123456789abcdef0123456789abcdef-0123456789abcdef-01',
        })
      ).status
    ).toBe('conflict');
  });

  it('bounds expired operation authorization cleanup to one fixed batch', async () => {
    await requireSql()`
      INSERT INTO package_operation_authorizations (
        capability_id,
        token_sha256,
        buyer_id,
        alias_id,
        device_key_thumbprint,
        release_root,
        expected_current_release_root,
        operation,
        project_identity,
        approved_active_content_digest,
        approved_policy_version,
        idempotency_key,
        traceparent,
        one_use_nonce,
        issued_at,
        expires_at
      )
      SELECT
        'operation-' || lpad(to_hex(generate_series), 48, '0'),
        repeat(md5('token-' || generate_series::text), 2),
        'buyer-cleanup',
        'jammr',
        repeat('44', 32),
        repeat('11', 32),
        repeat('00', 32),
        'install',
        repeat('55', 32),
        repeat('66', 32),
        'active-content-policy-v1',
        'cleanup-' || generate_series::text,
        '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
        repeat(md5('nonce-' || generate_series::text), 2),
        clock_timestamp() - interval '2 minutes',
        clock_timestamp() - interval '1 minute'
      FROM generate_series(1, 105)
    `;

    await new PackageOperationAuthorizationStore(requireSql()).reserve(
      operationAuthorizationRecord()
    );

    const expiredRows = await requireSql()<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM package_operation_authorizations
      WHERE expires_at <= clock_timestamp()
    `;
    expect(expiredRows[0]?.count).toBe(5);
  });

  it('rejects expired and incorrectly bound operation authorization exchanges', async () => {
    const store = new PackageOperationAuthorizationStore(requireSql());
    const active = operationAuthorizationRecord();
    await store.reserve(active);
    expect(
      await store.beginExchange({
        buyerId: active.buyerId,
        capabilityId: active.capabilityId,
        deviceKeyThumbprint: '45'.repeat(32),
        tokenSha256: active.tokenSha256,
      })
    ).toEqual({ status: 'invalid' });

    const issuedAt = new Date(Date.now() - 2 * 60 * 1_000);
    const expired = operationAuthorizationRecord({
      expiresAt: new Date(Date.now() - 60 * 1_000),
      issuedAt,
    });
    await store.reserve(expired);
    expect(
      await store.beginExchange({
        buyerId: expired.buyerId,
        capabilityId: expired.capabilityId,
        deviceKeyThumbprint: expired.deviceKeyThumbprint,
        tokenSha256: expired.tokenSha256,
      })
    ).toEqual({ status: 'invalid' });
  });

  it('rolls back an operation authorization reserved inside a failed transaction', async () => {
    const record = operationAuthorizationRecord();

    await expect(
      requireSql().begin(async (transaction) => {
        await new PackageOperationAuthorizationStore(
          transaction as unknown as CatalogDatabase
        ).reserve(record);
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    const rows = await requireSql()<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM package_operation_authorizations
      WHERE capability_id = ${record.capabilityId}
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it('persists DPoP replay state and bounds expired-row cleanup', async () => {
    if (!databaseUrl) {
      throw new Error('catalog integration database URL is unavailable');
    }
    const store = new PackageOperationAuthorizationStore(requireSql()).dpopReplayStore();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 4 * 60 * 1_000);
    const reservations = await Promise.all([
      store.reserve({ expiresAt, key: 'proof-1', now }),
      store.reserve({ expiresAt, key: 'proof-1', now }),
    ]);
    expect(reservations.sort()).toEqual([false, true]);

    const maximumAcceptedFutureSkew = new Date(
      now.getTime() + PACKAGE_INSTALL_DPOP_ACCEPTED_FUTURE_SKEW_SECONDS * 1_000
    );
    expect(
      await store.reserve({
        expiresAt: new Date(
          maximumAcceptedFutureSkew.getTime() + PACKAGE_INSTALL_DPOP_PROOF_MAX_AGE_SECONDS * 1_000
        ),
        key: 'proof-with-accepted-future-skew',
        now,
      })
    ).toBe(true);

    const restartedDatabase = openCatalogDatabase(databaseUrl);
    try {
      const restartedStore = new PackageOperationAuthorizationStore(
        restartedDatabase
      ).dpopReplayStore();
      expect(await restartedStore.reserve({ expiresAt, key: 'proof-1', now })).toBe(false);
    } finally {
      await restartedDatabase.end({ timeout: 1 });
    }

    await requireSql()`
      INSERT INTO package_install_dpop_replays (
        replay_key,
        created_at,
        expires_at
      )
      SELECT
        lpad(generate_series::text, 64, '0'),
        clock_timestamp() - interval '2 minutes',
        clock_timestamp() - interval '1 minute'
      FROM generate_series(1, 105)
    `;
    const cleanupNow = new Date();
    expect(
      await store.reserve({
        expiresAt: new Date(cleanupNow.getTime() + 4 * 60 * 1_000),
        key: 'proof-cleanup',
        now: cleanupNow,
      })
    ).toBe(true);
    const expiredRows = await requireSql()<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM package_install_dpop_replays
      WHERE expires_at <= ${cleanupNow}
    `;
    expect(expiredRows[0]?.count).toBe(5);
    expect(
      await store.reserve({
        expiresAt: new Date(
          cleanupNow.getTime() + PACKAGE_INSTALL_DPOP_MAX_REPLAY_RESERVATION_LIFETIME_MS + 1
        ),
        key: 'proof-too-long',
        now: cleanupNow,
      })
    ).toBe(false);
  });

  it('returns bigint logical byte counts as safe numbers', async () => {
    const ready = await createReadyVersion('typed-logical-bytes', '1.0.0', '9');

    expect(ready.logicalBytes).toBe(1_024);
    expect(typeof ready.logicalBytes).toBe('number');
    expect((await requireCatalog().getVersion(ready.id))?.logicalBytes).toBe(1_024);
  });

  it('reuses an exact package version reservation without adding a second outbox event', async () => {
    const activeCatalog = requireCatalog();
    const versionId = randomUUID();
    const first = await activeCatalog.createVersion({
      catalogProductId: 'catalog-product-1',
      id: versionId,
      packageId: 'com.yucp.retry-safe',
      version: '1.0.0',
    });
    const second = await activeCatalog.createVersion({
      catalogProductId: 'catalog-product-1',
      id: versionId,
      packageId: 'com.yucp.retry-safe',
      version: '1.0.0',
    });

    expect(second).toEqual(first);
    const events = await requireSql()<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM catalog_outbox
      WHERE aggregate_id = ${versionId}
        AND event_type = 'catalog.version.created'
    `;
    expect(events[0]?.count).toBe(1);
  });

  it('serializes concurrent retries for one exact package version reservation', async () => {
    const activeCatalog = requireCatalog();
    const versionId = randomUUID();
    const reservations = await Promise.all(
      Array.from({ length: 12 }, () =>
        activeCatalog.createVersion({
          catalogProductId: 'catalog-product-concurrent',
          id: versionId,
          packageId: 'com.yucp.concurrent-retry-safe',
          version: '1.0.0',
        })
      )
    );

    expect(new Set(reservations.map((reservation) => reservation.id))).toEqual(
      new Set([versionId])
    );
    expect(new Set(reservations.map((reservation) => reservation.state))).toEqual(
      new Set(['CREATED'])
    );
    const events = await requireSql()<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM catalog_outbox
      WHERE aggregate_id = ${versionId}
        AND event_type = 'catalog.version.created'
    `;
    expect(events[0]?.count).toBe(1);
  });

  it('reuses one logical version reservation across equivalent store products', async () => {
    const activeCatalog = requireCatalog();
    const versionId = randomUUID();
    const first = await activeCatalog.createVersion({
      catalogProductId: 'catalog-product-jinxxy',
      id: versionId,
      packageId: 'com.yucp.multi-store',
      version: '1.0.0',
    });
    const second = await activeCatalog.createVersion({
      catalogProductId: 'catalog-product-gumroad',
      id: versionId,
      packageId: 'com.yucp.multi-store',
      version: '1.0.0',
    });

    expect(second).toEqual(first);
    const events = await requireSql()<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM catalog_outbox
      WHERE aggregate_id = ${versionId}
        AND event_type = 'catalog.version.created'
    `;
    expect(events[0]?.count).toBe(1);
  });

  it('stores the same release version independently for each package edition', async () => {
    const activeCatalog = requireCatalog();
    const personal = await activeCatalog.createVersion({
      editionId: 'personal',
      packageId: 'com.yucp.editions',
      version: '1.0.0',
    });
    const commercial = await activeCatalog.createVersion({
      editionId: 'commercial',
      packageId: 'com.yucp.editions',
      version: '1.0.0',
    });

    expect(personal.id).not.toBe(commercial.id);
    expect(personal.editionId).toBe('personal');
    expect(commercial.editionId).toBe('commercial');
    expect(
      await activeCatalog.listVersions('com.yucp.editions', { editionId: 'commercial' })
    ).toEqual([commercial]);
  });

  it('pages every retained version in one package edition without assuming version labels', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const created = [];
    for (const version of ['release-amber', 'release-cobalt', 'release-fuchsia', 'release-gold']) {
      created.push(
        await activeCatalog.createVersion({
          editionId: 'commercial',
          packageId: 'com.yucp.version-pages',
          version,
        })
      );
    }
    const deleted = await activeCatalog.createVersion({
      editionId: 'commercial',
      packageId: 'com.yucp.version-pages',
      version: 'release-deleted',
    });
    await activeCatalog.deleteVersion(deleted.id, {
      editionId: deleted.editionId,
      packageId: deleted.packageId,
      reason: 'creator-request',
    });
    await activeCatalog.createVersion({
      editionId: 'personal',
      packageId: 'com.yucp.version-pages',
      version: 'release-other-edition',
    });
    for (const [index, version] of created.entries()) {
      const createdAt = new Date(Date.UTC(2026, 6, 26, 12, index, 0));
      await database`
        UPDATE package_versions
        SET created_at = ${createdAt}, updated_at = ${createdAt}
        WHERE id = ${version.id}
      `;
    }

    const first = await activeCatalog.listVersionsPage('com.yucp.version-pages', {
      editionId: 'commercial',
      limit: 2,
    });
    expect(first.data.map(({ version }) => version)).toEqual(['release-gold', 'release-fuchsia']);
    expect(first.hasMore).toBeTrue();
    expect(first.nextCursor).toEqual({
      createdAt: new Date('2026-07-26T12:02:00.000Z'),
      versionId: created[2]?.id,
    });

    const second = await activeCatalog.listVersionsPage('com.yucp.version-pages', {
      cursor: first.nextCursor ?? undefined,
      editionId: 'commercial',
      limit: 2,
    });
    expect(second.data.map(({ version }) => version)).toEqual(['release-cobalt', 'release-amber']);
    expect(second.hasMore).toBeFalse();
    expect(second.nextCursor).toBeNull();
  });

  it('allocates durable TUF versions and exposes only a complete publication', async () => {
    const database = requireSql();
    const tuf = new TufRepositoryCatalog(database);
    const targetPath = `targets/helper/windows-amd64/${'1'.repeat(64)}.yucp-transfer-helper.exe`;
    const first = await tuf.reservePublication({
      idempotencyKey: 'release-build-1',
      repositoryId: 'package-installer',
      rootVersion: 1,
      targetPaths: [targetPath],
    });
    const second = await tuf.reservePublication({
      idempotencyKey: 'release-build-2',
      repositoryId: 'package-installer',
      rootVersion: 1,
      targetPaths: [targetPath],
    });
    expect([first.metadataVersion, second.metadataVersion]).toEqual([1, 2]);
    expect(
      await tuf.reservePublication({
        idempotencyKey: 'release-build-1',
        repositoryId: 'package-installer',
        rootVersion: 1,
        targetPaths: [targetPath],
      })
    ).toMatchObject({
      id: first.id,
      metadataVersion: 1,
    });

    const expectedPaths = [
      targetPath,
      'metadata/1.root.json',
      'metadata/1.targets.json',
      'metadata/1.snapshot.json',
      'metadata/timestamp.json',
    ];
    const objects = new Map<string, StorageObjectVersion>();
    for (const [index, repositoryPath] of expectedPaths.entries()) {
      const objectKey = `v2/metadata/tuf/package-installer/${repositoryPath}`;
      const id = randomUUID();
      const sha256 = (index + 1).toString(16).padStart(64, '0');
      await database`
        INSERT INTO storage_object_versions (
          id,
          storage_role,
          bucket_name,
          object_key,
          provider_version,
          file_identifier,
          sha256,
          bytes,
          content_type,
          verification_state,
          verified_at
        )
        VALUES (
          ${id},
          'metadata',
          'metadata',
          ${objectKey},
          ${`provider-${index + 1}`},
          ${`file-${index + 1}`},
          decode(${sha256}, 'hex'),
          ${index + 1},
          'application/json',
          'VERIFIED',
          clock_timestamp()
        )
      `;
      objects.set(repositoryPath, {
        bucketName: 'metadata',
        bytes: index + 1,
        contentType: 'application/json',
        fileIdentifier: `file-${index + 1}`,
        id,
        objectKey,
        providerVersion: `provider-${index + 1}`,
        sha256,
        storageRole: 'metadata',
        verificationState: 'VERIFIED',
        verifiedAt: new Date(),
      });
    }

    const timestampObject = objects.get('metadata/timestamp.json');
    if (!timestampObject) {
      throw new Error('Test TUF timestamp object was not created');
    }

    let timestampError: unknown;
    try {
      await tuf.recordObject({
        object: timestampObject,
        publicationId: first.id,
        repositoryPath: 'metadata/timestamp.json',
      });
    } catch (error) {
      timestampError = error;
    }
    expect(String(timestampError)).toContain('TUF timestamp must be recorded last');

    for (const repositoryPath of expectedPaths.slice(0, -1)) {
      const object = objects.get(repositoryPath);
      if (!object) {
        throw new Error(`Test TUF object was not created: ${repositoryPath}`);
      }
      await tuf.recordObject({
        object,
        publicationId: first.id,
        repositoryPath,
      });
    }
    expect(await tuf.getPublishedObject('package-installer', targetPath)).toBeNull();
    await tuf.recordObject({
      object: timestampObject,
      publicationId: first.id,
      repositoryPath: 'metadata/timestamp.json',
    });
    await tuf.markPublished({ publicationId: first.id });

    expect(
      await tuf.getPublishedObject('package-installer', 'metadata/timestamp.json')
    ).toMatchObject({
      id: timestampObject.id,
      providerVersion: 'provider-5',
    });
    expect(await tuf.getPublishedObject('package-installer', targetPath)).toMatchObject({
      id: objects.get(targetPath)?.id,
      providerVersion: 'provider-1',
    });
  });

  it('commits one exact canonical object through an idempotent write intent', async () => {
    const storage = new ExactStorageCatalog(requireSql());
    const ownerId = await createUploadingVersion('exact-storage-owner');
    const idempotencyKey = `package-version:${randomUUID()}:chunk:${'a'.repeat(64)}`;
    const pending = await storage.beginWriteIntent({
      bucketName: 'common',
      contentType: 'application/octet-stream',
      expectedBytes: 4_096,
      expectedSha256: 'a'.repeat(64),
      idempotencyKey,
      objectKey: `v2/common/chunks/${'b'.repeat(64)}`,
      operation: 'PUT',
      ownerId,
      ownerKind: 'package-version',
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    expect(pending).toMatchObject({
      expectedBytes: 4_096,
      expectedSha256: 'a'.repeat(64),
      state: 'ISSUED',
    });

    const retry = await storage.beginWriteIntent({
      bucketName: 'common',
      contentType: 'application/octet-stream',
      expectedBytes: 4_096,
      expectedSha256: 'a'.repeat(64),
      idempotencyKey,
      objectKey: `v2/common/chunks/${'b'.repeat(64)}`,
      operation: 'PUT',
      ownerId: pending.ownerId,
      ownerKind: 'package-version',
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    expect(retry.id).toBe(pending.id);

    const exact = await storage.commitVerifiedObject({
      fileIdentifier: 'file-id-1',
      intentId: pending.id,
      providerVersion: 'provider-version-1',
    });
    expect(exact).toMatchObject({
      bucketName: 'common',
      bytes: 4_096,
      fileIdentifier: 'file-id-1',
      providerVersion: 'provider-version-1',
      sha256: 'a'.repeat(64),
      storageRole: 'common',
      verificationState: 'VERIFIED',
    });
    expect(
      await storage.findVerifiedCanonical({
        bytes: 4_096,
        sha256: 'a'.repeat(64),
        storageDomain: 'common:global:v2',
        storageRole: 'common',
      })
    ).toEqual(exact);
    expect(
      await storage.commitVerifiedObject({
        fileIdentifier: 'file-id-1',
        intentId: pending.id,
        providerVersion: 'provider-version-1',
      })
    ).toEqual(exact);
    await storage.linkPackageReleaseObject({
      logicalDigest: 'a'.repeat(64),
      logicalKind: 'chunk',
      objectVersionId: exact.id,
      packageVersionId: ownerId,
    });
    await storage.linkPackageReleaseObject({
      logicalDigest: 'a'.repeat(64),
      logicalKind: 'bootstrap-media',
      objectVersionId: exact.id,
      packageVersionId: ownerId,
    });
    await storage.linkPackageReleaseObject({
      logicalDigest: 'a'.repeat(64),
      logicalKind: 'chunk',
      objectVersionId: exact.id,
      packageVersionId: ownerId,
    });
    const releaseObjects = await requireSql()<
      {
        logical_digest: string;
        logical_kind: string;
        object_version_id: string;
        package_version_id: string;
      }[]
    >`
        SELECT
          encode(logical_digest, 'hex') AS logical_digest,
          logical_kind,
          object_version_id,
          package_version_id
        FROM package_release_storage_objects
        WHERE package_version_id = ${ownerId}
        ORDER BY logical_kind
      `;
    expect([...releaseObjects]).toEqual([
      {
        logical_digest: 'a'.repeat(64),
        logical_kind: 'bootstrap-media',
        object_version_id: exact.id,
        package_version_id: ownerId,
      },
      {
        logical_digest: 'a'.repeat(64),
        logical_kind: 'chunk',
        object_version_id: exact.id,
        package_version_id: ownerId,
      },
    ]);
  });

  it('fences one retry claimant for an uncertain exact storage write', async () => {
    const storage = new ExactStorageCatalog(requireSql());
    const ownerId = await createUploadingVersion('exact-storage-retry-owner');
    const idempotencyKey = `package-version:${randomUUID()}:chunk:${'c'.repeat(64)}`;
    const pending = await storage.beginWriteIntent({
      bucketName: 'common',
      contentType: 'application/octet-stream',
      expectedBytes: 8_192,
      expectedSha256: 'c'.repeat(64),
      idempotencyKey,
      objectKey: `v2/common/chunks/${'d'.repeat(64)}`,
      operation: 'PUT',
      ownerId,
      ownerKind: 'package-version',
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    await storage.markWriteIntentUncertain(pending.id);

    const firstClaims = await Promise.all([
      storage.claimUncertainWriteRetry({
        claimDurationMs: 60_000,
        intentId: pending.id,
      }),
      storage.claimUncertainWriteRetry({
        claimDurationMs: 60_000,
        intentId: pending.id,
      }),
    ]);
    const firstClaim = firstClaims.find((claim) => claim !== null);
    expect(firstClaims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(firstClaim).toBeDefined();
    expect(
      await storage.beginWriteIntent({
        bucketName: 'common',
        contentType: 'application/octet-stream',
        expectedBytes: 8_192,
        expectedSha256: 'c'.repeat(64),
        idempotencyKey,
        objectKey: `v2/common/chunks/${'d'.repeat(64)}`,
        operation: 'PUT',
        ownerId,
        ownerKind: 'package-version',
        storageDomain: 'common:global:v2',
        storageRole: 'common',
      })
    ).toMatchObject({
      id: pending.id,
      retryClaimToken: firstClaim?.token,
      state: 'RETRYING',
    });
    expect(
      (
        await storage.beginWriteIntent({
          bucketName: 'common',
          contentType: 'application/octet-stream',
          expectedBytes: 8_192,
          expectedSha256: 'c'.repeat(64),
          idempotencyKey,
          objectKey: `v2/common/chunks/${'d'.repeat(64)}`,
          operation: 'PUT',
          ownerId,
          ownerKind: 'package-version',
          storageDomain: 'common:global:v2',
          storageRole: 'common',
        })
      ).retryClaimExpiresAt
    ).toBeInstanceOf(Date);
    expect(
      await storage.claimUncertainWriteRetry({
        claimDurationMs: 60_000,
        intentId: pending.id,
      })
    ).toBeNull();

    await requireSql()`
      UPDATE storage_write_intents
      SET retry_claim_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${pending.id}
    `;
    const recoveryClaim = await storage.claimUncertainWriteRetry({
      claimDurationMs: 60_000,
      intentId: pending.id,
    });
    expect(recoveryClaim?.token).not.toBe(firstClaim?.token);
    await expect(
      storage.commitVerifiedObject({
        fileIdentifier: 'stale-file-id',
        intentId: pending.id,
        providerVersion: 'stale-provider-version',
        retryClaimToken: firstClaim?.token,
      })
    ).rejects.toThrow('lost commit ownership');
    await expect(storage.markWriteIntentUncertain(pending.id, firstClaim?.token)).rejects.toThrow(
      'cannot become uncertain'
    );

    await storage.markWriteIntentUncertain(pending.id, recoveryClaim?.token);
    const finalClaim = await storage.claimUncertainWriteRetry({
      claimDurationMs: 60_000,
      intentId: pending.id,
    });
    expect(
      await storage.commitVerifiedObject({
        fileIdentifier: 'file-id-retry',
        intentId: pending.id,
        providerVersion: 'provider-version-retry',
        retryClaimToken: finalClaim?.token,
      })
    ).toMatchObject({
      fileIdentifier: 'file-id-retry',
      providerVersion: 'provider-version-retry',
    });
  });

  it('provides reverse indexes for bounded exact-version GC lookups', async () => {
    const indexes = await requireSql()<
      {
        indexdef: string;
        indexname: string;
      }[]
    >`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'package_release_storage_objects_object_idx',
          'storage_write_intents_candidate_object_idx',
          'storage_write_intents_object_state_idx'
        )
      ORDER BY indexname
    `;

    expect(Object.fromEntries(indexes.map((index) => [index.indexname, index.indexdef]))).toEqual({
      package_release_storage_objects_object_idx:
        'CREATE INDEX package_release_storage_objects_object_idx ON public.package_release_storage_objects USING btree (object_version_id, package_version_id)',
      storage_write_intents_candidate_object_idx:
        'CREATE INDEX storage_write_intents_candidate_object_idx ON public.storage_write_intents USING btree (candidate_object_version_id, state) WHERE (candidate_object_version_id IS NOT NULL)',
      storage_write_intents_object_state_idx:
        'CREATE INDEX storage_write_intents_object_state_idx ON public.storage_write_intents USING btree (object_version_id, state) WHERE (object_version_id IS NOT NULL)',
    });
  });

  it('records one exact quarantine version before package assembly', async () => {
    const activeCatalog = requireCatalog();
    const versionId = await createUploadingVersion('quarantine-exact-version');
    const pending = await activeCatalog.beginQuarantineObject({
      bytes: 6_291_456,
      contentType: 'application/zip',
      creatorId: 'creator-quarantine-checkpoint',
      objectKey: `raw/${versionId}/package.zip`,
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      sha256: '7'.repeat(64),
      versionId,
    });
    expect(pending).toMatchObject({
      bytes: 6_291_456,
      creatorId: 'creator-quarantine-checkpoint',
      fileIdentifier: null,
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      providerVersion: null,
      state: 'PENDING',
      versionId,
    });

    const committed = await activeCatalog.commitQuarantineObject({
      fileIdentifier: 'file-id-1',
      providerVersion: 'provider-version-1',
      versionId,
    });
    expect(committed).toMatchObject({
      fileIdentifier: 'file-id-1',
      providerVersion: 'provider-version-1',
      state: 'COMMITTED',
    });
    expect(
      await activeCatalog.commitQuarantineObject({
        fileIdentifier: 'file-id-1',
        providerVersion: 'provider-version-1',
        versionId,
      })
    ).toEqual(committed);
    let conflict: unknown;
    try {
      await activeCatalog.commitQuarantineObject({
        fileIdentifier: 'different-file',
        providerVersion: 'different-version',
        versionId,
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(CatalogInvariantError);
    expect(String(conflict)).toContain('Quarantine object exact version is immutable');
  });

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

  it('migration-history: preserves the deployed 0001 catalog migration checksum', async () => {
    const source = await readFile(
      fileURLToPath(new URL('./migrations/0001_create_catalog.sql', import.meta.url)),
      'utf8'
    );

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '0ee585d9a9714af450ac508b74f796acf2c157d57cf1c030093a423b41b0685a'
    );
  });

  it('migration-v4: preserves legacy ready rows as explicit migratable releases', async () => {
    const adminDatabase = requireSql();
    if (!databaseUrl) {
      throw new Error('Catalog integration database URL is unavailable');
    }
    const legacyDatabaseName = `catalog_legacy_${randomUUID().replaceAll('-', '')}`;
    const legacyDatabaseUrl = new URL(databaseUrl);
    legacyDatabaseUrl.pathname = `/${legacyDatabaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), 'yucp-catalog-legacy-migrations-'));
    const catalogMigrationsPath = fileURLToPath(new URL('./migrations/', import.meta.url));
    let legacyDatabase: CatalogDatabase | undefined;

    try {
      await adminDatabase.unsafe(`CREATE DATABASE "${legacyDatabaseName}"`);
      legacyDatabase = openCatalogDatabase(legacyDatabaseUrl.toString());
      const initialMigrations = (await readdir(catalogMigrationsPath))
        .filter((fileName) => fileName <= '0006_add_materialization_renditions.sql')
        .sort();
      await Promise.all(
        initialMigrations.map((fileName) =>
          copyFile(join(catalogMigrationsPath, fileName), join(migrationDirectory, fileName))
        )
      );
      await runCatalogMigrations(legacyDatabase, { migrationsPath: migrationDirectory });
      const legacyVersionId = randomUUID();
      await legacyDatabase`
        INSERT INTO package_versions (
          id,
          package_id,
          version,
          format_tag,
          canonical_sha256,
          cas_index_id,
          state
        )
        VALUES (
          ${legacyVersionId},
          'club.yucp.legacy-ready',
          '1.0.0',
          'CANONICAL_TARGZ_V1',
          ${'a'.repeat(64)},
          's3:legacy-ready.caibx',
          'READY'
        )
      `;

      await copyFile(
        join(catalogMigrationsPath, '0007_add_logical_release_v4.sql'),
        join(migrationDirectory, '0007_add_logical_release_v4.sql')
      );
      await runCatalogMigrations(legacyDatabase, { migrationsPath: migrationDirectory });

      const rows = await legacyDatabase<
        { common_root: string | null; release_schema_version: number; state: string }[]
      >`
        SELECT common_root, release_schema_version, state
        FROM package_versions
        WHERE id = ${legacyVersionId}
      `;
      expect(rows[0]).toEqual({
        common_root: null,
        release_schema_version: 3,
        state: 'READY',
      });

      const remainingMigrations = (await readdir(catalogMigrationsPath))
        .filter((fileName) => fileName > '0007_add_logical_release_v4.sql')
        .sort();
      await Promise.all(
        remainingMigrations.map((fileName) =>
          copyFile(join(catalogMigrationsPath, fileName), join(migrationDirectory, fileName))
        )
      );
      await runCatalogMigrations(legacyDatabase, { migrationsPath: migrationDirectory });

      const upgradedRows = await legacyDatabase<
        { release_schema_version: number; state: string }[]
      >`
        SELECT release_schema_version, state
        FROM package_versions
        WHERE id = ${legacyVersionId}
      `;
      const releaseColumns = await legacyDatabase<{ column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'package_versions'
          AND column_name IN (
            'assembly_object_id',
            'canonical_sha256',
            'cas_index_id',
            'format_tag',
            'release_root',
            'source_format'
          )
        ORDER BY column_name
      `;
      expect(upgradedRows[0]).toEqual({
        release_schema_version: 3,
        state: 'READY',
      });
      expect(releaseColumns.map((column) => column.column_name)).toEqual([
        'assembly_object_id',
        'release_root',
        'source_format',
      ]);
    } finally {
      await legacyDatabase?.end({ timeout: 1 });
      await adminDatabase.unsafe(`DROP DATABASE IF EXISTS "${legacyDatabaseName}" WITH (FORCE)`);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it('migration-write-intent-retry: adds the fenced reconciliation claim state and index', async () => {
    const database = requireSql();
    const constraintRows = await database<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'storage_write_intents_state_check'
    `;
    const indexRows = await database<{ definition: string }[]>`
      SELECT indexdef AS definition
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'storage_write_intents_reconcile_idx'
    `;

    expect(constraintRows).toHaveLength(1);
    expect(constraintRows[0]?.definition).toContain("'RETRYING'");
    expect(indexRows).toHaveLength(1);
    expect(indexRows[0]?.definition).toContain("'RETRYING'");
  });

  it('happy-path: persists the full lifecycle and every legal transition edge', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const sha256 = 'a'.repeat(64);
    const created = await activeCatalog.createVersion({
      packageId: 'avatar-package',
      version: '1.0.0',
    });

    expect(created).toMatchObject({ state: 'CREATED', sourceFormat: null });

    await activeCatalog.advanceVersion(created.id, 'UPLOADING', {
      event: { type: 'catalog.version.uploading' },
    });
    await activeCatalog.advanceVersion(created.id, 'ASSEMBLED', {
      fields: {
        sourceFormat: 'CANONICAL_TARGZ_V1',
        releaseRoot: sha256,
        assemblyObjectId: 'indexes/avatar-package/1.0.0.caibx',
      },
      event: { type: 'catalog.version.assembled' },
    });
    await activeCatalog.advanceVersion(created.id, 'PROMOTING', {
      event: { type: 'catalog.version.promoting' },
    });
    const ready = await activeCatalog.advanceVersion(created.id, 'READY', {
      fields: publicationFields('a'),
      event: { type: 'catalog.version.ready' },
    });

    expect(ready).toMatchObject({
      state: 'READY',
      sourceFormat: 'CANONICAL_TARGZ_V1',
      releaseRoot: sha256,
      assemblyObjectId: 'indexes/avatar-package/1.0.0.caibx',
      error: null,
      vpmDependencies: {
        'com.example.runtime': '>=2.0.0',
      },
      vpmRepositories: {
        'Example Repository': 'https://packages.example.test/index.json',
      },
    });
    expect(await activeCatalog.getVersion(created.id)).toMatchObject({
      state: 'READY',
      releaseRoot: sha256,
      assemblyObjectId: 'indexes/avatar-package/1.0.0.caibx',
      vpmDependencies: {
        'com.example.runtime': '>=2.0.0',
      },
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
        sourceFormat: 'CANONICAL_ZIP_V1',
        releaseRoot: 'b'.repeat(64),
        assemblyObjectId: 'indexes/assembled.caibx',
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
        sourceFormat: 'CANONICAL_ZIP_V1',
        releaseRoot: 'c'.repeat(64),
        assemblyObjectId: 'indexes/promoting.caibx',
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
    expect(
      await activeCatalog.resolveInstalledVersion({
        editionId: base.editionId,
        packageId: base.packageId,
        releaseRoot: base.releaseRoot as string,
      })
    ).toEqual(base);

    const deleted = await activeCatalog.deleteVersion(base.id, {
      editionId: base.editionId,
      packageId: base.packageId,
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
    expect(
      await activeCatalog.resolveReadyVersion({
        editionId: base.editionId,
        packageId: base.packageId,
        releaseRoot: base.releaseRoot as string,
      })
    ).toBeNull();
    expect(
      await activeCatalog.resolveInstalledVersion({
        editionId: base.editionId,
        packageId: base.packageId,
        releaseRoot: base.releaseRoot as string,
      })
    ).toEqual(deleted);

    const repeated = await activeCatalog.deleteVersion(base.id, {
      editionId: base.editionId,
      packageId: base.packageId,
      reason: 'creator-request',
    });
    expect(repeated).toEqual(deleted);

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

  it('hands a deleted version number back for a clean re-upload', async () => {
    const activeCatalog = requireCatalog();
    const versionId = await createUploadingVersion('deleted-reupload');
    await activeCatalog.advanceVersion(versionId, 'ASSEMBLED', {
      fields: {
        sourceFormat: 'CANONICAL_ZIP_V1',
        releaseRoot: 'd'.repeat(64),
        assemblyObjectId: 'indexes/deleted-reupload.caibx',
      },
      event: { type: 'catalog.version.assembled' },
    });
    await activeCatalog.markFailed(versionId, 'assembly verification failed');
    const deleted = await activeCatalog.deleteVersion(versionId, {
      editionId: 'standard',
      packageId: 'package-reconciler',
      reason: 'creator-request',
    });
    expect(deleted.state).toBe('DELETED');

    const reuploading = await activeCatalog.transition(versionId, 'UPLOADING', {
      event: { type: 'catalog.version.uploading' },
      replacesUpload: true,
    });

    expect(reuploading).toMatchObject({
      id: versionId,
      state: 'UPLOADING',
      error: null,
      deletionReason: null,
      sourceFormat: null,
      releaseRoot: null,
      assemblyObjectId: null,
    });
    expect(reuploading.deletedAt).toBeNull();
  });

  it('releases a superseded attempt storage claims when a replacing upload starts', async () => {
    const storage = new ExactStorageCatalog(requireSql());
    const versionId = await createUploadingVersion('supersede-claims');
    const idempotencyKey = `package-version:${versionId}:chunk:${'c'.repeat(64)}`;
    const intent = await storage.beginWriteIntent({
      bucketName: 'common',
      contentType: 'application/octet-stream',
      expectedBytes: 2_048,
      expectedSha256: 'c'.repeat(64),
      idempotencyKey,
      objectKey: `v2/common/chunks/${'d'.repeat(64)}`,
      operation: 'PUT',
      ownerId: versionId,
      ownerKind: 'package-version',
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    const exact = await storage.commitVerifiedObject({
      fileIdentifier: 'supersede-file-1',
      intentId: intent.id,
      providerVersion: 'supersede-provider-1',
    });
    await storage.linkPackageReleaseObject({
      logicalDigest: 'c'.repeat(64),
      logicalKind: 'chunk',
      objectVersionId: exact.id,
      packageVersionId: versionId,
    });
    await requireCatalog().markFailed(versionId, 'assembly failed');

    await requireCatalog().transition(versionId, 'UPLOADING', {
      event: { type: 'catalog.version.uploading' },
      replacesUpload: true,
    });

    const links = await requireSql()<{ count: number | string }[]>`
      SELECT count(*)::int AS count
      FROM package_release_storage_objects
      WHERE package_version_id = ${versionId}
    `;
    expect(Number(links[0]?.count)).toBe(0);
    const aborted = await storage.getWriteIntentByIdempotencyKey(idempotencyKey);
    expect(aborted).toMatchObject({ objectVersionId: null, state: 'ABORTED' });

    // Identical content coming back revives the intent for a fresh write instead of jamming.
    const revived = await storage.beginWriteIntent({
      bucketName: 'common',
      contentType: 'application/octet-stream',
      expectedBytes: 2_048,
      expectedSha256: 'c'.repeat(64),
      idempotencyKey,
      objectKey: `v2/common/chunks/${'d'.repeat(64)}`,
      operation: 'PUT',
      ownerId: versionId,
      ownerKind: 'package-version',
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    expect(revived).toMatchObject({ id: intent.id, state: 'ISSUED' });
    const recommitted = await storage.commitVerifiedObject({
      fileIdentifier: 'supersede-file-2',
      intentId: intent.id,
      providerVersion: 'supersede-provider-2',
    });
    expect(recommitted.verificationState).toBe('VERIFIED');
  });

  it('purges the previous quarantine intent only when a new upload replaces the bytes', async () => {
    const activeCatalog = requireCatalog();
    const versionId = await createUploadingVersion('quarantine-replace');
    await activeCatalog.beginQuarantineObject({
      bytes: 1024,
      contentType: 'application/zip',
      creatorId: 'creator-quarantine-replace',
      objectKey: `raw/${versionId}/${'8'.repeat(64)}.zip`,
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      sha256: '8'.repeat(64),
      versionId,
    });
    await activeCatalog.markFailed(versionId, 'upload interrupted');

    // Redrive-style retry keeps the quarantine row: it is the provenance of the
    // artifacts being re-promoted.
    await activeCatalog.advanceVersion(versionId, 'UPLOADING', {
      event: { type: 'catalog.version.retrying' },
    });
    expect(await activeCatalog.getQuarantineObject(versionId)).not.toBeNull();

    await activeCatalog.markFailed(versionId, 'upload interrupted again');
    // A creator re-upload replaces the bytes, so the pinned intent must go: left
    // in place it rejects any file that differs from the failed attempt.
    await activeCatalog.transition(versionId, 'UPLOADING', {
      event: { type: 'catalog.version.uploading' },
      replacesUpload: true,
    });
    expect(await activeCatalog.getQuarantineObject(versionId)).toBeNull();

    const replacement = await activeCatalog.beginQuarantineObject({
      bytes: 2048,
      contentType: 'application/zip',
      creatorId: 'creator-quarantine-replace',
      objectKey: `raw/${versionId}/${'9'.repeat(64)}.zip`,
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      sha256: '9'.repeat(64),
      versionId,
    });
    expect(replacement).toMatchObject({ state: 'PENDING', sha256: '9'.repeat(64) });
  });

  it('version-deletion-scope: rejects mismatched package and edition identities atomically', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    for (const [suffix, packageId, editionId] of [
      ['package', 'another-package', 'standard'],
      ['edition', 'managed-scope-edition', 'commercial'],
    ] as const) {
      const version = await createReadyVersion(
        `managed-scope-${suffix}`,
        `release-${suffix}`,
        suffix === 'package' ? '8' : '9'
      );

      const deletion = activeCatalog.deleteVersion(version.id, {
        editionId,
        packageId,
        reason: 'creator-request',
      });

      await expect(deletion).rejects.toBeInstanceOf(PackageVersionNotFoundError);
      expect(await activeCatalog.getVersion(version.id)).toMatchObject({
        editionId: 'standard',
        packageId: `managed-scope-${suffix}`,
        state: 'READY',
      });
      const events = await database<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM catalog_outbox
        WHERE aggregate_id = ${version.id}
          AND event_type = 'catalog.version.deleted'
      `;
      expect(events[0]?.count).toBe(0);
    }
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
          releaseRoot: 'd'.repeat(64),
          assemblyObjectId: 'indexes/missing-format-tag.caibx',
        },
        event: { type: 'catalog.version.assembled' },
      });
    } catch (error) {
      transitionError = error;
    }

    expect(transitionError).toBeInstanceOf(CatalogInvariantError);
    expect(transitionError).toHaveProperty(
      'message',
      'ASSEMBLED requires sourceFormat, releaseRoot, and assemblyObjectId'
    );
    expect(await activeCatalog.getVersion(versionId)).toMatchObject({
      state: 'UPLOADING',
      sourceFormat: null,
      releaseRoot: null,
      assemblyObjectId: null,
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
      sourceFormat: null,
      releaseRoot: null,
      assemblyObjectId: null,
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
        fields: { releaseRoot: 'd'.repeat(64), assemblyObjectId: 'indexes/illegal.caibx' },
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

  it('does not redrive a failed version that has no assembled release to resume', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const versionId = await createUploadingVersion('unresumable-failure');
    await activeCatalog.markFailed(versionId, 'upload failed before assembly completed');
    await database`
      UPDATE package_versions
      SET next_attempt_at = clock_timestamp() - interval '1 millisecond'
      WHERE id = ${versionId}
    `;

    let redriveCalls = 0;
    const result = await reconcileCatalog(database, {
      stuckThresholdMs: 60 * 60 * 1000,
      redrive: async () => {
        redriveCalls += 1;
      },
      publish: async () => {},
    });

    expect(result.versionsRedriven).toBe(0);
    expect(redriveCalls).toBe(0);
  });

  it('redrives a failed upload from a committed quarantine checkpoint', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const versionId = await createUploadingVersion('quarantine-redrive');
    await activeCatalog.beginQuarantineObject({
      bytes: 42,
      contentType: 'application/zip',
      creatorId: 'creator-quarantine-redrive',
      objectKey: `raw/${versionId}/${'a'.repeat(64)}.zip`,
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      sha256: 'a'.repeat(64),
      versionId,
    });
    await activeCatalog.commitQuarantineObject({
      fileIdentifier: 'quarantine-file-redrive',
      providerVersion: 'quarantine-provider-redrive',
      versionId,
    });
    await activeCatalog.markFailed(versionId, 'assembly process stopped');
    await database`
      UPDATE package_versions
      SET next_attempt_at = clock_timestamp() - interval '1 millisecond'
      WHERE id = ${versionId}
    `;

    const redriven: string[] = [];
    const result = await reconcileCatalog(database, {
      stuckThresholdMs: 60 * 60 * 1000,
      redrive: async ({ version }) => {
        redriven.push(version.id);
      },
      publish: async () => {},
    });

    expect(result.versionsRedriven).toBe(1);
    expect(redriven).toEqual([versionId]);
  });

  it('no-infinite-retry: a perpetually failing row is never re-driven after the attempt cap', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const versionId = await createUploadingVersion('perpetually-failing');
    const maxAttempts = 5;
    const initialFailure = await activeCatalog.markFailed(versionId, 'permanent dispatch failure');
    expect(initialFailure.attempts).toBe(1);
    await database`
      UPDATE package_versions
      SET
        assembly_object_id = 's3-index:perpetually-failing',
        release_root = ${'f'.repeat(64)},
        source_format = 'CANONICAL_ZIP_V1'
      WHERE id = ${versionId}
    `;
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

  it('a replacing upload starts with a fresh retry budget', async () => {
    const activeCatalog = requireCatalog();
    const versionId = await createUploadingVersion('fresh-budget');
    await activeCatalog.markFailed(versionId, 'first failure');
    await activeCatalog.advanceVersion(versionId, 'UPLOADING', {
      event: { type: 'catalog.version.retrying' },
    });
    const retried = await activeCatalog.markFailed(versionId, 'second failure');
    expect(retried.attempts).toBe(2);

    const replaced = await activeCatalog.transition(versionId, 'UPLOADING', {
      event: { type: 'catalog.version.uploading' },
      replacesUpload: true,
    });
    expect(replaced.attempts).toBe(0);

    const failedAfterReplacement = await activeCatalog.markFailed(versionId, 'later failure');
    expect(failedAfterReplacement.attempts).toBe(1);
  });

  it('claims a failed row whose replacing upload reset its attempts to zero', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const versionId = await createUploadingVersion('zero-attempt-redrive');
    await activeCatalog.markFailed(versionId, 'transient storage failure');
    await database`
      UPDATE package_versions
      SET
        attempts = 0,
        assembly_object_id = 's3-index:zero-attempt-redrive',
        release_root = ${'e'.repeat(64)},
        source_format = 'CANONICAL_ZIP_V1',
        next_attempt_at = clock_timestamp() - interval '1 millisecond'
      WHERE id = ${versionId}
    `;

    const redriven: string[] = [];
    const result = await reconcileCatalog(database, {
      stuckThresholdMs: 60 * 60 * 1000,
      redrive: async ({ version }) => {
        redriven.push(version.id);
      },
      publish: async () => {},
    });

    expect(redriven).toEqual([versionId]);
    expect(result.versionsRedriven).toBe(1);
  });

  it('a failing redrive does not starve other candidates or outbox publishing', async () => {
    const activeCatalog = requireCatalog();
    const database = requireSql();
    const poisonedId = await createUploadingVersion('poisoned-redrive');
    const healthyId = await createUploadingVersion('healthy-redrive');
    for (const versionId of [poisonedId, healthyId]) {
      await activeCatalog.markFailed(versionId, 'transient storage failure');
      await database`
        UPDATE package_versions
        SET
          assembly_object_id = ${`s3-index:${versionId}`},
          release_root = ${'d'.repeat(64)},
          source_format = 'CANONICAL_ZIP_V1',
          next_attempt_at = clock_timestamp() - interval '1 millisecond'
        WHERE id = ${versionId}
      `;
    }

    const redriven: string[] = [];
    const published: string[] = [];
    let thrown: unknown;
    try {
      await reconcileCatalog(database, {
        stuckThresholdMs: 60 * 60 * 1000,
        redrive: async ({ version }) => {
          if (version.id === poisonedId) {
            throw new Error('redrive dispatch failed');
          }
          redriven.push(version.id);
        },
        publish: async (event) => {
          published.push(event.eventType);
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);

    expect(redriven).toEqual([healthyId]);
    expect(published.length).toBeGreaterThan(0);
  });

  it('expires only retained failures that exhausted their retry policy', async () => {
    const database = requireSql();
    const maxAttempts = 5;
    const retentionMs = 7 * 24 * 60 * 60 * 1_000;
    const now = new Date('2026-07-28T12:00:00.000Z');
    const lifecycleCatalog = new Catalog(database, { maxAttempts });
    const expiredId = await createUploadingVersion('expired-terminal-failure');
    const recentId = await createUploadingVersion('recent-terminal-failure');
    const retryableId = await createUploadingVersion('retryable-retained-failure');

    for (const versionId of [expiredId, recentId, retryableId]) {
      await lifecycleCatalog.markFailed(versionId, 'permanent assembly failure');
    }
    await database`
      UPDATE package_versions
      SET attempts = ${maxAttempts}, updated_at = ${new Date(now.getTime() - retentionMs - 1)}
      WHERE id = ${expiredId}
    `;
    await database`
      UPDATE package_versions
      SET attempts = ${maxAttempts}, updated_at = ${new Date(now.getTime() - retentionMs + 1)}
      WHERE id = ${recentId}
    `;
    await database`
      UPDATE package_versions
      SET attempts = ${maxAttempts - 1}, updated_at = ${new Date(now.getTime() - retentionMs - 1)}
      WHERE id = ${retryableId}
    `;

    const expired = await lifecycleCatalog.expireTerminalFailedVersions({
      limit: 10,
      now,
      retentionMs,
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: expiredId,
      state: 'DELETED',
      deletionReason: 'terminal-failure-retention-expired',
    });
    expect(await lifecycleCatalog.getVersion(recentId)).toMatchObject({ state: 'FAILED' });
    expect(await lifecycleCatalog.getVersion(retryableId)).toMatchObject({ state: 'FAILED' });
    const events = await database<
      { aggregate_id: string; event_type: string; payload: Record<string, unknown> }[]
    >`
      SELECT aggregate_id, event_type, payload
      FROM catalog_outbox
      WHERE event_type = 'catalog.version.deleted'
      ORDER BY created_at, id
    `;
    expect([...events]).toEqual([
      {
        aggregate_id: expiredId,
        event_type: 'catalog.version.deleted',
        payload: expect.objectContaining({
          previousState: 'FAILED',
          reason: 'terminal-failure-retention-expired',
          state: 'DELETED',
        }),
      },
    ]);
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
