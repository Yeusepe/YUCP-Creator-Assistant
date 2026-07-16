import type { CatalogState, PackageVersion } from './catalog';
import type { CatalogDatabase } from './database';

const transientStates = [
  'UPLOADING',
  'ASSEMBLED',
  'PROMOTING',
] as const satisfies readonly CatalogState[];

interface StuckVersionRow {
  id: string;
  package_id: string;
  version: string;
  format_tag: string;
  canonical_sha256: string | null;
  cas_index_id: string | null;
  state: (typeof transientStates)[number];
  error: null;
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

export interface ReconcileCatalogOptions {
  stuckThresholdMs: number;
  batchSize?: number;
  redrive: (request: RedriveRequest) => Promise<void>;
  publish: (event: CatalogOutboxEvent) => Promise<void>;
}

export interface ReconcileCatalogResult {
  versionsRedriven: number;
  outboxEventsPublished: number;
}

function toPackageVersion(row: StuckVersionRow): PackageVersion {
  return {
    id: row.id,
    packageId: row.package_id,
    version: row.version,
    formatTag: row.format_tag,
    canonicalSha256: row.canonical_sha256,
    casIndexId: row.cas_index_id,
    state: row.state,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertOptions(options: ReconcileCatalogOptions): number {
  if (!Number.isSafeInteger(options.stuckThresholdMs) || options.stuckThresholdMs <= 0) {
    throw new RangeError('stuckThresholdMs must be a positive safe integer');
  }
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('batchSize must be a positive safe integer');
  }
  return batchSize;
}

export async function reconcileCatalog(
  sql: CatalogDatabase,
  options: ReconcileCatalogOptions
): Promise<ReconcileCatalogResult> {
  const batchSize = assertOptions(options);
  const stuckCandidates = await sql<{ id: string }[]>`
    SELECT id
    FROM package_versions
    WHERE
      state IN ${sql(transientStates)}
      AND updated_at <= clock_timestamp() - (${options.stuckThresholdMs} * interval '1 millisecond')
    ORDER BY updated_at, id
    LIMIT ${batchSize}
  `;

  let versionsRedriven = 0;
  for (const candidate of stuckCandidates) {
    const redriven = await sql.begin(async (transaction) => {
      const rows = await transaction<StuckVersionRow[]>`
        SELECT *
        FROM package_versions
        WHERE
          id = ${candidate.id}
          AND state IN ${transaction(transientStates)}
          AND updated_at <= clock_timestamp() - (${options.stuckThresholdMs} * interval '1 millisecond')
        FOR UPDATE SKIP LOCKED
      `;
      const stuck = rows[0];
      if (!stuck) {
        return false;
      }

      await options.redrive({
        version: toPackageVersion(stuck),
        idempotencyKey: `${stuck.id}:${stuck.state}:${stuck.updated_at.toISOString()}`,
      });
      await transaction`
        UPDATE package_versions SET updated_at = clock_timestamp() WHERE id = ${stuck.id}
      `;
      return true;
    });
    if (redriven) {
      versionsRedriven += 1;
    }
  }

  const outboxCandidates = await sql<{ id: string }[]>`
    SELECT id
    FROM catalog_outbox
    WHERE published_at IS NULL
    ORDER BY created_at, id
    LIMIT ${batchSize}
  `;

  let outboxEventsPublished = 0;
  for (const candidate of outboxCandidates) {
    const published = await sql.begin(async (transaction) => {
      const rows = await transaction<OutboxRow[]>`
        SELECT id, aggregate_id, event_type, payload, created_at
        FROM catalog_outbox
        WHERE id = ${candidate.id} AND published_at IS NULL
        FOR UPDATE SKIP LOCKED
      `;
      const event = rows[0];
      if (!event) {
        return false;
      }

      await options.publish({
        id: event.id,
        aggregateId: event.aggregate_id,
        eventType: event.event_type,
        payload: event.payload,
        createdAt: event.created_at,
      });
      await transaction`
        UPDATE catalog_outbox SET published_at = clock_timestamp() WHERE id = ${event.id}
      `;
      return true;
    });
    if (published) {
      outboxEventsPublished += 1;
    }
  }

  return { versionsRedriven, outboxEventsPublished };
}
