import { randomUUID } from 'node:crypto';
import type { TufPublicationCatalogPort } from '../storage-core/tufRepositoryPublication';
import type { CatalogDatabase } from './database';
import type { StorageObjectVersion } from './exactStorageCatalog';

const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const TIMESTAMP_PATH = 'metadata/timestamp.json';

type PublicationRow = {
  expected_paths: string[];
  id: string;
  metadata_version: number | string;
  repository_id: string;
  root_version: number | string;
  snapshot_expires_at: Date | string;
  state: 'FAILED' | 'PUBLISHED' | 'PUBLISHING' | 'RESERVED';
  targets_expires_at: Date | string;
  timestamp_expires_at: Date | string;
};

type StorageObjectVersionRow = {
  bucket_name: string;
  bytes: number | string;
  content_type: string;
  file_identifier: string;
  id: string;
  object_key: string;
  provider_version: string;
  sha256: Buffer;
  storage_role: StorageObjectVersion['storageRole'];
  verification_state: StorageObjectVersion['verificationState'];
  verified_at: Date | null;
};

export type TufReservedPublication = {
  expectedPaths: string[];
  id: string;
  metadataVersion: number;
  repositoryId: string;
  rootVersion: number;
  snapshotExpiresAt: Date;
  state: 'PUBLISHED' | 'PUBLISHING' | 'RESERVED';
  targetsExpiresAt: Date;
  timestampExpiresAt: Date;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function requireSafePath(value: string, name: string): string {
  if (value.includes('\\') || value.startsWith('/') || value.endsWith('/')) {
    throw new Error(`${name} is invalid`);
  }
  const segments = value.split('/');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === '.' || segment === '..' || !SAFE_PATH_SEGMENT.test(segment)
    )
  ) {
    throw new Error(`${name} is invalid`);
  }
  return segments.join('/');
}

function requireRepositoryId(value: string): string {
  if (!REPOSITORY_ID_PATTERN.test(value)) {
    throw new Error('TUF repository identifier is invalid');
  }
  return value;
}

function toObjectVersion(row: StorageObjectVersionRow): StorageObjectVersion {
  return {
    bucketName: row.bucket_name,
    bytes: Number(row.bytes),
    contentType: row.content_type,
    fileIdentifier: row.file_identifier,
    id: row.id,
    objectKey: row.object_key,
    providerVersion: row.provider_version,
    sha256: Buffer.from(row.sha256).toString('hex'),
    storageRole: row.storage_role,
    verificationState: row.verification_state,
    verifiedAt: row.verified_at,
  };
}

function publicationPaths(
  metadataVersion: number,
  rootVersion: number,
  targetPaths: string[]
): string[] {
  const targets = targetPaths.map((path) => {
    const normalized = requireSafePath(path, 'TUF target path');
    if (!normalized.startsWith('targets/')) {
      throw new Error('TUF target path must use the targets directory');
    }
    return normalized;
  });
  const paths = [
    ...targets,
    `metadata/${rootVersion}.root.json`,
    `metadata/${metadataVersion}.targets.json`,
    `metadata/${metadataVersion}.snapshot.json`,
    TIMESTAMP_PATH,
  ];
  const unique = new Set(paths);
  if (unique.size !== paths.length || targets.length > 100_000) {
    throw new Error('TUF publication paths are invalid');
  }
  return [...unique].sort((left, right) => {
    if (left === TIMESTAMP_PATH) {
      return 1;
    }
    if (right === TIMESTAMP_PATH) {
      return -1;
    }
    return left.localeCompare(right);
  });
}

export class TufRepositoryCatalog implements TufPublicationCatalogPort {
  constructor(private readonly sql: CatalogDatabase) {}

