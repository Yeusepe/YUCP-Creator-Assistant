// Concurrency bounds for the materialization dispatch pipeline against a real
// PostgreSQL: duplicate createInstallJob calls collapse to one outbox row,
// concurrent relays claim disjoint job sets (FOR UPDATE SKIP LOCKED), and the
// PENDING -> DISPATCHING -> DISPATCHED/RETRY flow never dispatches a job's
// acceptance twice - so a stampede of simultaneous buyers cannot fan one
// purchase out into duplicated paid materialization work.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { type CatalogDatabase, openCatalogDatabase, runCatalogMigrations } from '../catalog';
import { packageContractKeyId } from '../storage-core/packageContractsV2';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
import { waitForPostgres } from '../testing/postgresReadiness';
import type { MaterializationKeyBrokerPort } from './keyBrokerClient';
import { MaterializationBroker } from './materializationBroker';
import {
  type MaterializationDispatchEntry,
  type MaterializationDispatchResult,
  PostgresMaterializationDispatchOutboxRepository,
  relayMaterializationDispatchOutbox,
} from './materializationDispatch';

const postgresImage =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
const databaseName = 'dispatch_concurrency_test';
const databasePassword = 'dispatch-concurrency-test-password';
const containerName = `yucp-dispatch-concurrency-${randomUUID()}`;
const sourceVersionId = '018f8c03-3880-7d40-a8d5-b190a64141dd';

const keyBroker: MaterializationKeyBrokerPort = {
  async prepareSubject(input) {
    return {
      buyerSubjectPseudonym: createHash('sha256')
        .update(input.creatorId)
        .update('\0')
        .update(input.buyerId)
        .digest('base64url'),
      encryptedSubjectMapping: createHash('sha256')
        .update(input.jobId)
        .update('\0')
        .update(input.buyerId)
        .digest(),
      pseudonymMethod: 'hmac-sha256-hkdf-v2',
    };
  },
};

let sql: CatalogDatabase | undefined;
let containerStarted = false;

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

async function runDocker(args: string[]): Promise<CommandResult> {
  const process = Bun.spawn(['docker', ...args], {
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
}

async function requireDocker(args: string[]): Promise<string> {
  const result = await runDocker(args);
  if (result.exitCode !== 0) {
    throw new Error(`Docker failed with exit code ${result.exitCode}: ${result.stderr}`);
  }
  return result.stdout;
}

async function removeContainer(): Promise<void> {
  if (!containerStarted) {
    return;
  }
  const result = await runDocker(['rm', '--force', containerName]);
  containerStarted = false;
  if (result.exitCode !== 0 && !result.stderr.includes('No such container')) {
    throw new Error(`PostgreSQL cleanup failed: ${result.stderr}`);
  }
}

function requireSql(): CatalogDatabase {
  if (!sql) {
    throw new Error('The dispatch concurrency test database is unavailable');
  }
  return sql;
}

function createBroker(): MaterializationBroker {
  return new MaterializationBroker({
    keyBroker,
    receiptSigning: {
      keyId: packageContractKeyId('receipt-test-2026-01'),
      lifetimeSeconds: 7 * 24 * 60 * 60,
      privateKey: new Uint8Array(32).fill(0x39),
    },
    sourceGrant: {
      audience: 'yucp-materialization-source',
      baseUrl: 'https://delivery.example.test',
      issuer: 'https://api.example.test',
      keyId: packageContractKeyId('source-grant-test-2026-01'),
      lifetimeSeconds: 300,
      privateKey: new Uint8Array(32).fill(0x29),
    },
    sql: requireSql(),
  });
}

function installJob(id: string) {
  return {
    bindingRoot: new Uint8Array(32).fill(0x23),
    buyerId: `buyer-${id}`,
    creatorId: 'creator-1',
    grantJti: `grant-${id}`,
    id,
    keyEpoch: 7,
    materializationAlgorithm: 'png-dct-qim-v2',
    outputFormat: 'zip' as const,
    pluginVersion: 'png-plugin-2',
    productId: 'com.yucp.dispatch-concurrency-test',
    protectedSourceRoot: new Uint8Array(32).fill(0x22),
    releaseRoot: new Uint8Array(32).fill(0x11),
    sourceLogicalBytes: 4_096,
    sourceLogicalFiles: 2,
    sourceManifestSha256: new Uint8Array(32).fill(0x88),
    sourceVersionId,
    traceId: `trace-${id}`,
  };
}

async function outboxRows(): Promise<
  Array<{ attempts: number; jobId: string; lastErrorCode: string | null; state: string }>
> {
  return await requireSql()<
    Array<{ attempts: number; jobId: string; lastErrorCode: string | null; state: string }>
  >`
    SELECT
      attempts,
      job_id AS "jobId",
      last_error_code AS "lastErrorCode",
      state
    FROM materialization_dispatch_outbox
    ORDER BY job_id
  `;
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
    const port = /127\.0\.0\.1:(\d+)$/.exec(portOutput)?.[1];
    if (!port) {
      throw new Error(`PostgreSQL port output is invalid: ${portOutput}`);
    }
    sql = openCatalogDatabase(
      `postgres://postgres:${databasePassword}@127.0.0.1:${port}/${databaseName}`
    );
    await runCatalogMigrations(sql);
  } catch (error) {
    await sql?.end({ timeout: 1 });
    sql = undefined;
    await removeContainer();
    throw error;
  }
});

