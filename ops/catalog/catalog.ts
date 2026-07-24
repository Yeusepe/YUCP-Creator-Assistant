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

export interface ProtectedPackageFile extends JsonObject {
  materializerType: string;
  normalizedPath: string;
  required: boolean;
  sourceSha256: string;
}

export interface PackageVersion {
  activeContentDigest: string | null;
  activePolicyVersion: string | null;
  bindingRoot: string | null;
  catalogProductId: string | null;
  commonRoot: string | null;
  id: string;
  logicalBytes: number | null;
  logicalFiles: number | null;
  manifestSha256: string | null;
  packageId: string;
  protectedFiles: ProtectedPackageFile[] | null;
  protectedSourceRoot: string | null;
  protectionPolicyDigest: string | null;
  protectionPolicyId: string | null;
  version: string;
  sourceFormat: string | null;
  releaseRoot: string | null;
  assemblyObjectId: string | null;
  state: CatalogState;
  error: string | null;
  deletedAt: Date | null;
  deletionReason: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PackageQuarantineObject {
  bytes: number;
  contentType: string;
  createdAt: Date;
  fileIdentifier: string | null;
  objectKey: string;
  providerVersion: string | null;
  sha256: string;
  state: 'COMMITTED' | 'PENDING' | 'UNCERTAIN';
  updatedAt: Date;
  versionId: string;
}

interface PackageQuarantineObjectRow {
  bytes: number | string;
  content_type: string;
  created_at: Date;
  file_identifier: string | null;
  object_key: string;
  provider_version: string | null;
  sha256: string;
  state: PackageQuarantineObject['state'];
  updated_at: Date;
  version_id: string;
}

interface PackageVersionRow {
  active_content_digest: string | null;
  active_policy_version: string | null;
  binding_root: string | null;
  catalog_product_id: string | null;
  common_root: string | null;
  id: string;
  logical_bytes: number | null;
  logical_files: number | null;
  manifest_sha256: string | null;
  package_id: string;
  protected_files: ProtectedPackageFile[] | null;
  protected_source_root: string | null;
  protection_policy_digest: string | null;
  protection_policy_id: string | null;
  version: string;
  source_format: string | null;
  release_root: string | null;
  assembly_object_id: string | null;
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
  activeContentDigest?: string;
  activePolicyVersion?: string;
  sourceFormat?: string;
  releaseRoot?: string;
  assemblyObjectId?: string;
  bindingRoot?: string;
  commonRoot?: string;
  error?: string;
  deletionReason?: string;
  logicalBytes?: number;
  logicalFiles?: number;
  manifestSha256?: string;
  protectedFiles?: ProtectedPackageFile[];
  protectedSourceRoot?: string;
  protectionPolicyDigest?: string;
  protectionPolicyId?: string;
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
    activeContentDigest: row.active_content_digest,
    activePolicyVersion: row.active_policy_version,
    bindingRoot: row.binding_root,
    catalogProductId: row.catalog_product_id,
    commonRoot: row.common_root,
    id: row.id,
    logicalBytes: row.logical_bytes,
    logicalFiles: row.logical_files,
    manifestSha256: row.manifest_sha256,
    packageId: row.package_id,
    protectedFiles: row.protected_files,
    protectedSourceRoot: row.protected_source_root,
    protectionPolicyDigest: row.protection_policy_digest,
    protectionPolicyId: row.protection_policy_id,
    version: row.version,
    sourceFormat: row.source_format,
    releaseRoot: row.release_root,
    assemblyObjectId: row.assembly_object_id,
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

function toPackageQuarantineObject(row: PackageQuarantineObjectRow): PackageQuarantineObject {
  const bytes = Number(row.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new CatalogInvariantError('Quarantine object contains an invalid byte length');
  }
  return {
    bytes,
    contentType: row.content_type,
    createdAt: row.created_at,
    fileIdentifier: row.file_identifier,
    objectKey: row.object_key,
    providerVersion: row.provider_version,
    sha256: row.sha256,
    state: row.state,
    updatedAt: row.updated_at,
    versionId: row.version_id,
  };
}

function validateTransitionFields(
  current: PackageVersionRow,
  targetState: CatalogState,
  fields: TransitionFields
): {
  sourceFormat: string | null;
  releaseRoot: string | null;
  assemblyObjectId: string | null;
  activeContentDigest: string | null;
  activePolicyVersion: string | null;
  bindingRoot: string | null;
  commonRoot: string | null;
  error: string | null;
  deletionReason: string | null;
  logicalBytes: number | null;
  logicalFiles: number | null;
  manifestSha256: string | null;
  protectedFiles: ProtectedPackageFile[] | null;
  protectedSourceRoot: string | null;
  protectionPolicyDigest: string | null;
  protectionPolicyId: string | null;
} {
  const sourceFormat = fields.sourceFormat ?? current.source_format;
  const releaseRoot = fields.releaseRoot ?? current.release_root;
  const assemblyObjectId = fields.assemblyObjectId ?? current.assembly_object_id;
  const deletionReason = fields.deletionReason?.trim() ?? current.deletion_reason;
  const activeContentDigest = fields.activeContentDigest ?? current.active_content_digest;
  const activePolicyVersion = fields.activePolicyVersion?.trim() ?? current.active_policy_version;
  const bindingRoot = fields.bindingRoot ?? current.binding_root;
  const commonRoot = fields.commonRoot ?? current.common_root;
  const logicalBytes = fields.logicalBytes ?? current.logical_bytes;
  const logicalFiles = fields.logicalFiles ?? current.logical_files;
  const manifestSha256 = fields.manifestSha256 ?? current.manifest_sha256;
  const protectedFiles = fields.protectedFiles ?? current.protected_files;
  const protectedSourceRoot = fields.protectedSourceRoot ?? current.protected_source_root;
  const protectionPolicyDigest = fields.protectionPolicyDigest ?? current.protection_policy_digest;
  const protectionPolicyId = fields.protectionPolicyId?.trim() ?? current.protection_policy_id;

  if ((releaseRoot === null) !== (assemblyObjectId === null)) {
    throw new CatalogInvariantError(
      'releaseRoot and assemblyObjectId must either both be present or both be absent'
    );
  }
  if (
    (targetState === 'ASSEMBLED' || targetState === 'PROMOTING' || targetState === 'READY') &&
    (sourceFormat === null || releaseRoot === null || assemblyObjectId === null)
  ) {
    throw new CatalogInvariantError(
      `${targetState} requires sourceFormat, releaseRoot, and assemblyObjectId`
    );
  }
  if (
    targetState === 'READY' &&
    (!activeContentDigest ||
      !activePolicyVersion ||
      !bindingRoot ||
      !commonRoot ||
      logicalBytes === null ||
      logicalFiles === null ||
      !manifestSha256 ||
      protectedFiles === null ||
      !protectedSourceRoot ||
      !protectionPolicyDigest ||
      !protectionPolicyId)
  ) {
    throw new CatalogInvariantError('READY requires complete logical release v4 publication data');
  }

  if (targetState === 'FAILED') {
    if (!fields.error?.trim()) {
      throw new CatalogInvariantError('FAILED requires a non-empty error');
    }
    return {
      activeContentDigest,
      activePolicyVersion,
      bindingRoot,
      commonRoot,
      sourceFormat,
      releaseRoot,
      assemblyObjectId,
      error: fields.error,
      deletionReason: null,
      logicalBytes,
      logicalFiles,
      manifestSha256,
      protectedFiles,
      protectedSourceRoot,
      protectionPolicyDigest,
      protectionPolicyId,
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
    activeContentDigest,
    activePolicyVersion,
    bindingRoot,
    commonRoot,
    sourceFormat,
    releaseRoot,
    assemblyObjectId,
    error: null,
    deletionReason: targetState === 'DELETED' ? deletionReason : null,
    logicalBytes,
    logicalFiles,
    manifestSha256,
    protectedFiles,
    protectedSourceRoot,
    protectionPolicyDigest,
    protectionPolicyId,
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

  async beginQuarantineObject(input: {
    bytes: number;
    contentType: string;
    objectKey: string;
    sha256: string;
    versionId: string;
  }): Promise<PackageQuarantineObject> {
    const inserted = await this.sql<PackageQuarantineObjectRow[]>`
      INSERT INTO package_quarantine_objects (
        version_id,
        object_key,
        sha256,
        bytes,
        content_type,
        state
      )
      SELECT
        id,
        ${input.objectKey},
        ${input.sha256},
        ${input.bytes},
        ${input.contentType},
        'PENDING'
      FROM package_versions
      WHERE id = ${input.versionId}
        AND state = 'UPLOADING'
      ON CONFLICT (version_id) DO NOTHING
      RETURNING *
    `;
    const row = inserted[0]
      ? toPackageQuarantineObject(inserted[0])
      : await this.getQuarantineObject(input.versionId);
    if (!row) {
      const version = await this.getVersion(input.versionId);
      if (!version) {
        throw new PackageVersionNotFoundError(input.versionId);
      }
      throw new CatalogInvariantError(
        'Quarantine write intent requires an uploading package version'
      );
    }
    if (
      row.objectKey !== input.objectKey ||
      row.sha256 !== input.sha256 ||
      row.bytes !== input.bytes ||
      row.contentType !== input.contentType
    ) {
      throw new CatalogInvariantError('Quarantine write intent does not match the accepted upload');
    }
    return row;
  }

  async commitQuarantineObject(input: {
    fileIdentifier: string;
    providerVersion: string;
    versionId: string;
  }): Promise<PackageQuarantineObject> {
    const updated = await this.sql<PackageQuarantineObjectRow[]>`
      UPDATE package_quarantine_objects
      SET
        state = 'COMMITTED',
        provider_version = ${input.providerVersion},
        file_identifier = ${input.fileIdentifier},
        updated_at = clock_timestamp()
      WHERE version_id = ${input.versionId}
        AND state IN ('PENDING', 'UNCERTAIN')
      RETURNING *
    `;
    if (updated[0]) {
      return toPackageQuarantineObject(updated[0]);
    }
    const current = await this.getQuarantineObject(input.versionId);
    if (!current) {
      throw new CatalogInvariantError('Quarantine write intent was not found');
    }
    if (
      current.state !== 'COMMITTED' ||
      current.providerVersion !== input.providerVersion ||
      current.fileIdentifier !== input.fileIdentifier
    ) {
      throw new CatalogInvariantError('Quarantine object exact version is immutable');
    }
    return current;
  }

  async markQuarantineObjectUncertain(versionId: string): Promise<PackageQuarantineObject> {
    const rows = await this.sql<PackageQuarantineObjectRow[]>`
      UPDATE package_quarantine_objects
      SET state = 'UNCERTAIN', updated_at = clock_timestamp()
      WHERE version_id = ${versionId}
        AND state IN ('PENDING', 'UNCERTAIN')
      RETURNING *
    `;
    const row = rows[0];
    if (!row) {
      throw new CatalogInvariantError('Quarantine write intent cannot become uncertain');
    }
    return toPackageQuarantineObject(row);
  }

  async getQuarantineObject(versionId: string): Promise<PackageQuarantineObject | null> {
    const rows = await this.sql<PackageQuarantineObjectRow[]>`
      SELECT *
      FROM package_quarantine_objects
      WHERE version_id = ${versionId}
    `;
    return rows[0] ? toPackageQuarantineObject(rows[0]) : null;
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
          source_format = ${fields.sourceFormat},
          release_root = ${fields.releaseRoot},
          assembly_object_id = ${fields.assemblyObjectId},
          active_content_digest = ${fields.activeContentDigest},
          active_policy_version = ${fields.activePolicyVersion},
          binding_root = ${fields.bindingRoot},
          common_root = ${fields.commonRoot},
          logical_bytes = ${fields.logicalBytes},
          logical_files = ${fields.logicalFiles},
          manifest_sha256 = ${fields.manifestSha256},
          protected_files = ${
            fields.protectedFiles === null ? null : transaction.json(fields.protectedFiles)
          },
          protected_source_root = ${fields.protectedSourceRoot},
          protection_policy_digest = ${fields.protectionPolicyDigest},
          protection_policy_id = ${fields.protectionPolicyId},
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
