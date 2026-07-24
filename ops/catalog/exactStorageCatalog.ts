import { randomUUID } from 'node:crypto';
import type { StorageRole } from '../storage-core/exactStorage';
import type { CatalogDatabase } from './database';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type StorageWriteIntentState = 'ABORTED' | 'COMMITTED' | 'ISSUED' | 'UNCERTAIN';

export type StorageWriteOperation = 'COPY' | 'MULTIPART_PUT' | 'PUT';
export type PackageReleaseStorageLogicalKind =
  | 'chunk'
  | 'delivery-binding'
  | 'file-table'
  | 'manifest'
  | 'membership';

export type StorageObjectVersion = {
  bucketName: string;
  bytes: number;
  contentType: string;
  fileIdentifier: string;
  id: string;
  objectKey: string;
  providerVersion: string;
  sha256: string;
  storageRole: StorageRole;
  verificationState: 'DELETED' | 'REJECTED' | 'VERIFIED';
  verifiedAt: Date | null;
};

export type StorageWriteIntent = {
  bucketName: string;
  candidateObjectVersionId: string | null;
  contentType: string;
  expectedBytes: number;
  expectedSha256: string;
  id: string;
  idempotencyKey: string;
  leaseGeneration: number;
  objectKey: string;
  objectVersionId: string | null;
  operation: StorageWriteOperation;
  ownerId: string;
  ownerKind: 'maintenance' | 'materialization-job' | 'package-version';
  state: StorageWriteIntentState;
  storageDomain: string | null;
  storageRole: StorageRole;
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
  storage_role: StorageRole;
  verification_state: StorageObjectVersion['verificationState'];
  verified_at: Date | null;
};

type StorageWriteIntentRow = {
  bucket_name: string;
  candidate_object_version_id: string | null;
  content_type: string;
  expected_bytes: number | string;
  expected_sha256: Buffer;
  id: string;
  idempotency_key: string;
  lease_generation: number;
  object_key: string;
  object_version_id: string | null;
  operation: StorageWriteOperation;
  owner_id: string;
  owner_kind: StorageWriteIntent['ownerKind'];
  state: StorageWriteIntentState;
  storage_domain: string | null;
  storage_role: StorageRole;
};

function toIntent(row: StorageWriteIntentRow): StorageWriteIntent {
  return {
    bucketName: row.bucket_name,
    candidateObjectVersionId: row.candidate_object_version_id,
    contentType: row.content_type,
    expectedBytes: Number(row.expected_bytes),
    expectedSha256: Buffer.from(row.expected_sha256).toString('hex'),
    id: row.id,
    idempotencyKey: row.idempotency_key,
    leaseGeneration: row.lease_generation,
    objectKey: row.object_key,
    objectVersionId: row.object_version_id,
    operation: row.operation,
    ownerId: row.owner_id,
    ownerKind: row.owner_kind,
    state: row.state,
    storageDomain: row.storage_domain,
    storageRole: row.storage_role,
  };
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

function requiredText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function assertSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error('Storage SHA-256 is invalid');
  }
  return value;
}

function assertIntentMatches(
  intent: StorageWriteIntent,
  input: {
    bucketName: string;
    contentType: string;
    expectedBytes: number;
    expectedSha256: string;
    leaseGeneration: number;
    objectKey: string;
    operation: StorageWriteOperation;
    ownerId: string;
    ownerKind: StorageWriteIntent['ownerKind'];
    storageDomain?: string;
    storageRole: StorageRole;
  }
): void {
  if (
    intent.bucketName !== input.bucketName ||
    intent.contentType !== input.contentType ||
    intent.expectedBytes !== input.expectedBytes ||
    intent.expectedSha256 !== input.expectedSha256 ||
    intent.leaseGeneration !== input.leaseGeneration ||
    intent.objectKey !== input.objectKey ||
    intent.operation !== input.operation ||
    intent.ownerId !== input.ownerId ||
    intent.ownerKind !== input.ownerKind ||
    intent.storageDomain !== (input.storageDomain ?? null) ||
    intent.storageRole !== input.storageRole
  ) {
    throw new Error('Storage write intent idempotency conflict');
  }
}

export class ExactStorageCatalog {
  constructor(private readonly sql: CatalogDatabase) {}