beforeEach(async () => {
  await requireSql()`
    TRUNCATE TABLE
      materialization_attribution_records,
      materialization_capabilities,
      materialization_jobs
    CASCADE
  `;
  await requireSql()`
    INSERT INTO package_versions (
      id,
      package_id,
      version,
      source_format,
      release_root,
      assembly_object_id,
      common_root,
      protected_source_root,
      binding_root,
      manifest_sha256,
      active_content_digest,
      active_policy_version,
      protection_policy_id,
      protection_policy_digest,
      logical_bytes,
      logical_files,
      protected_files,
      state
    )
    VALUES (
      ${sourceVersionId},
      'com.yucp.dispatch-concurrency-test',
      '1.0.0',
      'zip',
      ${'11'.repeat(32)},
      'assemblies/dispatch-concurrency-test.logical-tree-manifest-v4.cbor',
      ${'33'.repeat(32)},
      ${'22'.repeat(32)},
      ${'23'.repeat(32)},
      ${'88'.repeat(32)},
      ${'44'.repeat(32)},
      'active-content-v1',
      ${ACTIVE_PROTECTION_POLICY_ID},
      ${'55'.repeat(32)},
      4096,
      2,
      ${requireSql().json([
        {
          materializerType: 'png',
          normalizedPath: 'Assets/Product/a.png',
          required: false,
          sourceSha256: '41'.repeat(32),
        },
      ])},
      'READY'
    )
    ON CONFLICT (id) DO NOTHING
  `;
});

afterAll(async () => {
  const activeSql = sql;
  sql = undefined;
  try {
    await activeSql?.end({ timeout: 1 });
  } finally {
    await removeContainer();
  }
});

