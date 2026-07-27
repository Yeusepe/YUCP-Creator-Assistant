import { randomUUID } from 'node:crypto';
import type { StorageRole } from '../storage-core/exactStorage';
import type { CatalogDatabase } from './database';

export type StorageGcPinKind =
  | 'active-grant'
  | 'delivery-binding'
  | 'explicit'
  | 'legal-hold'
  | 'materialization-job'
  | 'promotion-job'
  | 'rendition-job'
  | 'rollback';

export type StorageGcGeneration = {
  completedAt: Date;
  id: number;
  previousCompletedGenerationId: number | null;
  startedAt: Date;
};

export type StorageGcReleasePin = {
  expiresAt: Date | null;
  id: string;
  ownerId: string;
  packageVersionId: string;
  pinKind: StorageGcPinKind;
  releasedAt: Date | null;
};

export type StorageGcDeletion = {
  bucketName: string;
  bytes: number;
  generationId: number;
  journalId: string;
  objectKey: string;
  objectVersionId: string;
  providerVersion: string;
  storageRole: Extract<StorageRole, 'common' | 'metadata' | 'protected'>;
};

type GenerationRow = {
  completed_at: Date;
  id: number | string;
  previous_completed_generation_id: number | string | null;
  started_at: Date;
};

type PinRow = {
  expires_at: Date | null;
  id: string;
  owner_id: string;
  package_version_id: string;
  pin_kind: StorageGcPinKind;
  released_at: Date | null;
};

type DeletionRow = {
  bucket_name: string;
  bytes: number | string;
  generation_id: number | string;
  journal_id: string;
  object_key: string;
  object_version_id: string;
  provider_version: string;
  storage_role: StorageGcDeletion['storageRole'];
};

const MAX_ERROR_BYTES = 4096;

