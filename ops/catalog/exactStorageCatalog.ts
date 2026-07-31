import { randomUUID } from 'node:crypto';
import type { StorageRole } from '../storage-core/exactStorage';
import { type CatalogDatabase, toCatalogDate } from './database';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StorageWriteIntentState = 'ABORTED' | 'COMMITTED' | 'ISSUED' | 'RETRYING' | 'UNCERTAIN';

export type StorageWriteOperation = 'COPY' | 'MULTIPART_PUT' | 'PUT';
export type StorageWriteRetryClaim = {
  expiresAt: Date;
  token: string;
};
export type PackageReleaseStorageLogicalKind =
  | 'bootstrap-media'
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
  ownerKind: 'maintenance' | 'materialization-job' | 'package-version' | 'vpm-alias-publication';
  retryClaimExpiresAt: Date | null;
  retryClaimToken: string | null;
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
  retry_claim_expires_at: Date | string | null;
  retry_claim_token: string | null;
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
    retryClaimExpiresAt: toCatalogDate(row.retry_claim_expires_at),
    retryClaimToken: row.retry_claim_token,
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

function assertUuid(value: string, name: string): string {
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized.toLowerCase();
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

export type BeginWriteIntentInput = {
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
};

function normalizeWriteIntentInput(input: BeginWriteIntentInput): BeginWriteIntentInput & {
  expectedSha256: string;
  leaseGeneration: number;
} {
  if (
    !Number.isSafeInteger(input.expectedBytes) ||
    input.expectedBytes < 0 ||
    input.expectedBytes > 64 * 1024 ** 3 ||
    !Number.isSafeInteger(input.leaseGeneration ?? 0) ||
    (input.leaseGeneration ?? 0) < 0
  ) {
    throw new Error('Storage write intent bounds are invalid');
  }
  return {
    ...input,
    bucketName: requiredText(input.bucketName, 'Storage bucket name', 255),
    contentType: requiredText(input.contentType, 'Storage content type', 255),
    expectedSha256: assertSha256(input.expectedSha256),
    idempotencyKey: requiredText(input.idempotencyKey, 'Storage idempotency key', 512),
    leaseGeneration: input.leaseGeneration ?? 0,
    objectKey: requiredText(input.objectKey, 'Storage object key', 2048),
    ownerId: requiredText(input.ownerId, 'Storage owner identifier', 512),
    storageDomain: input.storageDomain
      ? requiredText(input.storageDomain, 'Storage domain', 512)
      : undefined,
  };
}

/** Upper bound for every batched catalog call; callers must chunk larger inputs. */
export const MAX_STORAGE_BATCH_ITEMS = 1_024;

function assertBatchSize(length: number): void {
  if (length > MAX_STORAGE_BATCH_ITEMS) {
    throw new Error('Storage batch exceeds its size limit');
  }
}

export class ExactStorageCatalog {
  constructor(private readonly sql: CatalogDatabase) {}

  async beginWriteIntent(input: BeginWriteIntentInput): Promise<StorageWriteIntent> {
    const values = normalizeWriteIntentInput(input);
    const expectedSha256 = values.expectedSha256;
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
    if (intent.state === 'ABORTED') {
      const revived = await this.sql<StorageWriteIntentRow[]>`
        UPDATE storage_write_intents
        SET state = 'ISSUED', updated_at = clock_timestamp()
        WHERE id = ${intent.id} AND state = 'ABORTED'
        RETURNING *
      `;
      if (revived[0]) {
        return toIntent(revived[0]);
      }
      const refreshed = await this.getWriteIntentByIdempotencyKey(values.idempotencyKey);
      if (!refreshed) {
        throw new Error('Storage write intent was not returned');
      }
      return refreshed;
    }
    return intent;
  }

  /**
   * Multi-row beginWriteIntent with identical per-row semantics: idempotent on the
   * idempotency key, verifies matching parameters, revives ABORTED intents, and returns
   * each row's existing-intent state in input order.
   */
  async beginWriteIntentBatch(
    inputs: readonly BeginWriteIntentInput[]
  ): Promise<StorageWriteIntent[]> {
    if (inputs.length === 0) {
      return [];
    }
    assertBatchSize(inputs.length);
    const values = inputs.map((input) => normalizeWriteIntentInput(input));
    const keys = values.map((value) => value.idempotencyKey);
    if (new Set(keys).size !== keys.length) {
      throw new Error('Storage write intent batch has duplicate idempotency keys');
    }
    await this.sql`
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
      SELECT
        batch.id,
        batch.idempotency_key,
        batch.owner_kind,
        batch.owner_id,
        batch.lease_generation,
        batch.operation,
        batch.storage_role,
        batch.storage_domain,
        batch.bucket_name,
        batch.object_key,
        decode(batch.expected_sha256, 'hex'),
        batch.expected_bytes,
        batch.content_type,
        'ISSUED'
      FROM unnest(
        ${values.map(() => randomUUID())}::uuid[],
        ${keys}::text[],
        ${values.map((value) => value.ownerKind)}::text[],
        ${values.map((value) => value.ownerId)}::text[],
        ${values.map((value) => value.leaseGeneration)}::int[],
        ${values.map((value) => value.operation)}::text[],
        ${values.map((value) => value.storageRole)}::text[],
        ${values.map((value) => value.storageDomain ?? null)}::text[],
        ${values.map((value) => value.bucketName)}::text[],
        ${values.map((value) => value.objectKey)}::text[],
        ${values.map((value) => value.expectedSha256)}::text[],
        ${values.map((value) => value.expectedBytes)}::bigint[],
        ${values.map((value) => value.contentType)}::text[]
      ) AS batch(
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
        content_type
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
    const load = async (): Promise<Map<string, StorageWriteIntent>> => {
      const rows = await this.sql<StorageWriteIntentRow[]>`
        SELECT *
        FROM storage_write_intents
        WHERE idempotency_key = ANY(${keys}::text[])
      `;
      return new Map(rows.map((row) => [row.idempotency_key, toIntent(row)]));
    };
    let byKey = await load();
    for (const value of values) {
      const intent = byKey.get(value.idempotencyKey);
      if (!intent) {
        throw new Error('Storage write intent was not returned');
      }
      assertIntentMatches(intent, value);
    }
    const abortedIds = values
      .map((value) => byKey.get(value.idempotencyKey) as StorageWriteIntent)
      .filter((intent) => intent.state === 'ABORTED')
      .map((intent) => intent.id);
    if (abortedIds.length > 0) {
      await this.sql`
        UPDATE storage_write_intents
        SET state = 'ISSUED', updated_at = clock_timestamp()
        WHERE id = ANY(${abortedIds}::uuid[]) AND state = 'ABORTED'
      `;
      byKey = await load();
    }
    return values.map((value) => {
      const intent = byKey.get(value.idempotencyKey);
      if (!intent) {
        throw new Error('Storage write intent was not returned');
      }
      return intent;
    });
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

  async reopenLostObjectWriteIntent(input: {
    intentId: string;
    objectVersionId: string;
  }): Promise<boolean> {
    const intentId = assertUuid(input.intentId, 'Storage write intent id');
    const objectVersionId = assertUuid(input.objectVersionId, 'Storage object version id');
    return this.sql.begin(async (transaction) => {
      const intents = await transaction<StorageWriteIntentRow[]>`
        SELECT * FROM storage_write_intents WHERE id = ${intentId} FOR UPDATE
      `;
      const intent = intents[0] ? toIntent(intents[0]) : null;
      if (!intent || intent.state !== 'COMMITTED' || intent.objectVersionId !== objectVersionId) {
        return false;
      }
      const objects = await transaction<{ verification_state: string }[]>`
        SELECT verification_state FROM storage_object_versions
        WHERE id = ${objectVersionId}
        FOR UPDATE
      `;
      const objectState = objects[0]?.verification_state;
      if (objectState === 'VERIFIED') {
        await transaction`
          UPDATE storage_object_versions
          SET verification_state = 'DELETED', deleted_at = clock_timestamp()
          WHERE id = ${objectVersionId}
        `;
      } else if (objectState !== 'DELETED') {
        return false;
      }
      await transaction`
        UPDATE storage_write_intents
        SET
          state = 'UNCERTAIN',
          object_version_id = NULL,
          retry_claim_token = NULL,
          retry_claim_expires_at = NULL,
          updated_at = clock_timestamp()
        WHERE id = ${intentId}
      `;
      return true;
    });
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

  async claimUncertainWriteRetry(input: {
    claimDurationMs: number;
    intentId: string;
  }): Promise<StorageWriteRetryClaim | null> {
    if (
      !Number.isSafeInteger(input.claimDurationMs) ||
      input.claimDurationMs < 1_000 ||
      input.claimDurationMs > 60 * 60 * 1_000
    ) {
      throw new Error('Storage write retry claim bounds are invalid');
    }
    const token = randomUUID();
    const rows = await this.sql<
      { retry_claim_expires_at: Date | string; retry_claim_token: string }[]
    >`
      UPDATE storage_write_intents
      SET
        state = 'RETRYING',
        retry_claim_token = ${token},
        retry_claim_expires_at =
          clock_timestamp() + (${input.claimDurationMs} * interval '1 millisecond'),
        updated_at = clock_timestamp()
      WHERE id = ${input.intentId}
        AND object_version_id IS NULL
        AND (
          state = 'UNCERTAIN'
          OR (
            state = 'RETRYING'
            AND retry_claim_expires_at <= clock_timestamp()
          )
        )
      RETURNING retry_claim_token, retry_claim_expires_at
    `;
    const claimed = rows[0];
    return claimed
      ? {
          expiresAt: toCatalogDate(claimed.retry_claim_expires_at) as Date,
          token: claimed.retry_claim_token,
        }
      : null;
  }

  async markWriteIntentUncertain(intentId: string, retryClaimToken?: string): Promise<void> {
    const token = retryClaimToken
      ? assertUuid(retryClaimToken, 'Storage write retry claim token')
      : null;
    const rows = await this.sql<{ id: string }[]>`
      UPDATE storage_write_intents
      SET
        state = 'UNCERTAIN',
        retry_claim_token = NULL,
        retry_claim_expires_at = NULL,
        updated_at = clock_timestamp()
      WHERE id = ${intentId}
        AND (
          (
            state IN ('ISSUED', 'UNCERTAIN')
            AND ${token}::text IS NULL
          )
          OR (
            state = 'RETRYING'
            AND retry_claim_token::text = ${token}
          )
        )
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
    retryClaimToken?: string;
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
      const retryClaimToken = input.retryClaimToken
        ? assertUuid(input.retryClaimToken, 'Storage write retry claim token')
        : null;
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
      if (
        intent.state !== 'ISSUED' &&
        intent.state !== 'RETRYING' &&
        intent.state !== 'UNCERTAIN'
      ) {
        throw new Error('Storage write intent cannot commit');
      }
      if (
        (intent.state === 'RETRYING' && intent.retryClaimToken !== retryClaimToken) ||
        (intent.state !== 'RETRYING' && retryClaimToken !== null)
      ) {
        throw new Error('Storage write intent lost commit ownership');
      }

      const revived = await transaction<{ id: string }[]>`
        UPDATE storage_object_versions
        SET verification_state = 'VERIFIED', verified_at = clock_timestamp(), deleted_at = NULL
        WHERE storage_role = ${intent.storageRole}
          AND bucket_name = ${intent.bucketName}
          AND object_key = ${intent.objectKey}
          AND provider_version = ${providerVersion}
          AND verification_state = 'DELETED'
          AND file_identifier = ${fileIdentifier}
          AND sha256 = decode(${intent.expectedSha256}, 'hex')
          AND bytes = ${intent.expectedBytes}
          AND content_type = ${intent.contentType}
        RETURNING id
      `;
      if (revived.length > 0) {
        await transaction`
          DELETE FROM storage_gc_candidates
          WHERE object_version_id = ANY(${revived.map((row) => row.id)}::uuid[])
        `;
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
            SELECT object.*
            FROM storage_object_versions object
            LEFT JOIN storage_gc_candidates candidate
              ON candidate.object_version_id = object.id
            WHERE object.storage_role = ${intent.storageRole}
              AND object.bucket_name = ${intent.bucketName}
              AND object.object_key = ${intent.objectKey}
              AND object.provider_version = ${providerVersion}
              AND object.verification_state = 'VERIFIED'
              AND (
                candidate.state IS NULL
                OR candidate.state NOT IN ('DELETING', 'DELETED')
              )
            FOR UPDATE OF object
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
          retry_claim_token = NULL,
          retry_claim_expires_at = NULL,
          updated_at = clock_timestamp()
        WHERE id = ${intent.id}
          AND (
            state IN ('ISSUED', 'UNCERTAIN')
            OR (
              state = 'RETRYING'
              AND retry_claim_token::text = ${retryClaimToken}
              AND retry_claim_expires_at > clock_timestamp()
            )
          )
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
          AND state IN ('ISSUED', 'RETRYING', 'UNCERTAIN')
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

  /**
   * Multi-row findVerifiedCanonical: one locked lookup for every (sha256, bytes) pair and
   * one reservation update for the matched intents. Returns matches in input order, null
   * where no verified canonical object exists.
   */
  async findVerifiedCanonicalBatch(input: {
    items: ReadonlyArray<{ bytes: number; intentId: string; sha256: string }>;
    storageDomain: string;
    storageRole: Extract<StorageRole, 'common' | 'metadata' | 'protected'>;
  }): Promise<Array<StorageObjectVersion | null>> {
    if (input.items.length === 0) {
      return [];
    }
    assertBatchSize(input.items.length);
    const items = input.items.map((item) => {
      if (!Number.isSafeInteger(item.bytes) || item.bytes < 0) {
        throw new Error('Storage write intent bounds are invalid');
      }
      return {
        bytes: item.bytes,
        intentId: assertUuid(item.intentId, 'Storage write intent id'),
        sha256: assertSha256(item.sha256),
      };
    });
    const lookupIntentIds = items.map((item) => item.intentId);
    if (new Set(lookupIntentIds).size !== lookupIntentIds.length) {
      throw new Error('Verified canonical storage lookup batch has duplicate intents');
    }
    const storageDomain = requiredText(input.storageDomain, 'Storage domain', 512);
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<Array<StorageObjectVersionRow & { ordinal: number }>>`
        SELECT batch.ordinal, object.*
        FROM unnest(
          ${items.map((_, index) => index)}::int[],
          ${items.map((item) => item.sha256)}::text[],
          ${items.map((item) => item.bytes)}::bigint[]
        ) AS batch(ordinal, sha256, bytes)
        JOIN canonical_storage_objects canonical
          ON canonical.storage_role = ${input.storageRole}
          AND canonical.storage_domain = ${storageDomain}
          AND canonical.sha256 = decode(batch.sha256, 'hex')
          AND canonical.bytes = batch.bytes
        JOIN storage_object_versions object
          ON object.id = canonical.object_version_id
        LEFT JOIN storage_gc_candidates candidate
          ON candidate.object_version_id = object.id
        WHERE object.verification_state = 'VERIFIED'
          AND (
            candidate.state IS NULL
            OR candidate.state NOT IN ('DELETING', 'DELETED')
          )
        ORDER BY object.id
        FOR UPDATE OF object
      `;
      const found: Array<StorageObjectVersion | null> = items.map(() => null);
      for (const row of rows) {
        found[row.ordinal] = toObjectVersion(row);
      }
      const matched = items
        .map((item, index) => ({ item, object: found[index] }))
        .filter((entry): entry is { item: (typeof items)[number]; object: StorageObjectVersion } =>
          Boolean(entry.object)
        );
      if (matched.length > 0) {
        const reserved = await transaction<{ id: string }[]>`
          UPDATE storage_write_intents intent
          SET
            candidate_object_version_id = batch.object_version_id,
            updated_at = clock_timestamp()
          FROM unnest(
            ${matched.map((entry) => entry.item.intentId)}::uuid[],
            ${matched.map((entry) => entry.object.id)}::uuid[],
            ${matched.map((entry) => entry.item.sha256)}::text[],
            ${matched.map((entry) => entry.item.bytes)}::bigint[]
          ) AS batch(intent_id, object_version_id, sha256, bytes)
          WHERE intent.id = batch.intent_id
            AND intent.state IN ('ISSUED', 'RETRYING', 'UNCERTAIN')
            AND intent.storage_role = ${input.storageRole}
            AND intent.storage_domain = ${storageDomain}
            AND intent.expected_sha256 = decode(batch.sha256, 'hex')
            AND intent.expected_bytes = batch.bytes
          RETURNING intent.id
        `;
        if (reserved.length !== matched.length) {
          throw new Error(
            'Verified canonical storage reservation requires one matching write intent'
          );
        }
      }
      return found;
    });
  }

  /**
   * Multi-row commitVerifiedObject plus release links in one transaction. Entries whose
   * intent is already COMMITTED are verified against their recorded object (idempotent
   * re-commit); every other entry must be ISSUED or UNCERTAIN. Reconciliation-claimed
   * (RETRYING) intents must use the single-row commit with their claim token.
   */
  async commitVerifiedObjectsBatch(input: {
    entries: ReadonlyArray<{
      fileIdentifier: string;
      intentId: string;
      providerVersion: string;
      releaseLink?: {
        logicalDigest: string;
        logicalKind: PackageReleaseStorageLogicalKind;
      };
    }>;
    packageVersionId?: string;
  }): Promise<Array<{ intentId: string; object: StorageObjectVersion }>> {
    if (input.entries.length === 0) {
      return [];
    }
    assertBatchSize(input.entries.length);
    const entries = input.entries.map((entry) => ({
      fileIdentifier: requiredText(entry.fileIdentifier, 'Storage file identifier', 512),
      intentId: assertUuid(entry.intentId, 'Storage write intent id'),
      providerVersion: requiredText(entry.providerVersion, 'Storage provider version', 512),
      releaseLink: entry.releaseLink
        ? {
            logicalDigest: assertSha256(entry.releaseLink.logicalDigest),
            logicalKind: entry.releaseLink.logicalKind,
          }
        : undefined,
    }));
    const intentIds = entries.map((entry) => entry.intentId);
    if (new Set(intentIds).size !== intentIds.length) {
      throw new Error('Storage write commit batch has duplicate intents');
    }
    const packageVersionId =
      entries.some((entry) => entry.releaseLink) && input.packageVersionId
        ? assertUuid(input.packageVersionId, 'Package version id')
        : input.packageVersionId;
    if (entries.some((entry) => entry.releaseLink) && !packageVersionId) {
      throw new Error('Storage release links require a package version id');
    }
    return this.sql.begin(async (transaction) => {
      const intentRows = await transaction<StorageWriteIntentRow[]>`
        SELECT *
        FROM storage_write_intents
        WHERE id = ANY(${intentIds}::uuid[])
        ORDER BY id
        FOR UPDATE
      `;
      const intentById = new Map(intentRows.map((row) => [row.id, toIntent(row)]));
      const resolved = entries.map((entry) => {
        const intent = intentById.get(entry.intentId);
        if (!intent) {
          throw new Error('Storage write intent was not found');
        }
        if (intent.state === 'RETRYING') {
          throw new Error('Storage write intent lost commit ownership');
        }
        if (
          intent.state !== 'COMMITTED' &&
          intent.state !== 'ISSUED' &&
          intent.state !== 'UNCERTAIN'
        ) {
          throw new Error('Storage write intent cannot commit');
        }
        return { entry, intent };
      });
      const pending = resolved.filter(({ intent }) => intent.state !== 'COMMITTED');
      // Committed intents resolve by their recorded object id, mirroring the single-row
      // path, so an idempotent re-commit survives soft-deleted or GC-marked objects.
      const recordedIds = resolved
        .filter(({ intent }) => intent.state === 'COMMITTED')
        .map(({ intent }) => intent.objectVersionId as string);
      const recordedById = new Map(
        recordedIds.length > 0
          ? (
              await transaction<StorageObjectVersionRow[]>`
                SELECT *
                FROM storage_object_versions
                WHERE id = ANY(${recordedIds}::uuid[])
              `
            ).map((row) => [row.id, toObjectVersion(row)] as const)
          : []
      );
      if (pending.length > 0) {
        const revived = await transaction<{ id: string }[]>`
          UPDATE storage_object_versions object
          SET verification_state = 'VERIFIED', verified_at = clock_timestamp(), deleted_at = NULL
          FROM unnest(
            ${pending.map(({ intent }) => intent.storageRole)}::text[],
            ${pending.map(({ intent }) => intent.bucketName)}::text[],
            ${pending.map(({ intent }) => intent.objectKey)}::text[],
            ${pending.map(({ entry }) => entry.providerVersion)}::text[],
            ${pending.map(({ entry }) => entry.fileIdentifier)}::text[],
            ${pending.map(({ intent }) => intent.expectedSha256)}::text[],
            ${pending.map(({ intent }) => intent.expectedBytes)}::bigint[],
            ${pending.map(({ intent }) => intent.contentType)}::text[]
          ) AS batch(
            storage_role,
            bucket_name,
            object_key,
            provider_version,
            file_identifier,
            sha256,
            bytes,
            content_type
          )
          WHERE object.storage_role = batch.storage_role
            AND object.bucket_name = batch.bucket_name
            AND object.object_key = batch.object_key
            AND object.provider_version = batch.provider_version
            AND object.verification_state = 'DELETED'
            AND object.file_identifier = batch.file_identifier
            AND object.sha256 = decode(batch.sha256, 'hex')
            AND object.bytes = batch.bytes
            AND object.content_type = batch.content_type
          RETURNING object.id
        `;
        if (revived.length > 0) {
          await transaction`
            DELETE FROM storage_gc_candidates
            WHERE object_version_id = ANY(${revived.map((row) => row.id)}::uuid[])
          `;
        }
        await transaction`
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
          SELECT
            batch.id,
            batch.storage_role,
            batch.bucket_name,
            batch.object_key,
            batch.provider_version,
            batch.file_identifier,
            decode(batch.sha256, 'hex'),
            batch.bytes,
            batch.content_type,
            'VERIFIED',
            clock_timestamp()
          FROM unnest(
            ${pending.map(() => randomUUID())}::uuid[],
            ${pending.map(({ intent }) => intent.storageRole)}::text[],
            ${pending.map(({ intent }) => intent.bucketName)}::text[],
            ${pending.map(({ intent }) => intent.objectKey)}::text[],
            ${pending.map(({ entry }) => entry.providerVersion)}::text[],
            ${pending.map(({ entry }) => entry.fileIdentifier)}::text[],
            ${pending.map(({ intent }) => intent.expectedSha256)}::text[],
            ${pending.map(({ intent }) => intent.expectedBytes)}::bigint[],
            ${pending.map(({ intent }) => intent.contentType)}::text[]
          ) AS batch(
            id,
            storage_role,
            bucket_name,
            object_key,
            provider_version,
            file_identifier,
            sha256,
            bytes,
            content_type
          )
          ON CONFLICT (storage_role, bucket_name, object_key, provider_version)
          DO NOTHING
        `;
      }
      const objectRows = await transaction<Array<StorageObjectVersionRow & { ordinal: number }>>`
        SELECT batch.ordinal, object.*
        FROM unnest(
          ${resolved.map((_, index) => index)}::int[],
          ${resolved.map(({ intent }) => intent.storageRole)}::text[],
          ${resolved.map(({ intent }) => intent.bucketName)}::text[],
          ${resolved.map(({ intent }) => intent.objectKey)}::text[],
          ${resolved.map(({ entry }) => entry.providerVersion)}::text[]
        ) AS batch(ordinal, storage_role, bucket_name, object_key, provider_version)
        JOIN storage_object_versions object
          ON object.storage_role = batch.storage_role
          AND object.bucket_name = batch.bucket_name
          AND object.object_key = batch.object_key
          AND object.provider_version = batch.provider_version
        LEFT JOIN storage_gc_candidates candidate
          ON candidate.object_version_id = object.id
        WHERE object.verification_state = 'VERIFIED'
          AND (
            candidate.state IS NULL
            OR candidate.state NOT IN ('DELETING', 'DELETED')
          )
        ORDER BY object.id
        FOR UPDATE OF object
      `;
      const objectByOrdinal = new Map<number, StorageObjectVersion>();
      for (const row of objectRows) {
        objectByOrdinal.set(row.ordinal, toObjectVersion(row));
      }
      const objects = resolved.map(({ entry, intent }, index) => {
        const object = objectByOrdinal.get(index);
        if (intent.state === 'COMMITTED') {
          const recorded = recordedById.get(intent.objectVersionId as string);
          if (
            !recorded ||
            recorded.providerVersion !== entry.providerVersion ||
            recorded.fileIdentifier !== entry.fileIdentifier
          ) {
            throw new Error('Committed storage write intent is immutable');
          }
          return recorded;
        }
        if (!object) {
          throw new Error('Exact storage object version was not returned');
        }
        if (
          object.fileIdentifier !== entry.fileIdentifier ||
          object.sha256 !== intent.expectedSha256 ||
          object.bytes !== intent.expectedBytes ||
          object.contentType !== intent.contentType ||
          object.verificationState !== 'VERIFIED'
        ) {
          throw new Error('Exact storage object conflicts with the write intent');
        }
        return object;
      });
      if (pending.length > 0) {
        const pendingObjects = resolved
          .map((row, index) => ({ ...row, object: objects[index] as StorageObjectVersion }))
          .filter(({ intent }) => intent.state !== 'COMMITTED');
        const committed = await transaction<{ id: string }[]>`
          UPDATE storage_write_intents intent
          SET
            state = 'COMMITTED',
            object_version_id = batch.object_version_id,
            retry_claim_token = NULL,
            retry_claim_expires_at = NULL,
            updated_at = clock_timestamp()
          FROM unnest(
            ${pendingObjects.map(({ intent }) => intent.id)}::uuid[],
            ${pendingObjects.map(({ object }) => object.id)}::uuid[]
          ) AS batch(intent_id, object_version_id)
          WHERE intent.id = batch.intent_id
            AND intent.state IN ('ISSUED', 'UNCERTAIN')
          RETURNING intent.id
        `;
        if (committed.length !== pendingObjects.length) {
          throw new Error('Storage write intent lost commit ownership');
        }
        const canonicalRows = new Map<
          string,
          {
            bytes: number;
            objectVersionId: string;
            sha256: string;
            storageDomain: string;
            storageRole: string;
          }
        >();
        for (const { intent, object } of pendingObjects) {
          if (
            intent.storageDomain &&
            (intent.storageRole === 'common' ||
              intent.storageRole === 'metadata' ||
              intent.storageRole === 'protected')
          ) {
            const key = `${intent.storageRole}\0${intent.storageDomain}\0${intent.expectedSha256}\0${intent.expectedBytes}`;
            canonicalRows.set(key, {
              bytes: intent.expectedBytes,
              objectVersionId: object.id,
              sha256: intent.expectedSha256,
              storageDomain: intent.storageDomain,
              storageRole: intent.storageRole,
            });
          }
        }
        if (canonicalRows.size > 0) {
          const rows = Array.from(canonicalRows.values());
          await transaction`
            INSERT INTO canonical_storage_objects (
              storage_role,
              storage_domain,
              sha256,
              bytes,
              object_version_id
            )
            SELECT
              batch.storage_role,
              batch.storage_domain,
              decode(batch.sha256, 'hex'),
              batch.bytes,
              batch.object_version_id
            FROM unnest(
              ${rows.map((row) => row.storageRole)}::text[],
              ${rows.map((row) => row.storageDomain)}::text[],
              ${rows.map((row) => row.sha256)}::text[],
              ${rows.map((row) => row.bytes)}::bigint[],
              ${rows.map((row) => row.objectVersionId)}::uuid[]
            ) AS batch(storage_role, storage_domain, sha256, bytes, object_version_id)
            ON CONFLICT (storage_role, storage_domain, sha256, bytes)
            DO UPDATE SET
              object_version_id = EXCLUDED.object_version_id,
              updated_at = clock_timestamp()
          `;
        }
      }
      const links = new Map<
        string,
        {
          logicalDigest: string;
          logicalKind: PackageReleaseStorageLogicalKind;
          objectVersionId: string;
        }
      >();
      resolved.forEach(({ entry }, index) => {
        if (!entry.releaseLink) {
          return;
        }
        const object = objects[index] as StorageObjectVersion;
        if (object.sha256 !== entry.releaseLink.logicalDigest) {
          throw new Error(
            'Package release storage link requires one available verified exact object'
          );
        }
        const key = `${entry.releaseLink.logicalKind}\0${entry.releaseLink.logicalDigest}\0${object.id}`;
        links.set(key, {
          logicalDigest: entry.releaseLink.logicalDigest,
          logicalKind: entry.releaseLink.logicalKind,
          objectVersionId: object.id,
        });
      });
      if (links.size > 0) {
        const rows = Array.from(links.values());
        await transaction`
          INSERT INTO package_release_storage_objects (
            package_version_id,
            logical_kind,
            logical_digest,
            object_version_id
          )
          SELECT
            ${packageVersionId as string},
            batch.logical_kind,
            decode(batch.logical_digest, 'hex'),
            batch.object_version_id
          FROM unnest(
            ${rows.map((row) => row.logicalKind)}::text[],
            ${rows.map((row) => row.logicalDigest)}::text[],
            ${rows.map((row) => row.objectVersionId)}::uuid[]
          ) AS batch(logical_kind, logical_digest, object_version_id)
          ON CONFLICT (
            package_version_id,
            logical_kind,
            logical_digest,
            object_version_id
          )
          DO UPDATE SET object_version_id = EXCLUDED.object_version_id
        `;
      }
      // Returning the intent id per row makes result alignment verifiable at the
      // caller instead of an assumed positional contract.
      return resolved.map(({ entry }, index) => ({
        intentId: entry.intentId,
        object: objects[index] as StorageObjectVersion,
      }));
    });
  }
}