  async beginWriteIntent(input: {
    bucketName: string;
    contentType: string;
    expectedBytes: number;
    expectedSha256: string;
    idempotencyKey: string;
    leaseGeneration?: number;
    objectKey: string;
    operation: StorageWriteOperation;
    ownerId: string;
    ownerKind: StorageWriteIntent['ownerKind'];
    storageDomain?: string;
    storageRole: StorageRole;
  }): Promise<StorageWriteIntent> {
    if (
      !Number.isSafeInteger(input.expectedBytes) ||
      input.expectedBytes < 0 ||
      input.expectedBytes > 64 * 1024 ** 3 ||
      !Number.isSafeInteger(input.leaseGeneration ?? 0) ||
      (input.leaseGeneration ?? 0) < 0
    ) {
      throw new Error('Storage write intent bounds are invalid');
    }
    const expectedSha256 = assertSha256(input.expectedSha256);
    const values = {
      ...input,
      bucketName: requiredText(input.bucketName, 'Storage bucket name', 255),
      contentType: requiredText(input.contentType, 'Storage content type', 255),
      idempotencyKey: requiredText(input.idempotencyKey, 'Storage idempotency key', 512),
      objectKey: requiredText(input.objectKey, 'Storage object key', 2048),
      ownerId: requiredText(input.ownerId, 'Storage owner identifier', 512),
      storageDomain: input.storageDomain
        ? requiredText(input.storageDomain, 'Storage domain', 512)
        : undefined,
    };
    const rows = await this.sql<StorageWriteIntentRow[]>`
      INSERT INTO storage_write_intents (
        id,
        idempotency_key,
        owner_kind,
        owner_id,
        lease_generation,
        operation,
        storage_role,
        storage_domain,
        bucket_name,
        object_key,
        expected_sha256,
        expected_bytes,
        content_type,
        state
      )
      VALUES (
        ${randomUUID()},
        ${values.idempotencyKey},
        ${values.ownerKind},
        ${values.ownerId},
        ${values.leaseGeneration ?? 0},
        ${values.operation},
        ${values.storageRole},
        ${values.storageDomain ?? null},
        ${values.bucketName},
        ${values.objectKey},
        decode(${expectedSha256}, 'hex'),
        ${values.expectedBytes},
        ${values.contentType},
        'ISSUED'
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *
    `;
    const intent = rows[0]
      ? toIntent(rows[0])
      : await this.getWriteIntentByIdempotencyKey(values.idempotencyKey);
    if (!intent) {
      throw new Error('Storage write intent was not returned');
    }
    assertIntentMatches(intent, {
      ...values,
      expectedSha256,
      leaseGeneration: values.leaseGeneration ?? 0,
    });
    return intent;
  }

  async getWriteIntentByIdempotencyKey(idempotencyKey: string): Promise<StorageWriteIntent | null> {
    const rows = await this.sql<StorageWriteIntentRow[]>`
      SELECT *
      FROM storage_write_intents
      WHERE idempotency_key = ${idempotencyKey}
    `;
    return rows[0] ? toIntent(rows[0]) : null;
  }

  async linkPackageReleaseObject(input: {
    logicalDigest: string;
    logicalKind: PackageReleaseStorageLogicalKind;
    objectVersionId: string;
    packageVersionId: string;
  }): Promise<void> {
    const logicalDigest = assertSha256(input.logicalDigest);
    await this.sql.begin(async (transaction) => {
      const objects = await transaction<{ id: string }[]>`
        SELECT object.id
        FROM storage_object_versions object
        LEFT JOIN storage_gc_candidates candidate
          ON candidate.object_version_id = object.id
        WHERE object.id = ${input.objectVersionId}
          AND object.verification_state = 'VERIFIED'
          AND object.sha256 = decode(${logicalDigest}, 'hex')
          AND (
            candidate.state IS NULL
            OR candidate.state NOT IN ('DELETING', 'DELETED')
          )
        FOR UPDATE OF object
      `;
      if (objects.length !== 1) {
        throw new Error(
          'Package release storage link requires one available verified exact object'
        );
      }
      const rows = await transaction<{ object_version_id: string }[]>`
        INSERT INTO package_release_storage_objects (
          package_version_id,
          logical_kind,
          logical_digest,
          object_version_id
        )
        VALUES (
          ${input.packageVersionId},
          ${input.logicalKind},
          decode(${logicalDigest}, 'hex'),
          ${input.objectVersionId}
        )
        ON CONFLICT (
          package_version_id,
          logical_kind,
          logical_digest,
          object_version_id
        )
        DO UPDATE SET object_version_id = EXCLUDED.object_version_id
        RETURNING object_version_id
      `;
      if (rows.length !== 1) {
        throw new Error('Package release storage link requires one verified exact object');
      }
    });
  }