describe.serial('materialization dispatch concurrency', () => {
  it('duplicate createInstallJob calls leave exactly one outbox row per job', async () => {
    const broker = createBroker();

    // Sequential duplicate (the client-retry path).
    await broker.createInstallJob(installJob('job-dup-1'));
    await broker.createInstallJob(installJob('job-dup-1'));

    // Concurrent duplicate (the double-click / two-tab path). One call may
    // reject on the primary-key race, but no duplicate work may be enqueued.
    const concurrent = await Promise.allSettled([
      broker.createInstallJob(installJob('job-dup-2')),
      broker.createInstallJob(installJob('job-dup-2')),
    ]);
    expect(concurrent.some((outcome) => outcome.status === 'fulfilled')).toBeTrue();
    console.log(
      'concurrent duplicate createInstallJob outcomes:',
      concurrent.map((outcome) =>
        outcome.status === 'fulfilled'
          ? 'fulfilled'
          : `rejected: ${(outcome.reason as Error).message}`
      )
    );

    const rows = await requireSql()<Array<{ count: string; jobId: string }>>`
      SELECT job_id AS "jobId", count(*)::text AS count
      FROM materialization_dispatch_outbox
      GROUP BY job_id
      ORDER BY job_id
    `;
    expect(rows.map((row) => ({ ...row, count: Number(row.count) }))).toEqual([
      { count: 1, jobId: 'job-dup-1' },
      { count: 1, jobId: 'job-dup-2' },
    ]);
    const jobs = await requireSql()<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM materialization_jobs
    `;
    expect(Number(jobs[0]?.count)).toBe(2);
  });

  it('two concurrent claims return disjoint job sets covering every pending row once', async () => {
    const broker = createBroker();
    const jobIds = Array.from(
      { length: 15 },
      (_, index) => `job-claim-${String(index).padStart(2, '0')}`
    );
    for (const jobId of jobIds) {
      await broker.createInstallJob(installJob(jobId));
    }
    const repository = new PostgresMaterializationDispatchOutboxRepository(requireSql());

    const [first, second] = await Promise.all([repository.claim(10), repository.claim(10)]);

    expect(first.length).toBeLessThanOrEqual(10);
    expect(second.length).toBeLessThanOrEqual(10);
    const firstIds = new Set(first.map((entry) => entry.jobId));
    const secondIds = new Set(second.map((entry) => entry.jobId));
    for (const jobId of secondIds) {
      expect(firstIds.has(jobId)).toBeFalse();
    }
    const union = new Set([...firstIds, ...secondIds]);
    expect(union.size).toBe(first.length + second.length);
    expect(union.size).toBe(jobIds.length);
    // Every claimed entry carries a routable payload.
    for (const entry of [...first, ...second]) {
      expect(entry.cacheAffinityKey).toMatch(/^[0-9a-f]{64}$/);
      expect(['large', 'maintenance']).toContain(entry.lane);
      expect(entry.couplingMode).toBeUndefined();
    }
    // All 15 rows are now DISPATCHING - claimed exactly once.
    const rows = await outboxRows();
    expect(rows.length).toBe(jobIds.length);
    expect(rows.every((row) => row.state === 'DISPATCHING')).toBeTrue();
    expect(rows.every((row) => row.attempts === 1)).toBeTrue();
  });

  it('30 jobs flow PENDING -> DISPATCHING -> DISPATCHED/RETRY without duplicate acceptance', async () => {
    const broker = createBroker();
    const jobIds = Array.from(
      { length: 30 },
      (_, index) => `job-flow-${String(index).padStart(2, '0')}`
    );
    for (const jobId of jobIds) {
      await broker.createInstallJob(installJob(jobId));
    }
    const repository = new PostgresMaterializationDispatchOutboxRepository(requireSql());
    const failFirstPass = new Set(jobIds.filter((_, index) => index % 3 === 0));
    const dispatchLog: string[][] = [];
    let failuresArmed = true;
    const dispatch = async (
      entries: MaterializationDispatchEntry[]
    ): Promise<MaterializationDispatchResult[]> => {
      dispatchLog.push(entries.map((entry) => entry.jobId));
      return entries.map((entry) => {
        const fail = failuresArmed && failFirstPass.has(entry.jobId);
        return {
          accepted: !fail,
          ...(fail ? { errorCode: 'dispatch_rejected_test' } : {}),
          jobId: entry.jobId,
        };
      });
    };

    // Pass 1: two relays race for the same outbox. SKIP LOCKED must hand each
    // job to at most one relay, so the combined log covers all 30 exactly once.
    await Promise.all([
      relayMaterializationDispatchOutbox({ dispatch, repository }),
      relayMaterializationDispatchOutbox({ dispatch, repository }),
    ]);
    const firstPassJobs = dispatchLog.flat();
    expect(firstPassJobs.length).toBe(jobIds.length);
    expect(new Set(firstPassJobs).size).toBe(jobIds.length);

    const afterFirstPass = await outboxRows();
    const dispatched = afterFirstPass.filter((row) => row.state === 'DISPATCHED');
    const retrying = afterFirstPass.filter((row) => row.state === 'RETRY');
    expect(dispatched.length).toBe(jobIds.length - failFirstPass.size);
    expect(retrying.length).toBe(failFirstPass.size);
    expect(new Set(retrying.map((row) => row.jobId))).toEqual(failFirstPass);
    expect(retrying.every((row) => row.lastErrorCode === 'dispatch_rejected_test')).toBeTrue();

    // Backoff keeps the failed rows out of an immediate re-claim: a relay run
    // right now attempts nothing (no hot retry loop burning dispatch calls).
    const idle = await relayMaterializationDispatchOutbox({ dispatch, repository });
    expect(idle).toEqual({ accepted: 0, attempted: 0, failed: 0 });

    // Pass 2: fast-forward the backoff, accept everything.
    failuresArmed = false;
    await requireSql()`
      UPDATE materialization_dispatch_outbox
      SET next_attempt_at = clock_timestamp() - interval '1 second'
      WHERE state = 'RETRY'
    `;
    const secondPass = await relayMaterializationDispatchOutbox({ dispatch, repository });
    expect(secondPass).toEqual({
      accepted: failFirstPass.size,
      attempted: failFirstPass.size,
      failed: 0,
    });

    const finalRows = await outboxRows();
    expect(finalRows.length).toBe(jobIds.length);
    expect(finalRows.every((row) => row.state === 'DISPATCHED')).toBeTrue();
    for (const row of finalRows) {
      expect(row.attempts).toBe(failFirstPass.has(row.jobId) ? 2 : 1);
    }

    // Across every relay call, no job was ever handed to the dispatcher while
    // already DISPATCHED, and each job's acceptance happened exactly once.
    const allDispatches = dispatchLog.flat();
    expect(allDispatches.length).toBe(jobIds.length + failFirstPass.size);
    const perJob = new Map<string, number>();
    for (const jobId of allDispatches) {
      perJob.set(jobId, (perJob.get(jobId) ?? 0) + 1);
    }
    for (const jobId of jobIds) {
      expect(perJob.get(jobId)).toBe(failFirstPass.has(jobId) ? 2 : 1);
    }

    // Drained outbox: one more relay attempts nothing.
    const drained = await relayMaterializationDispatchOutbox({ dispatch, repository });
    expect(drained).toEqual({ accepted: 0, attempted: 0, failed: 0 });
  });
});
