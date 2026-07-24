import { randomUUID } from 'node:crypto';
import { type CatalogDatabase, type CatalogTimestamp, toCatalogDate } from './database';
import {
  type RetryPolicy,
  type RetryPolicyOptions,
  resolveRetryPolicy,
  retryBackoffMs,
} from './retry-policy';

export const CATALOG_STATES = [
  'CREATED',
  'UPLOADING',
  'ASSEMBLED',
  'PROMOTING',
  'READY',
  'FAILED',
  'DELETED',
] as const;

export type CatalogState = (typeof CATALOG_STATES)[number];
export type LiveCatalogState = Extract<CatalogState, 'UPLOADING' | 'PROMOTING'>;

export const CATALOG_HEARTBEAT_INTERVAL_MS = 30_000;

const allowedTransitions = {
  CREATED: ['UPLOADING', 'FAILED', 'DELETED'],
  UPLOADING: ['ASSEMBLED', 'FAILED'],
  ASSEMBLED: ['PROMOTING', 'FAILED'],
  PROMOTING: ['READY', 'FAILED'],
  READY: ['DELETED'],
  FAILED: ['UPLOADING', 'DELETED'],
  DELETED: [],
} as const satisfies Record<CatalogState, readonly CatalogState[]>;

export const ALLOWED_CATALOG_TRANSITIONS: Readonly<Record<CatalogState, readonly CatalogState[]>> =
  allowedTransitions;

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface CatalogEvent {
  type: string;
  payload?: JsonObject;
}

export interface PackageVersion {
  catalogProductId: string | null;
  id: string;
  packageId: string;
  version: string;
  formatTag: string | null;
  canonicalSha256: string | null;
  casIndexId: string | null;
  state: CatalogState;
  error: string | null;
  deletedAt: Date | null;
  deletionReason: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PackageVersionRow {
  catalog_product_id: string | null;
  id: string;
  package_id: string;
  version: string;
  format_tag: string | null;
  canonical_sha256: string | null;
  cas_index_id: string | null;
  state: CatalogState;
  error: string | null;
  deleted_at: Date | null;
  deletion_reason: string | null;
  attempts: number;
  next_attempt_at: CatalogTimestamp | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateVersionInput {
  catalogProductId?: string;
  id?: string;
  packageId: string;
  version: string;
  event?: CatalogEvent;
}

export interface TransitionFields {
  formatTag?: string;
  canonicalSha256?: string;
  casIndexId?: string;
  error?: string;
  deletionReason?: string;
}

export interface TransitionOptions {
  fields?: TransitionFields;
  event: CatalogEvent;
}

export class PackageVersionNotFoundError extends Error {
  readonly versionId: string;

  constructor(versionId: string) {
    super(`Package version not found: ${versionId}`);
    this.name = 'PackageVersionNotFoundError';
    this.versionId = versionId;
  }
}

export class IllegalCatalogTransitionError extends Error {
  readonly versionId: string;
  readonly currentState: CatalogState;
  readonly targetState: CatalogState;

  constructor(versionId: string, currentState: CatalogState, targetState: CatalogState) {
    super(`Illegal package version transition: ${currentState} -> ${targetState}`);
    this.name = 'IllegalCatalogTransitionError';
    this.versionId = versionId;
    this.currentState = currentState;
    this.targetState = targetState;
  }
}

export class CatalogInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogInvariantError';
  }
}

export class CatalogOwnershipLostError extends Error {
  override name = 'AbortError';

  constructor(versionId: string, state: LiveCatalogState, options?: ErrorOptions) {
    super(`Package version ${versionId} lost ${state} ownership`, options);
  }
}