  async getPackageReleaseObject(input: {
    logicalDigest: string;
    logicalKind: PackageReleaseStorageLogicalKind;
    objectKey: string;
    packageVersionId: string;
    storageRole: Extract<StorageRole, 'common' | 'metadata' | 'protected'>;
  }): Promise<StorageObjectVersion | null> {
    const rows = await this.sql<StorageObjectVersionRow[]>`
      SELECT object.*
      FROM package_release_storage_objects release_object
      JOIN storage_object_versions object
        ON object.id = release_object.object_version_id
      WHERE release_object.package_version_id = ${input.packageVersionId}
        AND release_object.logical_kind = ${input.logicalKind}
        AND release_object.logical_digest = decode(
          ${assertSha256(input.logicalDigest)},
          'hex'
        )
        AND object.object_key = ${input.objectKey}
        AND object.storage_role = ${input.storageRole}
        AND object.sha256 = release_object.logical_digest
        AND object.verification_state = 'VERIFIED'
      ORDER BY object.id
      LIMIT 2
    `;
    if (rows.length > 1) {
      throw new Error('Package release exact object is ambiguous');
    }
    return rows[0] ? toObjectVersion(rows[0]) : null;
  }

  async getCommittedObjectForIntent(idempotencyKey: string): Promise<StorageObjectVersion | null> {
    const rows = await this.sql<StorageObjectVersionRow[]>`
      SELECT object.*
      FROM storage_write_intents intent
      JOIN storage_object_versions object
        ON object.id = intent.object_version_id
      WHERE intent.idempotency_key = ${idempotencyKey}
        AND intent.state = 'COMMITTED'
        AND object.verification_state = 'VERIFIED'
    `;
    return rows[0] ? toObjectVersion(rows[0]) : null;
  }

