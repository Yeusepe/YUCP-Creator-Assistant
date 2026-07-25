import { randomUUID } from 'node:crypto';
import { CATALOG_HEARTBEAT_INTERVAL_MS, type CatalogState, type PackageVersion } from './catalog';
import { type CatalogDatabase, type CatalogTimestamp, toCatalogDate } from './database';
import {
  type RetryPolicy,
  type RetryPolicyOptions,
  resolveRetryPolicy,
  retryBackoffMs,
} from './retry-policy';

const transientStates = [
  'UPLOADING',
  'ASSEMBLED',
  'PROMOTING',
] as const satisfies readonly CatalogState[];
const retryableStates = [...transientStates, 'FAILED'] as const satisfies readonly CatalogState[];

export const DEFAULT_RECONCILE_BATCH_LIMIT = 100;
const OUTBOX_PUBLISH_CLAIM_TTL_MS = 5 * 60 * 1000;

interface ReconcileVersionRow {
  catalog_product_id: string | null;
  id: string;
  package_id: string;
  version: string;
  source_format: string | null;
  release_root: string | null;
  assembly_object_id: string | null;
  state: (typeof retryableStates)[number];
  error: string | null;
  attempts: number;
  next_attempt_at: CatalogTimestamp | null;
  created_at: Date;
  updated_at: Date;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

interface ClaimedRedrive {
  version: PackageVersion;
  idempotencyKey: string;
}

interface ClaimedOutbox {
  claimId: string;
  event: CatalogOutboxEvent;
}

export interface CatalogOutboxEvent {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface RedriveRequest {
  version: PackageVersion;
  idempotencyKey: string;
}

export interface ReconcileCatalogOptions extends RetryPolicyOptions {
  stuckThresholdMs: number;
  batchLimit?: number;
  redrive: (request: RedriveRequest) => Promise<void>;
  publish: (event: CatalogOutboxEvent) => Promise<void>;
}

export interface ReconcileCatalogResult {
  versionsRedriven: number;
  outboxEventsPublished: number;
}

function toPackageVersion(row: ReconcileVersionRow): PackageVersion {
  return {
    activeContentDigest: null,
    activePolicyVersion: null,
    bindingRoot: null,
    catalogProductId: row.catalog_product_id,
    commonRoot: null,
    id: row.id,
    logicalBytes: null,
    logicalFiles: null,
    manifestSha256: null,
    packageId: row.package_id,
    protectedFiles: null,
    protectedSourceRoot: null,
    protectionPolicyDigest: null,
    protectionPolicyId: null,
    version: row.version,
    sourceFormat: row.source_format,
    releaseRoot: row.release_root,
    assemblyObjectId: row.assembly_object_id,
    state: row.state,
    error: row.error,
    deletedAt: null,
    deletionReason: null,
    attempts: row.attempts,
    nextAttemptAt: toCatalogDate(row.next_attempt_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    vpmDependencies: {},
    vpmRepositories: {},
  };
}

function resolveOptions(options: ReconcileCatalogOptions): {
  batchLimit: number;
  retryPolicy: RetryPolicy;
} {
  if (!Number.isSafeInteger(options.stuckThresholdMs) || options.stuckThresholdMs <= 0) {
    throw new RangeError('stuckThresholdMs must be a positive safe integer');
  }
  if (options.stuckThresholdMs < CATALOG_HEARTBEAT_INTERVAL_MS * 2) {
    throw new RangeError(
      `stuckThresholdMs must be at least ${CATALOG_HEARTBEAT_INTERVAL_MS * 2} milliseconds`
    );
  }
  const batchLimit = options.batchLimit ?? DEFAULT_RECONCILE_BATCH_LIMIT;
  if (!Number.isSafeInteger(batchLimit) || batchLimit <= 0) {
    throw new RangeError('batchLimit must be a positive safe integer');
  }
  return { batchLimit, retryPolicy: resolveRetryPolicy(options) };
}

async function claimRedrive(
  sql: CatalogDatabase,
  candidateId: string,
  stuckThresholdMs: number,
  retryPolicy: RetryPolicy
): Promise<ClaimedRedrive | null> {
  return sql.begin(async (transaction) => {
    const rows = await transaction<ReconcileVersionRow[]>`
      SELECT *
      FROM package_versions
      WHERE
        id = ${candidateId}
        AND attempts < ${retryPolicy.maxAttempts}
        AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
        AND (
          state = 'FAILED'
          OR (
            state IN ${transaction(transientStates)}
            AND updated_at <=
              clock_timestamp() - (${stuckThresholdMs} * interval '1 millisecond')
          )
        )
      FOR UPDATE SKIP LOCKED
    `;
    const candidate = rows[0];
    if (!candidate) {
      return null;
    }

    const attempts = candidate.state === 'FAILED' ? candidate.attempts : candidate.attempts + 1;
    const backoffMs = retryBackoffMs(attempts, retryPolicy);
    let updated: ReconcileVersionRow | undefined;

    if (candidate.state === 'FAILED') {
      const updatedRows = await transaction<ReconcileVersionRow[]>`
        UPDATE package_versions
        SET
          next_attempt_at = clock_timestamp() + (${backoffMs} * interval '1 millisecond'),
          updated_at = clock_timestamp()
        WHERE id = ${candidate.id}
        RETURNING *
      `;
      updated = updatedRows[0];
    } else {
      const error = `Reconciler detected stuck ${candidate.state} work`;
      const updatedRows = await transaction<ReconcileVersionRow[]>`
        UPDATE package_versions
        SET
          state = 'FAILED',
          error = ${error},
          attempts = ${attempts},
          next_attempt_at = clock_timestamp() + (${backoffMs} * interval '1 millisecond'),
          updated_at = clock_timestamp()
        WHERE id = ${candidate.id}
        RETURNING *
      `;
      updated = updatedRows[0];
      if (updated) {
        await transaction`
          INSERT INTO catalog_outbox (id, aggregate_id, event_type, payload)
          VALUES (
            ${randomUUID()},
            ${updated.id},
            'catalog.version.failed',
            ${transaction.json({
              versionId: updated.id,
              packageId: updated.package_id,
              version: updated.version,
              previousState: candidate.state,
              state: 'FAILED',
              attempts: updated.attempts,
              reason: 'stuck-transient',
            })}
          )
        `;
      }
    }

    if (!updated) {
      throw new Error('PostgreSQL did not return the claimed package version');
    }
    return {
      version: toPackageVersion(updated),
      idempotencyKey: `${updated.id}:redrive:${updated.attempts}`,
    };
  });
}

async function claimOutboxEvent(
  sql: CatalogDatabase,
  candidateId: string
): Promise<ClaimedOutbox | null> {
  const claimId = randomUUID();
  return sql.begin(async (transaction) => {
    const rows = await transaction<OutboxRow[]>`
      SELECT id, aggregate_id, event_type, payload, created_at
      FROM catalog_outbox
      WHERE
        id = ${candidateId}
        AND published_at IS NULL
        AND (
          publish_claimed_at IS NULL
          OR publish_claimed_at <=
            clock_timestamp() - (${OUTBOX_PUBLISH_CLAIM_TTL_MS} * interval '1 millisecond')
        )
      FOR UPDATE SKIP LOCKED
    `;
    const event = rows[0];
    if (!event) {
      return null;
    }
    await transaction`
      UPDATE catalog_outbox
      SET publish_claim_id = ${claimId}, publish_claimed_at = clock_timestamp()
      WHERE id = ${event.id}
    `;
    return {
      claimId,
      event: {
        id: event.id,
        aggregateId: event.aggregate_id,
        eventType: event.event_type,
        payload: event.payload,
        createdAt: event.created_at,
      },
    };
  });
}

export async function reconcileCatalog(
  sql: CatalogDatabase,
  options: ReconcileCatalogOptions
): Promise<ReconcileCatalogResult> {
  const { batchLimit, retryPolicy } = resolveOptions(options);
  const candidates = await sql<{ id: string }[]>`
    SELECT id
    FROM package_versions
    WHERE
      attempts < ${retryPolicy.maxAttempts}
      AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
      AND (
        state = 'FAILED'
        OR (
          state IN ${sql(transientStates)}
          AND updated_at <=
            clock_timestamp() - (${options.stuckThresholdMs} * interval '1 millisecond')
        )
      )
    ORDER BY
      CASE
        WHEN state = 'FAILED' THEN COALESCE(next_attempt_at, updated_at)
        ELSE updated_at
      END,
      updated_at,
      id
    LIMIT ${batchLimit}
  `;

  let versionsClaimed = 0;
  let versionsRedriven = 0;
  for (const candidate of candidates) {
    const claim = await claimRedrive(sql, candidate.id, options.stuckThresholdMs, retryPolicy);
    if (!claim) {
      continue;
    }
    versionsClaimed += 1;
    await options.redrive(claim);
    versionsRedriven += 1;
  }

  const remainingBatchCapacity = batchLimit - versionsClaimed;
  const outboxCandidates =
    remainingBatchCapacity > 0
      ? await sql<{ id: string }[]>`
          SELECT id
          FROM catalog_outbox
          WHERE
            published_at IS NULL
            AND (
              publish_claimed_at IS NULL
              OR publish_claimed_at <=
                clock_timestamp() - (${OUTBOX_PUBLISH_CLAIM_TTL_MS} * interval '1 millisecond')
            )
          ORDER BY created_at, id
          LIMIT ${remainingBatchCapacity}
        `
      : [];

  let outboxEventsPublished = 0;
  for (const candidate of outboxCandidates) {
    const claim = await claimOutboxEvent(sql, candidate.id);
    if (!claim) {
      continue;
    }
    try {
      await options.publish(claim.event);
    } catch (error) {
      await sql.begin(async (transaction) => {
        await transaction`
          UPDATE catalog_outbox
          SET publish_claim_id = NULL, publish_claimed_at = NULL
          WHERE id = ${claim.event.id} AND publish_claim_id = ${claim.claimId}
        `;
      });
      throw error;
    }
    const published = await sql.begin(async (transaction) => {
      const rows = await transaction<{ id: string }[]>`
        UPDATE catalog_outbox
        SET
          published_at = clock_timestamp(),
          publish_claim_id = NULL,
          publish_claimed_at = NULL
        WHERE
          id = ${claim.event.id}
          AND published_at IS NULL
          AND publish_claim_id = ${claim.claimId}
        RETURNING id
      `;
      return rows.length === 1;
    });
    if (published) {
      outboxEventsPublished += 1;
    }
  }

  return { versionsRedriven, outboxEventsPublished };
}
