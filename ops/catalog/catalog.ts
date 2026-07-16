import { randomUUID } from 'node:crypto';
import type { CatalogDatabase } from './database';

export const CATALOG_STATES = [
  'CREATED',
  'UPLOADING',
  'ASSEMBLED',
  'PROMOTING',
  'READY',
  'FAILED',
] as const;

export type CatalogState = (typeof CATALOG_STATES)[number];

const allowedTransitions = {
  CREATED: ['UPLOADING', 'FAILED'],
  UPLOADING: ['ASSEMBLED', 'FAILED'],
  ASSEMBLED: ['PROMOTING', 'FAILED'],
  PROMOTING: ['READY', 'FAILED'],
  READY: [],
  FAILED: ['UPLOADING'],
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
  id: string;
  packageId: string;
  version: string;
  formatTag: string | null;
  canonicalSha256: string | null;
  casIndexId: string | null;
  state: CatalogState;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PackageVersionRow {
  id: string;
  package_id: string;
  version: string;
  format_tag: string | null;
  canonical_sha256: string | null;
  cas_index_id: string | null;
  state: CatalogState;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateVersionInput {
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

function toPackageVersion(row: PackageVersionRow): PackageVersion {
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

function validateTransitionFields(
  current: PackageVersionRow,
  targetState: CatalogState,
  fields: TransitionFields
): {
  formatTag: string | null;
  canonicalSha256: string | null;
  casIndexId: string | null;
  error: string | null;
} {
  const formatTag = fields.formatTag ?? current.format_tag;
  const canonicalSha256 = fields.canonicalSha256 ?? current.canonical_sha256;
  const casIndexId = fields.casIndexId ?? current.cas_index_id;

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
    return { formatTag, canonicalSha256, casIndexId, error: fields.error };
  }
  if (fields.error !== undefined) {
    throw new CatalogInvariantError('error can only be set when transitioning to FAILED');
  }

  return { formatTag, canonicalSha256, casIndexId, error: null };
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
    previousState,
    state,
  };
}

export class Catalog {
  constructor(private readonly sql: CatalogDatabase) {}

  async createVersion(input: CreateVersionInput): Promise<PackageVersion> {
    const id = input.id ?? randomUUID();
    const event = input.event ?? { type: 'catalog.version.created' };

    return this.sql.begin(async (transaction) => {
      const rows = await transaction<PackageVersionRow[]>`
        INSERT INTO package_versions (id, package_id, version, state)
        VALUES (${id}, ${input.packageId}, ${input.version}, 'CREATED')
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
      const updatedRows = await transaction<PackageVersionRow[]>`
        UPDATE package_versions
        SET
          state = ${targetState},
          format_tag = ${fields.formatTag},
          canonical_sha256 = ${fields.canonicalSha256},
          cas_index_id = ${fields.casIndexId},
          error = ${fields.error},
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
    targetState: Exclude<CatalogState, 'CREATED' | 'FAILED'>,
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
}