  async markWriteIntentUncertain(intentId: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE storage_write_intents
      SET state = 'UNCERTAIN', updated_at = clock_timestamp()
      WHERE id = ${intentId} AND state IN ('ISSUED', 'UNCERTAIN')
      RETURNING id
    `;
    if (rows.length !== 1) {
      throw new Error('Storage write intent cannot become uncertain');
    }
  }

  async commitVerifiedObject(input: {
    fileIdentifier: string;
    intentId: string;
    providerVersion: string;
  }): Promise<StorageObjectVersion> {
    return this.sql.begin(async (transaction) => {
      const intentRows = await transaction<StorageWriteIntentRow[]>`
        SELECT *
        FROM storage_write_intents
        WHERE id = ${input.intentId}
        FOR UPDATE
      `;
      const intentRow = intentRows[0];
      if (!intentRow) {
        throw new Error('Storage write intent was not found');
      }
      const intent = toIntent(intentRow);
      const providerVersion = requiredText(input.providerVersion, 'Storage provider version', 512);
      const fileIdentifier = requiredText(input.fileIdentifier, 'Storage file identifier', 512);
      if (intent.state === 'COMMITTED') {
        const existingRows = await transaction<StorageObjectVersionRow[]>`
          SELECT *
          FROM storage_object_versions
          WHERE id = ${intent.objectVersionId as string}
        `;
        const existing = existingRows[0] ? toObjectVersion(existingRows[0]) : null;
        if (
          !existing ||
          existing.providerVersion !== providerVersion ||
          existing.fileIdentifier !== fileIdentifier
        ) {
          throw new Error('Committed storage write intent is immutable');
        }
        return existing;
      }
      if (intent.state !== 'ISSUED' && intent.state !== 'UNCERTAIN') {
        throw new Error('Storage write intent cannot commit');
      }

      const inserted = await transaction<StorageObjectVersionRow[]>`
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
          ${randomUUID()},
          ${intent.storageRole},
          ${intent.bucketName},
          ${intent.objectKey},
          ${providerVersion},
          ${fileIdentifier},
          decode(${intent.expectedSha256}, 'hex'),
          ${intent.expectedBytes},
          ${intent.contentType},
          'VERIFIED',
          clock_timestamp()
        )
        ON CONFLICT (storage_role, bucket_name, object_key, provider_version)
        DO NOTHING
        RETURNING *
      `;
      const object =
        inserted[0] ??
        (
          await transaction<StorageObjectVersionRow[]>`
            SELECT *
            FROM storage_object_versions
            WHERE storage_role = ${intent.storageRole}
              AND bucket_name = ${intent.bucketName}
              AND object_key = ${intent.objectKey}
              AND provider_version = ${providerVersion}
          `
        )[0];
      if (!object) {
        throw new Error('Exact storage object version was not returned');
      }
      const exact = toObjectVersion(object);
      if (
        exact.fileIdentifier !== fileIdentifier ||
        exact.sha256 !== intent.expectedSha256 ||
        exact.bytes !== intent.expectedBytes ||
        exact.contentType !== intent.contentType ||
        exact.verificationState !== 'VERIFIED'
      ) {
        throw new Error('Exact storage object conflicts with the write intent');
      }
      const committed = await transaction<{ id: string }[]>`
        UPDATE storage_write_intents
        SET
          state = 'COMMITTED',
          object_version_id = ${exact.id},
          updated_at = clock_timestamp()
        WHERE id = ${intent.id} AND state IN ('ISSUED', 'UNCERTAIN')
        RETURNING id
      `;
      if (committed.length !== 1) {
        throw new Error('Storage write intent lost commit ownership');
      }
      if (
        intent.storageDomain &&
        (intent.storageRole === 'common' ||
          intent.storageRole === 'metadata' ||
          intent.storageRole === 'protected')
      ) {
        await transaction`
          INSERT INTO canonical_storage_objects (
            storage_role,
            storage_domain,
            sha256,
            bytes,
            object_version_id
          )
          VALUES (
            ${intent.storageRole},
            ${intent.storageDomain},
            decode(${intent.expectedSha256}, 'hex'),
            ${intent.expectedBytes},
            ${exact.id}
          )
          ON CONFLICT (storage_role, storage_domain, sha256, bytes)
          DO UPDATE SET
            object_version_id = EXCLUDED.object_version_id,
            updated_at = clock_timestamp()
        `;
      }
      return exact;
    });
  }

  async findVerifiedCanonical(input: {
    bytes: number;
    intentId?: string;
    sha256: string;
    storageDomain: string;
    storageRole: Extract<StorageRole, 'common' | 'metadata' | 'protected'>;
  }): Promise<StorageObjectVersion | null> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<StorageObjectVersionRow[]>`
        SELECT object.*
        FROM canonical_storage_objects canonical
        JOIN storage_object_versions object
          ON object.id = canonical.object_version_id
        LEFT JOIN storage_gc_candidates candidate
          ON candidate.object_version_id = object.id
        WHERE canonical.storage_role = ${input.storageRole}
          AND canonical.storage_domain = ${input.storageDomain}
          AND canonical.sha256 = decode(${assertSha256(input.sha256)}, 'hex')
          AND canonical.bytes = ${input.bytes}
          AND object.verification_state = 'VERIFIED'
          AND (
            candidate.state IS NULL
            OR candidate.state NOT IN ('DELETING', 'DELETED')
          )
        FOR UPDATE OF object
      `;
      const object = rows[0] ? toObjectVersion(rows[0]) : null;
      if (!object || !input.intentId) {
        return object;
      }
      const intents = await transaction<StorageWriteIntentRow[]>`
        UPDATE storage_write_intents
        SET
          candidate_object_version_id = ${object.id},
          updated_at = clock_timestamp()
        WHERE id = ${input.intentId}
          AND state IN ('ISSUED', 'UNCERTAIN')
          AND storage_role = ${input.storageRole}
          AND storage_domain = ${input.storageDomain}
          AND expected_sha256 = decode(${input.sha256}, 'hex')
          AND expected_bytes = ${input.bytes}
        RETURNING *
      `;
      if (intents.length !== 1) {
        throw new Error(
          'Verified canonical storage reservation requires one matching write intent'
        );
      }
      return object;
    });
  }
}