function toPackageVersion(row: PackageVersionRow): PackageVersion {
  return {
    catalogProductId: row.catalog_product_id,
    id: row.id,
    packageId: row.package_id,
    version: row.version,
    formatTag: row.format_tag,
    canonicalSha256: row.canonical_sha256,
    casIndexId: row.cas_index_id,
    state: row.state,
    error: row.error,
    deletedAt: row.deleted_at,
    deletionReason: row.deletion_reason,
    attempts: row.attempts,
    nextAttemptAt: toCatalogDate(row.next_attempt_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateTransitionFields(
  current: PackageVersionRow,
  targetState: CatalogState,
  fields: TransitionFields
): {
  formatTag: string | null;
  canonicalSha256: string | null;
  casIndexId: string | null;
  error: string | null;
  deletionReason: string | null;
} {
  const formatTag = fields.formatTag ?? current.format_tag;
  const canonicalSha256 = fields.canonicalSha256 ?? current.canonical_sha256;
  const casIndexId = fields.casIndexId ?? current.cas_index_id;
  const deletionReason = fields.deletionReason?.trim() ?? current.deletion_reason;

  if ((canonicalSha256 === null) !== (casIndexId === null)) {
    throw new CatalogInvariantError(
      'canonicalSha256 and casIndexId must either both be present or both be absent'
    );
  }
  if (
    (targetState === 'ASSEMBLED' || targetState === 'PROMOTING' || targetState === 'READY') &&
    (formatTag === null || canonicalSha256 === null || casIndexId === null)
  ) {
    throw new CatalogInvariantError(
      `${targetState} requires formatTag, canonicalSha256, and casIndexId`
    );
  }

  if (targetState === 'FAILED') {
    if (!fields.error?.trim()) {
      throw new CatalogInvariantError('FAILED requires a non-empty error');
    }
    return {
      formatTag,
      canonicalSha256,
      casIndexId,
      error: fields.error,
      deletionReason: null,
    };
  }
  if (fields.error !== undefined) {
    throw new CatalogInvariantError('error can only be set when transitioning to FAILED');
  }

  if (targetState === 'DELETED' && !deletionReason) {
    throw new CatalogInvariantError('DELETED requires a non-empty deletion reason');
  }
  if (targetState !== 'DELETED' && fields.deletionReason !== undefined) {
    throw new CatalogInvariantError('deletionReason can only be set when transitioning to DELETED');
  }

  return {
    formatTag,
    canonicalSha256,
    casIndexId,
    error: null,
    deletionReason: targetState === 'DELETED' ? deletionReason : null,
  };
}

function eventPayload(
  event: CatalogEvent,
  version: PackageVersionRow,
  previousState: CatalogState | null,
  state: CatalogState
): JsonObject {
  return {
    ...event.payload,
    versionId: version.id,
    packageId: version.package_id,
    version: version.version,
    ...(version.catalog_product_id ? { catalogProductId: version.catalog_product_id } : {}),
    previousState,
    state,
  };
}

function deletionReason(value: string): string {
  const reason = value.trim();
  if (!reason) {
    throw new CatalogInvariantError('Deletion requires a non-empty reason');
  }
  return reason;
}

export class Catalog {
  private readonly retryPolicy: RetryPolicy;

  constructor(
    private readonly sql: CatalogDatabase,
    retryPolicyOptions: RetryPolicyOptions = {}
  ) {
    this.retryPolicy = resolveRetryPolicy(retryPolicyOptions);
  }

  async createVersion(input: CreateVersionInput): Promise<PackageVersion> {
    const id = input.id ?? randomUUID();
    const event = input.event ?? { type: 'catalog.version.created' };

    return this.sql.begin(async (transaction) => {
      const rows = await transaction<PackageVersionRow[]>`
        INSERT INTO package_versions (id, package_id, version, catalog_product_id, state)
        VALUES (
          ${id},
          ${input.packageId},
          ${input.version},
          ${input.catalogProductId ?? null},
          'CREATED'
        )
        RETURNING *
      `;
      const created = rows[0];
      if (!created) {
        throw new Error('PostgreSQL did not return the created package version');
      }

      await transaction`
        INSERT INTO catalog_outbox (id, aggregate_id, event_type, payload)
        VALUES (
          ${randomUUID()},
          ${created.id},
          ${event.type},
          ${transaction.json(eventPayload(event, created, null, 'CREATED'))}
        )
      `;
      return toPackageVersion(created);
    });
  }

  async getVersion(versionId: string): Promise<PackageVersion | null> {
    const rows = await this.sql<PackageVersionRow[]>`
      SELECT * FROM package_versions WHERE id = ${versionId}
    `;
    return rows[0] ? toPackageVersion(rows[0]) : null;
  }

  async listVersions(
    packageId: string,
    options: { includeDeleted?: boolean } = {}
  ): Promise<PackageVersion[]> {
    const rows = options.includeDeleted
      ? await this.sql<PackageVersionRow[]>`
          SELECT *
          FROM package_versions
          WHERE package_id = ${packageId}
          ORDER BY created_at, id
        `
      : await this.sql<PackageVersionRow[]>`
          SELECT *
          FROM package_versions
          WHERE package_id = ${packageId} AND state <> 'DELETED'
          ORDER BY created_at, id
        `;
    return rows.map(toPackageVersion);
  }

  async heartbeatVersion(versionId: string, state: LiveCatalogState): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE package_versions
      SET updated_at = clock_timestamp()
      WHERE id = ${versionId} AND state = ${state}
      RETURNING id
    `;
    return rows.length === 1;
  }

  async transition(
    versionId: string,
    targetState: CatalogState,
    options: TransitionOptions
  ): Promise<PackageVersion> {
    return this.sql.begin(async (transaction) => {
      const currentRows = await transaction<PackageVersionRow[]>`
        SELECT * FROM package_versions WHERE id = ${versionId} FOR UPDATE
      `;
      const current = currentRows[0];
      if (!current) {
        throw new PackageVersionNotFoundError(versionId);
      }
      if (!(allowedTransitions[current.state] as readonly CatalogState[]).includes(targetState)) {
        throw new IllegalCatalogTransitionError(versionId, current.state, targetState);
      }

      const fields = validateTransitionFields(current, targetState, options.fields ?? {});
      const enteringFailed = targetState === 'FAILED';
      const nextAttempts = current.attempts + (enteringFailed ? 1 : 0);
      const backoffMs = enteringFailed ? retryBackoffMs(nextAttempts, this.retryPolicy) : 0;
      const updatedRows = await transaction<PackageVersionRow[]>`
        UPDATE package_versions
        SET
          state = ${targetState},
          format_tag = ${fields.formatTag},
          canonical_sha256 = ${fields.canonicalSha256},
          cas_index_id = ${fields.casIndexId},
          error = ${fields.error},
          deleted_at = CASE
            WHEN ${targetState === 'DELETED'} THEN clock_timestamp()
            ELSE NULL
          END,
          deletion_reason = ${fields.deletionReason},
          attempts = ${nextAttempts},
          next_attempt_at = CASE
            WHEN ${enteringFailed}
              THEN clock_timestamp() + (${backoffMs} * interval '1 millisecond')
            ELSE NULL
          END,
          updated_at = clock_timestamp()
        WHERE id = ${versionId}
        RETURNING *
      `;
      const updated = updatedRows[0];
      if (!updated) {
        throw new Error('PostgreSQL did not return the transitioned package version');
      }

      await transaction`
        INSERT INTO catalog_outbox (id, aggregate_id, event_type, payload)
        VALUES (
          ${randomUUID()},
          ${versionId},
          ${options.event.type},
          ${transaction.json(eventPayload(options.event, updated, current.state, targetState))}
        )
      `;
      return toPackageVersion(updated);
    });
  }

  async advanceVersion(
    versionId: string,
    targetState: Exclude<CatalogState, 'CREATED' | 'FAILED' | 'DELETED'>,
    options: TransitionOptions
  ): Promise<PackageVersion> {
    return this.transition(versionId, targetState, options);
  }

  async markFailed(
    versionId: string,
    error: string,
    event: CatalogEvent = { type: 'catalog.version.failed' }
  ): Promise<PackageVersion> {
    return this.transition(versionId, 'FAILED', { fields: { error }, event });
  }

  async deleteVersion(
    versionId: string,
    input: { reason: string; event?: CatalogEvent }
  ): Promise<PackageVersion> {
    const reason = deletionReason(input.reason);
    const event = input.event ?? {
      type: 'catalog.version.deleted',
      payload: { reason },
    };
    return await this.sql.begin(async (transaction) => {
      const currentRows = await transaction<PackageVersionRow[]>`
        SELECT * FROM package_versions WHERE id = ${versionId} FOR UPDATE
      `;
      const current = currentRows[0];
      if (!current) {
        throw new PackageVersionNotFoundError(versionId);
      }
      if (current.state === 'DELETED') {
        return toPackageVersion(current);
      }
      if (!(allowedTransitions[current.state] as readonly CatalogState[]).includes('DELETED')) {
        throw new IllegalCatalogTransitionError(versionId, current.state, 'DELETED');
      }

      const updatedRows = await transaction<PackageVersionRow[]>`
        UPDATE package_versions
        SET
          state = 'DELETED',
          deleted_at = clock_timestamp(),
          deletion_reason = ${reason},
          updated_at = clock_timestamp()
        WHERE id = ${versionId}
        RETURNING *
      `;
      const updated = updatedRows[0];
      if (!updated) {
        throw new Error('PostgreSQL did not return the deleted package version');
      }
      await transaction`
        INSERT INTO catalog_outbox (id, aggregate_id, event_type, payload)
        VALUES (
          ${randomUUID()},
          ${versionId},
          ${event.type},
          ${transaction.json(eventPayload(event, updated, current.state, 'DELETED'))}
        )
      `;
      return toPackageVersion(updated);
    });
  }

  async deletePackageVersions(
    packageId: string,
    input: { reason: string }
  ): Promise<PackageVersion[]> {
    const reason = deletionReason(input.reason);
    const result = await this.sql.begin(async (transaction) => {
      const rows = await transaction<PackageVersionRow[]>`
        SELECT *
        FROM package_versions
        WHERE package_id = ${packageId}
        ORDER BY created_at, id
        FOR UPDATE
      `;
      const activeRows = rows.filter((row) => row.state !== 'DELETED');
      const blocked = activeRows.find(
        (row) => !(allowedTransitions[row.state] as readonly CatalogState[]).includes('DELETED')
      );
      if (blocked) {
        return {
          blocked: {
            id: blocked.id,
            state: blocked.state,
          },
          deleted: [] as PackageVersion[],
        };
      }
      const deleted: PackageVersion[] = [];
      for (const current of activeRows) {
        const updatedRows = await transaction<PackageVersionRow[]>`
          UPDATE package_versions
          SET
            state = 'DELETED',
            deleted_at = clock_timestamp(),
            deletion_reason = ${reason},
            updated_at = clock_timestamp()
          WHERE id = ${current.id}
          RETURNING *
        `;
        const updated = updatedRows[0];
        if (!updated) {
          throw new Error('PostgreSQL did not return a deleted package version');
        }
        const event = {
          type: 'catalog.version.deleted',
          payload: { reason },
        };
        await transaction`
          INSERT INTO catalog_outbox (id, aggregate_id, event_type, payload)
          VALUES (
            ${randomUUID()},
            ${updated.id},
            ${event.type},
            ${transaction.json(eventPayload(event, updated, current.state, 'DELETED'))}
          )
        `;
        deleted.push(toPackageVersion(updated));
      }
      return { blocked: null, deleted };
    });
    if (result.blocked) {
      throw new IllegalCatalogTransitionError(result.blocked.id, result.blocked.state, 'DELETED');
    }
    return result.deleted;
  }
}

export async function withCatalogHeartbeat<T>(input: {
  catalog: Catalog;
  heartbeatIntervalMs?: number;
  onHeartbeatError?: (error: unknown) => Promise<void> | void;
  operation: (signal: AbortSignal) => Promise<T>;
  state: LiveCatalogState;
  versionId: string;
}): Promise<T> {
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? CATALOG_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new RangeError('heartbeatIntervalMs must be a positive safe integer');
  }
  if (!(await input.catalog.heartbeatVersion(input.versionId, input.state))) {
    throw new CatalogInvariantError(
      `Package version ${input.versionId} is not in ${input.state} for live work`
    );
  }

  const abortController = new AbortController();
  let stopped = false;
  let pendingHeartbeat = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (reason?: unknown): void => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
    }
    if (reason !== undefined && !abortController.signal.aborted) {
      abortController.abort(reason);
    }
  };
  const heartbeat = (): void => {
    pendingHeartbeat = pendingHeartbeat.then(async () => {
      if (stopped) {
        return;
      }
      try {
        const renewed = await input.catalog.heartbeatVersion(input.versionId, input.state);
        if (!renewed) {
          stop(new CatalogOwnershipLostError(input.versionId, input.state));
        }
      } catch (error) {
        stop(new CatalogOwnershipLostError(input.versionId, input.state, { cause: error }));
        try {
          await input.onHeartbeatError?.(error);
        } catch {
          // Observability must not turn a live operation into an unhandled rejection.
        }
      }
    });
  };

  timer = setInterval(heartbeat, heartbeatIntervalMs);
  try {
    return await input.operation(abortController.signal);
  } finally {
    stop();
    await pendingHeartbeat;
  }
}