  async reservePublication(input: {
    idempotencyKey: string;
    repositoryId: string;
    rootVersion: number;
    targetPaths: string[];
  }): Promise<TufReservedPublication> {
    const repositoryId = requireRepositoryId(input.repositoryId);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey || Buffer.byteLength(idempotencyKey, 'utf8') > 512) {
      throw new Error('TUF publication idempotency key is invalid');
    }
    if (!Number.isSafeInteger(input.rootVersion) || input.rootVersion < 1) {
      throw new Error('TUF root version is invalid');
    }
    return this.sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO tuf_repositories (repository_id)
        VALUES (${repositoryId})
        ON CONFLICT (repository_id) DO NOTHING
      `;
      const rows = await transaction<{ next_metadata_version: number | string }[]>`
        SELECT next_metadata_version
        FROM tuf_repositories
        WHERE repository_id = ${repositoryId}
        FOR UPDATE
      `;
      const metadataVersion = Number(rows[0]?.next_metadata_version);
      if (!Number.isSafeInteger(metadataVersion) || metadataVersion < 1) {
        throw new Error('TUF repository version state is invalid');
      }
      const existingRows = await transaction<PublicationRow[]>`
        SELECT *
        FROM tuf_publications
        WHERE repository_id = ${repositoryId}
          AND idempotency_key = ${idempotencyKey}
        FOR UPDATE
      `;
      const existing = existingRows[0];
      if (existing) {
        const existingVersion = Number(existing.metadata_version);
        const expectedPaths = publicationPaths(
          existingVersion,
          input.rootVersion,
          input.targetPaths
        );
        if (
          Number(existing.root_version) !== input.rootVersion ||
          JSON.stringify(existing.expected_paths) !== JSON.stringify(expectedPaths) ||
          (existing.state !== 'RESERVED' &&
            existing.state !== 'PUBLISHING' &&
            existing.state !== 'PUBLISHED')
        ) {
          throw new Error('TUF publication idempotency conflict');
        }
        return {
          expectedPaths,
          id: existing.id,
          metadataVersion: existingVersion,
          repositoryId,
          rootVersion: input.rootVersion,
          snapshotExpiresAt: toDate(existing.snapshot_expires_at),
          state: existing.state,
          targetsExpiresAt: toDate(existing.targets_expires_at),
          timestampExpiresAt: toDate(existing.timestamp_expires_at),
        };
      }
      const expectedPaths = publicationPaths(metadataVersion, input.rootVersion, input.targetPaths);
      const id = randomUUID();
      const inserted = await transaction<
        {
          id: string;
          snapshot_expires_at: Date | string;
          targets_expires_at: Date | string;
          timestamp_expires_at: Date | string;
        }[]
      >`
        INSERT INTO tuf_publications (
          id,
          repository_id,
          idempotency_key,
          metadata_version,
          root_version,
          timestamp_expires_at,
          snapshot_expires_at,
          targets_expires_at,
          expected_paths,
          state
        )
        VALUES (
          ${id},
          ${repositoryId},
          ${idempotencyKey},
          ${metadataVersion},
          ${input.rootVersion},
          clock_timestamp() + interval '1 day',
          clock_timestamp() + interval '7 days',
          clock_timestamp() + interval '30 days',
          ${transaction.json(expectedPaths)},
          'RESERVED'
        )
        RETURNING
          id,
          timestamp_expires_at,
          snapshot_expires_at,
          targets_expires_at
      `;
      const created = inserted[0];
      if (!created) {
        throw new Error('TUF publication reservation failed');
      }
      await transaction`
        UPDATE tuf_repositories
        SET
          next_metadata_version = ${metadataVersion + 1},
          updated_at = clock_timestamp()
        WHERE repository_id = ${repositoryId}
      `;
      return {
        expectedPaths,
        id,
        metadataVersion,
        repositoryId,
        rootVersion: input.rootVersion,
        snapshotExpiresAt: toDate(created.snapshot_expires_at),
        state: 'RESERVED',
        targetsExpiresAt: toDate(created.targets_expires_at),
        timestampExpiresAt: toDate(created.timestamp_expires_at),
      };
    });
  }

  async requireReservedPublication(input: {
    metadataVersion: number;
    publicationId: string;
    repositoryId: string;
  }): Promise<void> {
    const rows = await this.sql<PublicationRow[]>`
      SELECT *
      FROM tuf_publications
      WHERE id = ${input.publicationId}
    `;
    const publication = rows[0];
    if (
      !publication ||
      publication.repository_id !== requireRepositoryId(input.repositoryId) ||
      Number(publication.metadata_version) !== input.metadataVersion ||
      (publication.state !== 'RESERVED' && publication.state !== 'PUBLISHING')
    ) {
      throw new Error('TUF publication is not reserved for this bundle');
    }
  }

  async getRecordedObject(
    publicationId: string,
    repositoryPath: string
  ): Promise<StorageObjectVersion | null> {
    const path = requireSafePath(repositoryPath, 'TUF repository path');
    const rows = await this.sql<StorageObjectVersionRow[]>`
      SELECT object.*
      FROM tuf_publication_objects publication_object
      JOIN storage_object_versions object
        ON object.id = publication_object.object_version_id
      WHERE publication_object.publication_id = ${publicationId}
        AND publication_object.repository_path = ${path}
        AND object.verification_state = 'VERIFIED'
    `;
    return rows[0] ? toObjectVersion(rows[0]) : null;
  }

  async recordObject(input: {
    object: StorageObjectVersion;
    publicationId: string;
    repositoryPath: string;
  }): Promise<void> {
    const repositoryPath = requireSafePath(input.repositoryPath, 'TUF repository path');
    const rows = await this.sql<{ status: string }[]>`
      SELECT tuf_record_publication_object(
        ${input.publicationId},
        ${repositoryPath},
        ${input.object.id},
        ${input.object.providerVersion},
        ${input.object.fileIdentifier}
      ) AS status
    `;
    if (rows[0]?.status !== 'INSERT' && rows[0]?.status !== 'EXISTING') {
      throw new Error('TUF object record returned an invalid status');
    }
  }

  async markPublished(input: { publicationId: string }): Promise<void> {
    const rows = await this.sql<{ status: string }[]>`
      SELECT tuf_publish_repository(${input.publicationId}) AS status
    `;
    if (rows[0]?.status !== 'PUBLISHED' && rows[0]?.status !== 'EXISTING') {
      throw new Error('TUF publication returned an invalid status');
    }
  }

  async getPublishedObject(
    repositoryId: string,
    repositoryPath: string
  ): Promise<StorageObjectVersion | null> {
    const normalizedRepositoryId = requireRepositoryId(repositoryId);
    const path = requireSafePath(repositoryPath, 'TUF repository path');
    const rows =
      path === TIMESTAMP_PATH
        ? await this.sql<StorageObjectVersionRow[]>`
            SELECT object.*
            FROM tuf_repositories repository
            JOIN tuf_publications publication
              ON publication.id = repository.active_publication_id
            JOIN tuf_publication_objects publication_object
              ON publication_object.publication_id = publication.id
            JOIN storage_object_versions object
              ON object.id = publication_object.object_version_id
            WHERE repository.repository_id = ${normalizedRepositoryId}
              AND publication.state = 'PUBLISHED'
              AND publication_object.repository_path = ${path}
              AND object.verification_state = 'VERIFIED'
          `
        : await this.sql<StorageObjectVersionRow[]>`
            SELECT object.*
            FROM tuf_publications publication
            JOIN tuf_publication_objects publication_object
              ON publication_object.publication_id = publication.id
            JOIN storage_object_versions object
              ON object.id = publication_object.object_version_id
            WHERE publication.repository_id = ${normalizedRepositoryId}
              AND publication.state = 'PUBLISHED'
              AND publication_object.repository_path = ${path}
              AND object.verification_state = 'VERIFIED'
            ORDER BY publication.published_at DESC, publication.id DESC
            LIMIT 1
          `;
    return rows[0] ? toObjectVersion(rows[0]) : null;
  }
}