function toSafeInteger(value: number | string, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} is outside the safe integer range`);
  }
  return result;
}

function toGeneration(row: GenerationRow): StorageGcGeneration {
  return {
    completedAt: row.completed_at,
    id: toSafeInteger(row.id, 'Storage GC generation'),
    previousCompletedGenerationId:
      row.previous_completed_generation_id === null
        ? null
        : toSafeInteger(row.previous_completed_generation_id, 'Previous storage GC generation'),
    startedAt: row.started_at,
  };
}

function toPin(row: PinRow): StorageGcReleasePin {
  return {
    expiresAt: row.expires_at,
    id: row.id,
    ownerId: row.owner_id,
    packageVersionId: row.package_version_id,
    pinKind: row.pin_kind,
    releasedAt: row.released_at,
  };
}

function toDeletion(row: DeletionRow): StorageGcDeletion {
  return {
    bucketName: row.bucket_name,
    bytes: toSafeInteger(row.bytes, 'Storage GC object bytes'),
    generationId: toSafeInteger(row.generation_id, 'Storage GC deletion generation'),
    journalId: row.journal_id,
    objectKey: row.object_key,
    objectVersionId: row.object_version_id,
    providerVersion: row.provider_version,
    storageRole: row.storage_role,
  };
}

function requiredText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function boundedError(error: string): string {
  const normalized = error.trim() || 'Unknown exact-version deletion failure';
  const bytes = Buffer.from(normalized, 'utf8');
  return bytes.byteLength <= MAX_ERROR_BYTES
    ? normalized
    : bytes.subarray(0, MAX_ERROR_BYTES).toString('utf8');
}

export class StorageGcCatalog {
  constructor(private readonly sql: CatalogDatabase) {}

  async createReleasePin(input: {
    expiresAt?: Date;
    ownerId: string;
    packageVersionId: string;
    pinKind: StorageGcPinKind;
  }): Promise<StorageGcReleasePin> {
    const ownerId = requiredText(input.ownerId, 'Storage GC pin owner', 512);
    if (
      input.expiresAt &&
      (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now())
    ) {
      throw new Error('Storage GC pin expiry must be in the future');
    }
    const requestedPinId = randomUUID();
    const acquiredRows = await this.sql<{ pin_id: string }[]>`
      SELECT storage_gc_acquire_release_pin(
        ${requestedPinId},
        ${input.packageVersionId},
        ${input.pinKind},
        ${ownerId},
        ${input.expiresAt ?? null}
      ) AS pin_id
    `;
    const pinId = acquiredRows[0]?.pin_id;
    if (!pinId) {
      throw new Error('PostgreSQL did not return the storage GC pin');
    }
    const rows = await this.sql<PinRow[]>`
      SELECT *
      FROM storage_gc_release_pins
      WHERE id = ${pinId}
    `;
    const pin = rows[0];
    if (!pin) {
      throw new Error('PostgreSQL did not return the storage GC pin');
    }
    return toPin(pin);
  }

  async releaseReleasePin(pinId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const rows = await transaction<{ id: string; released_at: Date | null }[]>`
        SELECT id, released_at
        FROM storage_gc_release_pins
        WHERE id = ${pinId}
        FOR UPDATE
      `;
      const pin = rows[0];
      if (!pin) {
        throw new Error('Storage GC release pin was not found');
      }
      if (pin.released_at) {
        return;
      }
      await transaction`
        UPDATE storage_gc_release_pins
        SET released_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${pinId}
      `;
    });
  }

  async observeGeneration(now: Date = new Date()): Promise<{
    candidatesObserved: number;
    generation: StorageGcGeneration;
  }> {
    if (!Number.isFinite(now.getTime())) {
      throw new Error('Storage GC generation time is invalid');
    }
    return this.sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(
          hashtextextended('yucp-exact-storage-garbage-collection', 0)
        )
      `;
      const previousRows = await transaction<{ id: number | string }[]>`
        SELECT id
        FROM storage_gc_generations
        WHERE state = 'COMPLETED'
        ORDER BY id DESC
        LIMIT 1
      `;
      const openRows = await transaction<{ id: number | string }[]>`
        INSERT INTO storage_gc_generations (
          previous_completed_generation_id,
          state,
          started_at
        )
        VALUES (
          ${previousRows[0]?.id ?? null},
          'OPEN',
          ${now}
        )
        RETURNING id
      `;
      const generationId = openRows[0]?.id;
      if (generationId === undefined) {
        throw new Error('PostgreSQL did not return the storage GC generation');
      }
      const observed = await transaction<{ object_version_id: string }[]>`
        INSERT INTO storage_gc_candidates (
          object_version_id,
          first_generation_id,
          last_generation_id,
          consecutive_generations,
          state,
          first_observed_at,
          last_observed_at
        )
        SELECT
          object.id,
          ${generationId},
          ${generationId},
          1,
          'OBSERVED',
          ${now},
          ${now}
        FROM storage_object_versions object
        WHERE object.verification_state = 'VERIFIED'
          AND object.storage_role IN ('common', 'metadata', 'protected')
          AND object.created_at < ${now}
          AND NOT EXISTS (
            SELECT 1
            FROM package_release_storage_objects release_object
            JOIN package_versions package_version
              ON package_version.id = release_object.package_version_id
            WHERE release_object.object_version_id = object.id
              AND (
                package_version.state <> 'DELETED'
                OR EXISTS (
                  SELECT 1
                  FROM storage_gc_release_pins pin
                  WHERE pin.package_version_id = package_version.id
                    AND pin.released_at IS NULL
                    AND (pin.expires_at IS NULL OR pin.expires_at > ${now})
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM storage_write_intents intent
            LEFT JOIN package_versions owner_version
              ON intent.owner_kind = 'package-version'
              AND owner_version.id::text = intent.owner_id
            WHERE (
                intent.object_version_id = object.id
                OR intent.candidate_object_version_id = object.id
              )
              AND (
                intent.state IN ('ISSUED', 'UNCERTAIN')
                OR (
                  intent.state = 'COMMITTED'
                  AND (
                    intent.owner_kind = 'vpm-alias-publication'
                    OR (
                      intent.owner_kind = 'package-version'
                      AND owner_version.state <> 'DELETED'
                    )
                  )
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM tuf_publication_objects publication_object
            JOIN tuf_publications publication
              ON publication.id = publication_object.publication_id
            WHERE publication_object.object_version_id = object.id
              AND publication.state IN ('RESERVED', 'PUBLISHING', 'PUBLISHED')
          )
        ON CONFLICT (object_version_id)
        DO UPDATE SET
          first_generation_id = CASE
            WHEN storage_gc_candidates.last_generation_id = ${previousRows[0]?.id ?? null}
              THEN storage_gc_candidates.first_generation_id
            ELSE EXCLUDED.first_generation_id
          END,
          last_generation_id = EXCLUDED.last_generation_id,
          consecutive_generations = CASE
            WHEN storage_gc_candidates.last_generation_id = ${previousRows[0]?.id ?? null}
              THEN storage_gc_candidates.consecutive_generations + 1
            ELSE 1
          END,
          state = 'OBSERVED',
          last_error = NULL,
          retention_until = NULL,
          last_observed_at = EXCLUDED.last_observed_at,
          updated_at = clock_timestamp(),
          deleted_at = NULL
        WHERE storage_gc_candidates.state NOT IN ('DELETED', 'DELETING')
        RETURNING object_version_id
      `;
      const completedRows = await transaction<GenerationRow[]>`
        UPDATE storage_gc_generations
        SET state = 'COMPLETED', completed_at = ${now}
        WHERE id = ${generationId} AND state = 'OPEN'
        RETURNING *
      `;
      const completed = completedRows[0];
      if (!completed) {
        throw new Error('Storage GC generation did not complete');
      }
      return {
        candidatesObserved: observed.length,
        generation: toGeneration(completed),
      };
    });
  }

  async listPendingDeletions(limit: number): Promise<StorageGcDeletion[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Storage GC pending deletion limit is invalid');
    }
    const rows = await this.sql<DeletionRow[]>`
      SELECT
        journal.id AS journal_id,
        journal.generation_id,
        object.id AS object_version_id,
        object.storage_role,
        object.bucket_name,
        object.object_key,
        object.provider_version,
        object.bytes
      FROM storage_gc_deletion_journal journal
      JOIN storage_gc_candidates candidate
        ON candidate.object_version_id = journal.object_version_id
      JOIN storage_object_versions object
        ON object.id = journal.object_version_id
      WHERE journal.state = 'STARTED'
        AND candidate.state = 'DELETING'
        AND object.verification_state = 'VERIFIED'
      ORDER BY journal.started_at, journal.id
      LIMIT ${limit}
    `;
    return rows.map(toDeletion);
  }

  async revalidatePendingDeletion(input: {
    journalId: string;
    now?: Date;
    objectVersionId: string;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const reachabilityError =
      'Storage GC deletion was cancelled because the object became reachable';
    return this.sql.begin(async (transaction) => {
      const pending = await transaction<{ deletion_allowed: boolean }[]>`
        SELECT (
          NOT EXISTS (
            SELECT 1
            FROM package_release_storage_objects release_object
            JOIN package_versions package_version
              ON package_version.id = release_object.package_version_id
            WHERE release_object.object_version_id = object.id
              AND (
                package_version.state <> 'DELETED'
                OR EXISTS (
                  SELECT 1
                  FROM storage_gc_release_pins pin
                  WHERE pin.package_version_id = package_version.id
                    AND pin.released_at IS NULL
                    AND (pin.expires_at IS NULL OR pin.expires_at > ${now})
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM storage_write_intents intent
            LEFT JOIN package_versions owner_version
              ON intent.owner_kind = 'package-version'
              AND owner_version.id::text = intent.owner_id
            WHERE (
                intent.object_version_id = object.id
                OR intent.candidate_object_version_id = object.id
              )
              AND (
                intent.state IN ('ISSUED', 'UNCERTAIN')
                OR (
                  intent.state = 'COMMITTED'
                  AND (
                    intent.owner_kind = 'vpm-alias-publication'
                    OR (
                      intent.owner_kind = 'package-version'
                      AND owner_version.state <> 'DELETED'
                    )
                  )
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM tuf_publication_objects publication_object
            JOIN tuf_publications publication
              ON publication.id = publication_object.publication_id
            WHERE publication_object.object_version_id = object.id
              AND publication.state IN ('RESERVED', 'PUBLISHING', 'PUBLISHED')
          )
        ) AS deletion_allowed
        FROM storage_gc_deletion_journal journal
        JOIN storage_gc_candidates candidate
          ON candidate.object_version_id = journal.object_version_id
        JOIN storage_object_versions object
          ON object.id = journal.object_version_id
        WHERE journal.id = ${input.journalId}
          AND journal.object_version_id = ${input.objectVersionId}
          AND journal.state = 'STARTED'
          AND candidate.state = 'DELETING'
          AND object.verification_state = 'VERIFIED'
        FOR UPDATE OF journal, candidate, object
      `;
      const deletionAllowed = pending[0]?.deletion_allowed;
      if (deletionAllowed === undefined) {
        throw new Error('Storage GC pending deletion fence is invalid');
      }
      if (deletionAllowed) {
        return true;
      }
      const candidates = await transaction<{ object_version_id: string }[]>`
        UPDATE storage_gc_candidates
        SET
          state = 'FAILED',
          last_error = ${reachabilityError},
          retention_until = NULL,
          updated_at = clock_timestamp()
        WHERE object_version_id = ${input.objectVersionId}
          AND state = 'DELETING'
        RETURNING object_version_id
      `;
      const journals = await transaction<{ id: string }[]>`
        UPDATE storage_gc_deletion_journal
        SET
          state = 'FAILED',
          error = ${reachabilityError},
          completed_at = clock_timestamp()
        WHERE id = ${input.journalId}
          AND object_version_id = ${input.objectVersionId}
          AND state = 'STARTED'
        RETURNING id
      `;
      if (candidates.length !== 1 || journals.length !== 1) {
        throw new Error('Storage GC reachability cancellation did not finalize');
      }
      return false;
    });
  }

  async claimDeletionCandidate(input: {
    generationId: number;
    now?: Date;
  }): Promise<StorageGcDeletion | null> {
    const now = input.now ?? new Date();
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<Omit<DeletionRow, 'journal_id'>[]>`
        SELECT
          candidate.object_version_id,
          candidate.last_generation_id AS generation_id,
          object.storage_role,
          object.bucket_name,
          object.object_key,
          object.provider_version,
          object.bytes
        FROM storage_gc_candidates candidate
        JOIN storage_gc_generations generation
          ON generation.id = candidate.last_generation_id
        JOIN LATERAL (
          SELECT
            object.storage_role,
            object.bucket_name,
            object.object_key,
            object.provider_version,
            object.bytes
          FROM storage_object_versions object
          WHERE object.id = candidate.object_version_id
            AND object.verification_state = 'VERIFIED'
            AND NOT EXISTS (
              SELECT 1
              FROM package_release_storage_objects release_object
              JOIN package_versions package_version
                ON package_version.id = release_object.package_version_id
              WHERE release_object.object_version_id = object.id
                AND (
                  package_version.state <> 'DELETED'
                  OR EXISTS (
                    SELECT 1
                    FROM storage_gc_release_pins pin
                    WHERE pin.package_version_id = package_version.id
                      AND pin.released_at IS NULL
                      AND (pin.expires_at IS NULL OR pin.expires_at > ${now})
                  )
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM storage_write_intents intent
              LEFT JOIN package_versions owner_version
                ON intent.owner_kind = 'package-version'
                AND owner_version.id::text = intent.owner_id
              WHERE (
                  intent.object_version_id = object.id
                  OR intent.candidate_object_version_id = object.id
                )
                AND (
                  intent.state IN ('ISSUED', 'UNCERTAIN')
                  OR (
                    intent.state = 'COMMITTED'
                    AND (
                      intent.owner_kind = 'vpm-alias-publication'
                      OR (
                        intent.owner_kind = 'package-version'
                        AND owner_version.state <> 'DELETED'
                      )
                    )
                  )
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM tuf_publication_objects publication_object
              JOIN tuf_publications publication
                ON publication.id = publication_object.publication_id
              WHERE publication_object.object_version_id = object.id
                AND publication.state IN ('RESERVED', 'PUBLISHING', 'PUBLISHED')
            )
          FOR UPDATE OF object SKIP LOCKED
        ) object ON true
        WHERE candidate.last_generation_id = ${input.generationId}
          AND candidate.consecutive_generations >= 2
          AND candidate.state IN ('FAILED', 'OBSERVED', 'RETENTION_BLOCKED')
          AND (
            candidate.retention_until IS NULL
            OR candidate.retention_until <= ${now}
          )
          AND generation.state = 'COMPLETED'
        ORDER BY candidate.last_observed_at, candidate.object_version_id
        FOR UPDATE OF candidate SKIP LOCKED
        LIMIT 1
      `;
      const candidate = rows[0];
      if (!candidate) {
        return null;
      }
      const journalId = randomUUID();
      const updated = await transaction<{ object_version_id: string }[]>`
        UPDATE storage_gc_candidates
        SET
          state = 'DELETING',
          last_error = NULL,
          retention_until = NULL,
          updated_at = clock_timestamp()
        WHERE object_version_id = ${candidate.object_version_id}
          AND state IN ('FAILED', 'OBSERVED', 'RETENTION_BLOCKED')
        RETURNING object_version_id
      `;
      if (updated.length !== 1) {
        throw new Error('Storage GC candidate lost deletion ownership');
      }
      await transaction`
        INSERT INTO storage_gc_deletion_journal (
          id,
          generation_id,
          object_version_id,
          storage_role,
          bucket_name,
          object_key,
          provider_version,
          state
        )
        VALUES (
          ${journalId},
          ${candidate.generation_id},
          ${candidate.object_version_id},
          ${candidate.storage_role},
          ${candidate.bucket_name},
          ${candidate.object_key},
          ${candidate.provider_version},
          'STARTED'
        )
      `;
      return toDeletion({ ...candidate, journal_id: journalId });
    });
  }

  async completeDeletion(input: { journalId: string; objectVersionId: string }): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const objects = await transaction<{ id: string }[]>`
        UPDATE storage_object_versions
        SET
          verification_state = 'DELETED',
          deleted_at = clock_timestamp()
        WHERE id = ${input.objectVersionId}
          AND verification_state = 'VERIFIED'
        RETURNING id
      `;
      if (objects.length !== 1) {
        throw new Error('Storage GC exact object did not finalize deletion');
      }
      await transaction`
        DELETE FROM canonical_storage_objects
        WHERE object_version_id = ${input.objectVersionId}
      `;
      const candidates = await transaction<{ object_version_id: string }[]>`
        UPDATE storage_gc_candidates
        SET
          state = 'DELETED',
          last_error = NULL,
          retention_until = NULL,
          deleted_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE object_version_id = ${input.objectVersionId}
          AND state = 'DELETING'
        RETURNING object_version_id
      `;
      const journals = await transaction<{ id: string }[]>`
        UPDATE storage_gc_deletion_journal
        SET state = 'DELETED', completed_at = clock_timestamp()
        WHERE id = ${input.journalId}
          AND object_version_id = ${input.objectVersionId}
          AND state = 'STARTED'
        RETURNING id
      `;
      if (candidates.length !== 1 || journals.length !== 1) {
        throw new Error('Storage GC deletion journal did not finalize');
      }
    });
  }

  async blockDeletionForRetention(input: {
    journalId: string;
    objectVersionId: string;
    retainUntil: Date;
  }): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const candidates = await transaction<{ object_version_id: string }[]>`
        UPDATE storage_gc_candidates
        SET
          state = 'RETENTION_BLOCKED',
          retention_until = ${input.retainUntil},
          last_error = NULL,
          updated_at = clock_timestamp()
        WHERE object_version_id = ${input.objectVersionId}
          AND state = 'DELETING'
        RETURNING object_version_id
      `;
      const journals = await transaction<{ id: string }[]>`
        UPDATE storage_gc_deletion_journal
        SET
          state = 'RETENTION_BLOCKED',
          retention_until = ${input.retainUntil},
          completed_at = clock_timestamp()
        WHERE id = ${input.journalId}
          AND object_version_id = ${input.objectVersionId}
          AND state = 'STARTED'
        RETURNING id
      `;
      if (candidates.length !== 1 || journals.length !== 1) {
        throw new Error('Storage GC retention result did not finalize');
      }
    });
  }

  async failDeletion(input: {
    error: string;
    journalId: string;
    objectVersionId: string;
  }): Promise<void> {
    const error = boundedError(input.error);
    await this.sql.begin(async (transaction) => {
      const candidates = await transaction<{ object_version_id: string }[]>`
        UPDATE storage_gc_candidates
        SET
          state = 'FAILED',
          last_error = ${error},
          retention_until = NULL,
          updated_at = clock_timestamp()
        WHERE object_version_id = ${input.objectVersionId}
          AND state = 'DELETING'
        RETURNING object_version_id
      `;
      const journals = await transaction<{ id: string }[]>`
        UPDATE storage_gc_deletion_journal
        SET
          state = 'FAILED',
          error = ${error},
          completed_at = clock_timestamp()
        WHERE id = ${input.journalId}
          AND object_version_id = ${input.objectVersionId}
          AND state = 'STARTED'
        RETURNING id
      `;
      if (candidates.length !== 1 || journals.length !== 1) {
        throw new Error('Storage GC deletion failure did not finalize');
      }
    });
  }
}
