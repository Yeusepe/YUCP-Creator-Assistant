import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CatalogDatabase } from '../catalog';
import {
  type DeliveryGrantV2,
  encodeDeliveryGrantV2,
  encodeMaterializationCapabilityV2,
  encodeMaterializationReceiptV2,
  MATERIALIZATION_CAPABILITY_MAX_LIFETIME_SECONDS,
  type MaterializationCapabilityFileV2,
  type MaterializationJobCapabilityV2,
  type MaterializationReceiptV2,
  type MaterializedFileV2,
  PACKAGE_CONTRACT_PURPOSES,
  signPackageContract,
  validateMaterializationCapabilityV2,
  verifyMaterializationCapabilityV2,
} from '../storage-core/packageContractsV2';
import type { MaterializationKeyBrokerPort } from './keyBrokerClient';
import { type RenditionStoragePort, type RenditionUploadTicket } from './renditionStorage';
import { type DeclaredMaterializedFile, verifyRenditionReadback } from './renditionVerifier';

const SHA256_BYTES = 32;
const MAX_LEASE_DURATION_MS = 60 * 60 * 1_000;
const MIN_LEASE_DURATION_MS = 1_000;
export const DEFAULT_MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MIN_MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS = 60 * 60;
const MAX_MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CreateMaterializationJobInput = {
  bindingRoot: Uint8Array;
  buyerSubjectPseudonym: string;
  creatorId: string;
  encryptedSubjectMapping: Uint8Array;
  grantJti: string;
  id: string;
  keyEpoch: number;
  lane?: 'large' | 'maintenance';
  materializationAlgorithm: string;
  outputFormat: 'overlay' | 'zip';
  pluginVersion: string;
  productId: string;
  protectedFiles: MaterializationCapabilityFileV2[];
  protectedSourceRoot: Uint8Array;
  pseudonymMethod: string;
  releaseRoot: Uint8Array;
  sourceLogicalBytes: number;
  sourceLogicalFiles: number;
  sourceManifestSha256: Uint8Array;
  sourceVersionId: string;
  traceId: string;
};

export type CreateInstallMaterializationJobInput = Omit<
  CreateMaterializationJobInput,
  'buyerSubjectPseudonym' | 'encryptedSubjectMapping' | 'protectedFiles' | 'pseudonymMethod'
> & {
  buyerId: string;
};

export type MaterializationJobStatus =
  | {
      queuePosition: number;
      state: 'MATERIALIZING' | 'QUEUED' | 'VERIFYING';
      status: 'pending';
    }
  | {
      errorCode: string;
      status: 'failed';
    }
  | {
      receipt: string;
      receiptId: string;
      status: 'succeeded';
    };

type StoredProtectedFile = {
  materializerType: string;
  normalizedPath: string;
  required: boolean;
  sourceSha256: string;
};

type MaterializationJobRow = {
  bindingRoot: Buffer;
  buyerSubjectPseudonym: string;
  creatorId: string;
  encryptedSubjectMapping: Buffer | null;
  grantJti: string;
  id: string;
  keyEpoch: number;
  lane: 'large' | 'maintenance';
  leaseExpiresAt: Date;
  leaseGeneration: number;
  leaseOwner: string;
  materializationAlgorithm: string;
  outputFormat: 'overlay' | 'zip';
  pluginVersion: string;
  productId: string;
  protectedFiles: StoredProtectedFile[];
  protectedSourceRoot: Buffer;
  pseudonymMethod: string;
  releaseRoot: Buffer;
  sourceLogicalBytes: number;
  sourceLogicalFiles: number;
  sourceManifestSha256: Buffer;
  sourceVersionId: string;
  state: string;
  traceId: string;
};

export type MaterializationClaimResult =
  | {
      jobId: string;
      leaseExpiresAt: Date;
      leaseGeneration: number;
      status: 'claimed';
    }
  | {
      activeJobId: string;
      queuePosition: number;
      status: 'saturated';
    }
  | {
      status: 'idle';
    };

export type SignedMaterializationCapability = {
  capability: MaterializationJobCapabilityV2;
  coseSign1: Uint8Array;
};

export type ConsumedMaterializationCapability = {
  algorithmVersion: string;
  buyerSubjectPseudonym: string;
  capabilityId: string;
  creatorDomain: string;
  jobId: string;
  keyEpoch: number;
  leaseGeneration: number;
  outputFormat: 'overlay' | 'zip';
  pluginVersion: string;
  protectedFiles: StoredProtectedFile[];
  protectedSourceRoot: string;
  releaseRoot: string;
  sourceTree: {
    grant: string;
    logicalBytes: number;
    logicalFiles: number;
    manifestSha256: string;
    manifestUrl: string;
    versionId: string;
  };
  success: true;
};

export type MaterializationSourceGrantConfig = {
  audience: string;
  baseUrl: string;
  issuer: string;
  keyId: Uint8Array;
  lifetimeSeconds: number;
  privateKey: Uint8Array;
};

export type MaterializationReceiptSigningConfig = {
  keyId: Uint8Array;
  lifetimeSeconds: number;
  privateKey: Uint8Array;
};

export type PreparedRenditionUpload = {
  expiresAt: string;
  upload: RenditionUploadTicket;
  writeIntentId: string;
};

export type CompletedRendition = {
  receipt: string;
  receiptId: string;
  success: true;
};

export type MaterializationAttributionOutput = {
  attributionId: string;
  attributionTokenHash: string;
  normalizedPath: string;
  sourceSha256: string;
};

export type MaterializationAttributionCandidate = {
  algorithmVersion: string;
  attributionId: string;
  attributionTokenHash: string;
  buyerSubjectPseudonym: string;
  capabilityId: string;
  createdAt: number;
  creatorId: string;
  jobId: string;
  keyEpoch: number;
  leaseGeneration: number;
  materializerType: 'fbx' | 'png' | 'zip';
  normalizedPath: string;
  outputFormat: 'zip';
  pluginVersion: string;
  protectedSourceRoot: string;
  releaseRoot: string;
  sourceSha256: string;
};

export type MaterializationAttributionCandidatePage = {
  candidateLimit: number;
  candidates: MaterializationAttributionCandidate[];
  nextCursor?: string;
  truncated: boolean;
};

const MATERIALIZATION_ATTRIBUTION_CANDIDATE_LIMIT = 512;
const MATERIALIZATION_ATTRIBUTION_CURSOR_MAX_BYTES = 2_048;

type MaterializationAttributionCursor = {
  attributionId: string;
  createdAt: number;
  creatorId: string;
  productId: string;
  schemaVersion: 1;
};

function encodeAttributionCursor(cursor: MaterializationAttributionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeAttributionCursor(
  value: string,
  creatorId: string,
  productId: string
): MaterializationAttributionCursor {
  const encoded = requireText(value, 'cursor', MATERIALIZATION_ATTRIBUTION_CURSOR_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('cursor is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('cursor is invalid');
  }
  const cursor = parsed as Record<string, unknown>;
  if (
    Object.keys(cursor).sort().join(',') !==
      'attributionId,createdAt,creatorId,productId,schemaVersion' ||
    cursor.schemaVersion !== 1 ||
    cursor.creatorId !== creatorId ||
    cursor.productId !== productId ||
    typeof cursor.attributionId !== 'string' ||
    !Number.isSafeInteger(cursor.createdAt) ||
    (cursor.createdAt as number) < 0
  ) {
    throw new Error('cursor is invalid');
  }
  const attributionId = requireText(cursor.attributionId, 'cursor attributionId', 512);
  const canonical: MaterializationAttributionCursor = {
    attributionId,
    createdAt: cursor.createdAt as number,
    creatorId,
    productId,
    schemaVersion: 1,
  };
  if (encodeAttributionCursor(canonical) !== encoded) {
    throw new Error('cursor is invalid');
  }
  return canonical;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function requireBytes(value: Uint8Array, name: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== SHA256_BYTES) {
    throw new Error(`${name} must contain 32 bytes`);
  }
  return Buffer.from(value);
}

function requireText(value: string, name: string, maxBytes: number): string {
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > maxBytes) {
    throw new Error(`${name} is invalid`);
  }
  return trimmed;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeProtectedFiles(
  files: readonly MaterializationCapabilityFileV2[]
): StoredProtectedFile[] {
  if (files.length < 1 || files.length > 512) {
    throw new Error('Protected file count must be between 1 and 512');
  }
  return files.map((file, index) => {
    const normalizedPath = requireText(file.normalizedPath, 'normalizedPath', 1_024);
    if (
      normalizedPath !== normalizedPath.normalize('NFC') ||
      normalizedPath.includes('\\') ||
      normalizedPath.startsWith('/') ||
      !/^(Assets|Packages)\//.test(normalizedPath) ||
      normalizedPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error('Protected file path is not a safe normalized Unity path');
    }
    if (index > 0 && compareUtf8(files[index - 1].normalizedPath, normalizedPath) >= 0) {
      throw new Error('Protected files must use strict UTF-8 path order');
    }
    if (typeof file.required !== 'boolean') {
      throw new Error('Protected file required flag must be boolean');
    }
    return {
      materializerType: requireText(file.materializerType, 'materializerType', 128),
      normalizedPath,
      required: file.required,
      sourceSha256: requireBytes(file.sourceSha256, 'sourceSha256').toString('hex'),
    };
  });
}

function restoreProtectedFiles(
  files: readonly StoredProtectedFile[]
): MaterializationCapabilityFileV2[] {
  return files.map((file) => ({
    materializerType: file.materializerType,
    normalizedPath: file.normalizedPath,
    required: file.required,
    sourceSha256: Buffer.from(file.sourceSha256, 'hex'),
  }));
}

function protectedFilesEqual(
  left: readonly StoredProtectedFile[],
  right: readonly StoredProtectedFile[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) =>
        file.materializerType === right[index]?.materializerType &&
        file.normalizedPath === right[index]?.normalizedPath &&
        file.required === right[index]?.required &&
        file.sourceSha256 === right[index]?.sourceSha256
    )
  );
}

function toEpochSeconds(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error('Timestamp is invalid');
  }
  return Math.floor(milliseconds / 1_000);
}

function requireSha256Hex(value: string, name: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must contain a lowercase SHA-256 digest`);
  }
  return Buffer.from(value, 'hex');
}

function normalizeMaterializedFiles(
  files: readonly DeclaredMaterializedFile[]
): MaterializedFileV2[] {
  if (files.length < 1 || files.length > 512) {
    throw new Error('Materialized output file count must be between 1 and 512');
  }
  return files.map((file, index) => {
    const normalizedPath = requireText(file.normalizedPath, 'normalizedPath', 1_024);
    if (
      normalizedPath !== normalizedPath.normalize('NFC') ||
      normalizedPath.includes('\\') ||
      normalizedPath.startsWith('/') ||
      !/^(Assets|Packages)\//.test(normalizedPath) ||
      normalizedPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error('Materialized output path is invalid');
    }
    if (index > 0 && compareUtf8(files[index - 1]?.normalizedPath ?? '', normalizedPath) >= 0) {
      throw new Error('Materialized output files must use strict UTF-8 path order');
    }
    if (!Number.isSafeInteger(file.outputBytes) || file.outputBytes < 0) {
      throw new Error('Materialized output byte length is invalid');
    }
    return {
      attributionId: requireText(file.attributionId, 'attributionId', 512),
      normalizedPath,
      outputBytes: file.outputBytes,
      outputSha256: requireSha256Hex(file.outputSha256, 'outputSha256'),
    };
  });
}

function capabilityMatchesJob(
  capability: MaterializationJobCapabilityV2,
  job: MaterializationJobRow
): boolean {
  const files = restoreProtectedFiles(job.protectedFiles);
  return (
    capability.jobId === job.id &&
    capability.leaseGeneration === job.leaseGeneration &&
    capability.creatorId === job.creatorId &&
    capability.productId === job.productId &&
    capability.buyerSubjectPseudonym === job.buyerSubjectPseudonym &&
    capability.pseudonymMethod === job.pseudonymMethod &&
    bytesEqual(capability.releaseRoot, job.releaseRoot) &&
    bytesEqual(capability.protectedSourceRoot, job.protectedSourceRoot) &&
    capability.keyEpoch === job.keyEpoch &&
    capability.materializationAlgorithm === job.materializationAlgorithm &&
    capability.pluginVersion === job.pluginVersion &&
    capability.outputFormat === job.outputFormat &&
    capability.grantJti === job.grantJti &&
    capability.protectedFiles.length === files.length &&
    capability.protectedFiles.every(
      (file, index) =>
        file.materializerType === files[index]?.materializerType &&
        file.normalizedPath === files[index]?.normalizedPath &&
        file.required === files[index]?.required &&
        bytesEqual(file.sourceSha256, files[index]?.sourceSha256 ?? new Uint8Array())
    )
  );
}

export class MaterializationBroker {
  private readonly keyBroker: MaterializationKeyBrokerPort;
  private readonly receiptSigning: MaterializationReceiptSigningConfig;
  private readonly renditionStorage: RenditionStoragePort;
  private readonly sourceGrant: MaterializationSourceGrantConfig;
  private readonly sql: CatalogDatabase;
  private readonly storageGcPinRetentionSeconds: number;

  constructor(input: {
    keyBroker: MaterializationKeyBrokerPort;
    receiptSigning: MaterializationReceiptSigningConfig;
    renditionStorage: RenditionStoragePort;
    sourceGrant: MaterializationSourceGrantConfig;
    sql: CatalogDatabase;
    storageGcPinRetentionSeconds?: number;
  }) {
    this.keyBroker = input.keyBroker;
    if (
      input.receiptSigning.keyId.byteLength < 1 ||
      input.receiptSigning.keyId.byteLength > 64 ||
      input.receiptSigning.privateKey.byteLength !== 32 ||
      !Number.isSafeInteger(input.receiptSigning.lifetimeSeconds) ||
      input.receiptSigning.lifetimeSeconds < 1 ||
      input.receiptSigning.lifetimeSeconds > 30 * 24 * 60 * 60
    ) {
      throw new Error('Materialization receipt signing configuration is invalid');
    }
    if (!input.renditionStorage.bucketName.trim()) {
      throw new Error('Materialization rendition storage bucket is invalid');
    }
    this.receiptSigning = {
      keyId: Uint8Array.from(input.receiptSigning.keyId),
      lifetimeSeconds: input.receiptSigning.lifetimeSeconds,
      privateKey: Uint8Array.from(input.receiptSigning.privateKey),
    };
    this.renditionStorage = input.renditionStorage;
    const sourceBaseUrl = new URL(input.sourceGrant.baseUrl);
    const sourceIssuer = new URL(input.sourceGrant.issuer);
    const sourceBaseLoopback =
      sourceBaseUrl.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(sourceBaseUrl.hostname);
    const sourceIssuerLoopback =
      sourceIssuer.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(sourceIssuer.hostname);
    if (
      (sourceBaseUrl.protocol !== 'https:' && !sourceBaseLoopback) ||
      sourceBaseUrl.username ||
      sourceBaseUrl.password ||
      sourceBaseUrl.pathname !== '/' ||
      sourceBaseUrl.search ||
      sourceBaseUrl.hash ||
      (sourceIssuer.protocol !== 'https:' && !sourceIssuerLoopback) ||
      sourceIssuer.username ||
      sourceIssuer.password ||
      sourceIssuer.pathname !== '/' ||
      sourceIssuer.search ||
      sourceIssuer.hash
    ) {
      throw new Error('Materialization source grant URL configuration is invalid');
    }
    if (
      !Number.isSafeInteger(input.sourceGrant.lifetimeSeconds) ||
      input.sourceGrant.lifetimeSeconds < 1 ||
      input.sourceGrant.lifetimeSeconds > 15 * 60
    ) {
      throw new Error('Materialization source grant lifetime is invalid');
    }
    if (
      input.sourceGrant.keyId.byteLength < 1 ||
      input.sourceGrant.keyId.byteLength > 64 ||
      input.sourceGrant.privateKey.byteLength !== 32
    ) {
      throw new Error('Materialization source grant signing key is invalid');
    }
    this.sourceGrant = {
      ...input.sourceGrant,
      audience: requireText(input.sourceGrant.audience, 'sourceGrant.audience', 512),
      baseUrl: sourceBaseUrl.toString(),
      issuer: sourceIssuer.origin,
      keyId: Uint8Array.from(input.sourceGrant.keyId),
      privateKey: Uint8Array.from(input.sourceGrant.privateKey),
    };
    const storageGcPinRetentionSeconds =
      input.storageGcPinRetentionSeconds ??
      DEFAULT_MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS;
    if (
      !Number.isSafeInteger(storageGcPinRetentionSeconds) ||
      storageGcPinRetentionSeconds < MIN_MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS ||
      storageGcPinRetentionSeconds > MAX_MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS
    ) {
      throw new Error('Materialization storage GC pin retention is invalid');
    }
    this.storageGcPinRetentionSeconds = storageGcPinRetentionSeconds;
    this.sql = input.sql;
  }

  private async createJob(input: CreateMaterializationJobInput): Promise<void> {
    const protectedFiles = normalizeProtectedFiles(input.protectedFiles);
    const lane = input.lane ?? 'large';
    requireText(input.id, 'jobId', 128);
    requireText(input.creatorId, 'creatorId', 512);
    requireText(input.productId, 'productId', 512);
    requireText(input.buyerSubjectPseudonym, 'buyerSubjectPseudonym', 512);
    requireText(input.pseudonymMethod, 'pseudonymMethod', 128);
    requireText(input.materializationAlgorithm, 'materializationAlgorithm', 512);
    requireText(input.pluginVersion, 'pluginVersion', 512);
    requireText(input.grantJti, 'grantJti', 512);
    requireText(input.traceId, 'traceId', 512);
    if (!UUID_PATTERN.test(requireText(input.sourceVersionId, 'sourceVersionId', 128))) {
      throw new Error('sourceVersionId is invalid');
    }
    if (
      !Number.isSafeInteger(input.sourceLogicalBytes) ||
      input.sourceLogicalBytes < 0 ||
      input.sourceLogicalBytes > 64 * 1024 * 1024 * 1024 ||
      !Number.isSafeInteger(input.sourceLogicalFiles) ||
      input.sourceLogicalFiles < 1 ||
      input.sourceLogicalFiles > 100_000
    ) {
      throw new Error('source logical-tree bounds are invalid');
    }
    if (!Number.isSafeInteger(input.keyEpoch) || input.keyEpoch < 0) {
      throw new Error('keyEpoch is invalid');
    }
    if (
      !(input.encryptedSubjectMapping instanceof Uint8Array) ||
      input.encryptedSubjectMapping.byteLength < 1 ||
      input.encryptedSubjectMapping.byteLength > 16_384
    ) {
      throw new Error('Encrypted attribution subject mapping is invalid');
    }
    type ExistingJob = {
      bindingRoot: Buffer;
      buyerSubjectPseudonym: string;
      creatorId: string;
      grantJti: string;
      keyEpoch: number;
      lane: 'large' | 'maintenance';
      materializationAlgorithm: string;
      outputFormat: 'overlay' | 'zip';
      pluginVersion: string;
      productId: string;
      protectedFiles: StoredProtectedFile[];
      protectedSourceRoot: Buffer;
      pseudonymMethod: string;
      releaseRoot: Buffer;
      sourceLogicalBytes: number;
      sourceLogicalFiles: number;
      sourceManifestSha256: Buffer;
      sourceVersionId: string;
      state: string;
      storageGcPinId: string;
      traceId: string;
    };
    const jobMatches = (job: ExistingJob): boolean =>
      job.buyerSubjectPseudonym === input.buyerSubjectPseudonym &&
      job.creatorId === input.creatorId &&
      job.grantJti === input.grantJti &&
      job.keyEpoch === input.keyEpoch &&
      job.lane === lane &&
      job.materializationAlgorithm === input.materializationAlgorithm &&
      job.outputFormat === input.outputFormat &&
      job.pluginVersion === input.pluginVersion &&
      job.productId === input.productId &&
      protectedFilesEqual(job.protectedFiles, protectedFiles) &&
      job.pseudonymMethod === input.pseudonymMethod &&
      job.sourceLogicalBytes === input.sourceLogicalBytes &&
      job.sourceLogicalFiles === input.sourceLogicalFiles &&
      job.sourceVersionId === input.sourceVersionId &&
      job.traceId === input.traceId &&
      bytesEqual(job.bindingRoot, input.bindingRoot) &&
      bytesEqual(job.protectedSourceRoot, input.protectedSourceRoot) &&
      bytesEqual(job.releaseRoot, input.releaseRoot) &&
      bytesEqual(job.sourceManifestSha256, input.sourceManifestSha256);
    const pinExpiresAt = new Date(Date.now() + this.storageGcPinRetentionSeconds * 1_000);
    await this.sql.begin(async (transaction) => {
      const existing = await transaction<ExistingJob[]>`
        SELECT
          delivery_binding_root AS "bindingRoot",
          buyer_subject_pseudonym AS "buyerSubjectPseudonym",
          creator_id AS "creatorId",
          grant_jti AS "grantJti",
          key_epoch AS "keyEpoch",
          lane,
          materialization_algorithm AS "materializationAlgorithm",
          output_format AS "outputFormat",
          plugin_version AS "pluginVersion",
          product_id AS "productId",
          protected_files AS "protectedFiles",
          protected_source_root AS "protectedSourceRoot",
          pseudonym_method AS "pseudonymMethod",
          release_root AS "releaseRoot",
          source_logical_bytes::float8 AS "sourceLogicalBytes",
          source_logical_files AS "sourceLogicalFiles",
          source_manifest_sha256 AS "sourceManifestSha256",
          source_version_id::text AS "sourceVersionId",
          state,
          storage_gc_pin_id::text AS "storageGcPinId",
          trace_id AS "traceId"
        FROM materialization_jobs
        WHERE id = ${input.id}
        FOR UPDATE
      `;
      const job = existing[0];
      if (job) {
        if (!jobMatches(job)) {
          throw new Error(
            'Materialization job identifier conflicts with different immutable input'
          );
        }
        if (job.state === 'SUCCEEDED' || job.state === 'FAILED') {
          return;
        }
        const reacquired = await transaction<{ pin_id: string }[]>`
          SELECT storage_gc_acquire_release_pin(
            ${randomUUID()},
            ${input.sourceVersionId},
            'materialization-job',
            ${input.id},
            ${pinExpiresAt}
          ) AS pin_id
        `;
        if (reacquired[0]?.pin_id !== job.storageGcPinId) {
          throw new Error('Materialization job storage GC pin binding is invalid');
        }
        return;
      }

      const sources = await transaction<
        {
          bindingRoot: string | null;
          logicalBytes: number;
          logicalFiles: number;
          manifestSha256: string | null;
          packageId: string;
          protectedFiles: StoredProtectedFile[] | null;
          protectedSourceRoot: string | null;
          releaseRoot: string | null;
        }[]
      >`
        SELECT
          binding_root AS "bindingRoot",
          logical_bytes::float8 AS "logicalBytes",
          logical_files AS "logicalFiles",
          manifest_sha256 AS "manifestSha256",
          package_id AS "packageId",
          protected_files AS "protectedFiles",
          protected_source_root AS "protectedSourceRoot",
          release_root AS "releaseRoot"
        FROM package_versions
        WHERE
          id = ${input.sourceVersionId}
          AND state = 'READY'
          AND deleted_at IS NULL
        FOR UPDATE
      `;
      const source = sources[0];
      if (
        !source ||
        source.packageId !== input.productId ||
        source.logicalBytes !== input.sourceLogicalBytes ||
        source.logicalFiles !== input.sourceLogicalFiles ||
        source.bindingRoot !== Buffer.from(input.bindingRoot).toString('hex') ||
        source.protectedSourceRoot !== Buffer.from(input.protectedSourceRoot).toString('hex') ||
        source.releaseRoot !== Buffer.from(input.releaseRoot).toString('hex') ||
        source.manifestSha256 !== Buffer.from(input.sourceManifestSha256).toString('hex') ||
        !source.protectedFiles ||
        !protectedFilesEqual(source.protectedFiles, protectedFiles)
      ) {
        throw new Error(
          'Materialization source does not match the ready canonical package version'
        );
      }
      const acquired = await transaction<{ pin_id: string }[]>`
        SELECT storage_gc_acquire_release_pin(
          ${randomUUID()},
          ${input.sourceVersionId},
          'materialization-job',
          ${input.id},
          ${pinExpiresAt}
        ) AS pin_id
      `;
      const storageGcPinId = acquired[0]?.pin_id;
      if (!storageGcPinId) {
        throw new Error('Materialization job storage GC pin was not acquired');
      }
      const inserted = await transaction<{ id: string }[]>`
        INSERT INTO materialization_jobs (
          id,
          creator_id,
          product_id,
          buyer_subject_pseudonym,
          encrypted_subject_mapping,
          pseudonym_method,
          release_root,
          delivery_binding_root,
          protected_source_root,
          source_version_id,
          source_manifest_sha256,
          source_logical_bytes,
          source_logical_files,
          materialization_algorithm,
          plugin_version,
          output_format,
          key_epoch,
          grant_jti,
          protected_files,
          lane,
          trace_id,
          storage_gc_pin_id
        )
        VALUES (
          ${input.id},
          ${input.creatorId},
          ${input.productId},
          ${input.buyerSubjectPseudonym},
          ${input.encryptedSubjectMapping},
          ${input.pseudonymMethod},
          ${requireBytes(input.releaseRoot, 'releaseRoot')},
          ${requireBytes(input.bindingRoot, 'bindingRoot')},
          ${requireBytes(input.protectedSourceRoot, 'protectedSourceRoot')},
          ${input.sourceVersionId},
          ${requireBytes(input.sourceManifestSha256, 'sourceManifestSha256')},
          ${input.sourceLogicalBytes},
          ${input.sourceLogicalFiles},
          ${input.materializationAlgorithm},
          ${input.pluginVersion},
          ${input.outputFormat},
          ${input.keyEpoch},
          ${input.grantJti},
          ${transaction.json(protectedFiles)},
          ${lane},
          ${input.traceId},
          ${storageGcPinId}
        )
        RETURNING id
      `;
      if (!inserted[0]) {
        throw new Error('Materialization job was not created');
      }
    });
  }

  async createInstallJob(input: CreateInstallMaterializationJobInput): Promise<void> {
    const buyerId = requireText(input.buyerId, 'buyerId', 512);
    const { buyerId: _buyerId, ...jobInput } = input;
    if (!UUID_PATTERN.test(requireText(input.sourceVersionId, 'sourceVersionId', 128))) {
      throw new Error('sourceVersionId is invalid');
    }
    const sources = await this.sql<
      {
        bindingRoot: string | null;
        logicalBytes: number;
        logicalFiles: number;
        manifestSha256: string | null;
        packageId: string;
        protectedFiles: StoredProtectedFile[] | null;
        protectedSourceRoot: string | null;
        releaseRoot: string | null;
      }[]
    >`
      SELECT
        binding_root AS "bindingRoot",
        logical_bytes::float8 AS "logicalBytes",
        logical_files AS "logicalFiles",
        manifest_sha256 AS "manifestSha256",
        package_id AS "packageId",
        protected_files AS "protectedFiles",
        protected_source_root AS "protectedSourceRoot",
        release_root AS "releaseRoot"
      FROM package_versions
      WHERE
        id = ${input.sourceVersionId}
        AND state = 'READY'
        AND deleted_at IS NULL
    `;
    const source = sources[0];
    if (
      !source ||
      source.packageId !== input.productId ||
      source.logicalBytes !== input.sourceLogicalBytes ||
      source.logicalFiles !== input.sourceLogicalFiles ||
      source.bindingRoot !== Buffer.from(input.bindingRoot).toString('hex') ||
      source.protectedSourceRoot !== Buffer.from(input.protectedSourceRoot).toString('hex') ||
      source.releaseRoot !== Buffer.from(input.releaseRoot).toString('hex') ||
      source.manifestSha256 !== Buffer.from(input.sourceManifestSha256).toString('hex') ||
      !source.protectedFiles
    ) {
      throw new Error('Materialization source does not match the ready canonical package version');
    }
    const protectedFiles = restoreProtectedFiles(source.protectedFiles);
    const subject = await this.keyBroker.prepareSubject({
      buyerId,
      creatorId: input.creatorId,
      jobId: input.id,
      keyEpoch: input.keyEpoch,
      productId: input.productId,
    });
    await this.createJob({
      ...jobInput,
      protectedFiles,
      ...subject,
    });
  }

  async getJobStatus(input: {
    grantJti: string;
    jobId: string;
  }): Promise<MaterializationJobStatus> {
    const jobId = requireText(input.jobId, 'jobId', 128);
    const grantJti = requireText(input.grantJti, 'grantJti', 512);
    const rows = await this.sql<
      {
        lastErrorCode: string | null;
        receiptId: string | null;
        signedReceipt: Buffer | null;
        state: string;
      }[]
    >`
      SELECT
        j.state,
        j.last_error_code AS "lastErrorCode",
        r.receipt_id AS "receiptId",
        r.signed_receipt AS "signedReceipt"
      FROM materialization_jobs j
      LEFT JOIN materialization_receipts r ON r.job_id = j.id
      WHERE j.id = ${jobId} AND j.grant_jti = ${grantJti}
    `;
    const job = rows[0];
    if (!job) {
      throw new Error('Materialization job does not exist for this grant');
    }
    if (job.state === 'SUCCEEDED') {
      if (!job.receiptId || !job.signedReceipt) {
        throw new Error('Succeeded materialization job has no durable receipt');
      }
      return {
        receipt: Buffer.from(job.signedReceipt).toString('base64url'),
        receiptId: job.receiptId,
        status: 'succeeded',
      };
    }
    if (job.state === 'FAILED') {
      return {
        errorCode: job.lastErrorCode ?? 'MATERIALIZATION_FAILED',
        status: 'failed',
      };
    }
    if (job.state !== 'QUEUED' && job.state !== 'MATERIALIZING' && job.state !== 'VERIFYING') {
      throw new Error('Materialization job has an invalid durable state');
    }
    const positions = await this.sql<{ position: number }[]>`
      SELECT count(*)::int AS position
      FROM materialization_jobs queued
      JOIN materialization_jobs selected ON selected.id = ${jobId}
      WHERE
        queued.lane = selected.lane
        AND queued.state = 'QUEUED'
        AND (
          queued.created_at < selected.created_at
          OR (queued.created_at = selected.created_at AND queued.id <= selected.id)
        )
    `;
    return {
      queuePosition: job.state === 'QUEUED' ? Math.max(1, positions[0]?.position ?? 1) : 0,
      state: job.state as 'MATERIALIZING' | 'QUEUED' | 'VERIFYING',
      status: 'pending',
    };
  }

  async listAttributionCandidates(input: {
    candidateLimit?: number;
    creatorId: string;
    cursor?: string;
    productId: string;
  }): Promise<MaterializationAttributionCandidatePage> {
    const creatorId = requireText(input.creatorId, 'creatorId', 512);
    const productId = requireText(input.productId, 'productId', 512);
    const candidateLimit = input.candidateLimit ?? MATERIALIZATION_ATTRIBUTION_CANDIDATE_LIMIT;
    if (
      !Number.isSafeInteger(candidateLimit) ||
      candidateLimit < 1 ||
      candidateLimit > MATERIALIZATION_ATTRIBUTION_CANDIDATE_LIMIT
    ) {
      throw new Error('candidateLimit is invalid');
    }
    const cursor = input.cursor
      ? decodeAttributionCursor(input.cursor, creatorId, productId)
      : undefined;
    const cursorCreatedAt = cursor?.createdAt ?? null;
    const cursorAttributionId = cursor?.attributionId ?? null;
    const rows = await this.sql<
      Array<{
        algorithmVersion: string;
        attributionId: string;
        attributionTokenHash: string;
        buyerSubjectPseudonym: string;
        capabilityId: string;
        createdAt: number;
        creatorId: string;
        jobId: string;
        keyEpoch: number;
        leaseGeneration: number;
        materializerType: string;
        normalizedPath: string;
        outputFormat: string;
        pluginVersion: string;
        protectedSourceRoot: string;
        releaseRoot: string;
        sourceSha256: string;
      }>
    >`
      WITH ranked_candidates AS (
        SELECT
          a.algorithm_version AS "algorithmVersion",
          a.attribution_id AS "attributionId",
          encode(a.attribution_token_hash, 'hex') AS "attributionTokenHash",
          j.buyer_subject_pseudonym AS "buyerSubjectPseudonym",
          a.capability_id AS "capabilityId",
          floor(extract(epoch FROM a.created_at) * 1000)::bigint AS "createdAt",
          j.creator_id AS "creatorId",
          j.id AS "jobId",
          a.key_epoch AS "keyEpoch",
          j.lease_generation AS "leaseGeneration",
          protected_file.value->>'materializerType' AS "materializerType",
          a.normalized_path AS "normalizedPath",
          a.output_format AS "outputFormat",
          a.plugin_version AS "pluginVersion",
          encode(j.protected_source_root, 'hex') AS "protectedSourceRoot",
          encode(j.release_root, 'hex') AS "releaseRoot",
          encode(a.source_sha256, 'hex') AS "sourceSha256",
          row_number() OVER (
            PARTITION BY a.attribution_id
            ORDER BY a.created_at DESC, j.id DESC
          ) AS canonical_rank
        FROM materialization_attribution_records a
        JOIN materialization_jobs j ON j.id = a.job_id
        JOIN LATERAL jsonb_array_elements(j.protected_files) protected_file(value)
          ON
            protected_file.value->>'normalizedPath' = a.normalized_path
            AND protected_file.value->>'sourceSha256' = encode(a.source_sha256, 'hex')
        WHERE
          j.creator_id = ${creatorId}
          AND j.product_id = ${productId}
          AND j.state = 'SUCCEEDED'
      )
      SELECT
        "algorithmVersion",
        "attributionId",
        "attributionTokenHash",
        "buyerSubjectPseudonym",
        "capabilityId",
        "createdAt",
        "creatorId",
        "jobId",
        "keyEpoch",
        "leaseGeneration",
        "materializerType",
        "normalizedPath",
        "outputFormat",
        "pluginVersion",
        "protectedSourceRoot",
        "releaseRoot",
        "sourceSha256"
      FROM ranked_candidates
      WHERE
        canonical_rank = 1
        AND (
          ${cursorCreatedAt}::bigint IS NULL
          OR "createdAt" < ${cursorCreatedAt}
          OR (
            "createdAt" = ${cursorCreatedAt}
            AND "attributionId" > ${cursorAttributionId}
          )
        )
      ORDER BY "createdAt" DESC, "attributionId"
      LIMIT ${candidateLimit + 1}
    `;
    const truncated = rows.length > candidateLimit;
    const candidates = rows
      .slice(0, candidateLimit)
      .map((row): MaterializationAttributionCandidate => {
        const createdAt = Math.floor(Number(row.createdAt));
        if (
          (row.materializerType !== 'fbx' &&
            row.materializerType !== 'png' &&
            row.materializerType !== 'zip') ||
          row.outputFormat !== 'zip' ||
          !Number.isSafeInteger(createdAt) ||
          createdAt < 0
        ) {
          throw new Error('Durable materialization attribution record has an invalid format');
        }
        return {
          ...row,
          createdAt,
          materializerType: row.materializerType,
          outputFormat: row.outputFormat,
        };
      });
    const lastCandidate = candidates.at(-1);
    return {
      candidateLimit,
      candidates,
      ...(truncated && lastCandidate
        ? {
            nextCursor: encodeAttributionCursor({
              attributionId: lastCandidate.attributionId,
              createdAt: lastCandidate.createdAt,
              creatorId,
              productId,
              schemaVersion: 1,
            }),
          }
        : {}),
      truncated,
    };
  }

  private async failJob(input: {
    errorCode: string;
    jobId: string;
    leaseGeneration: number;
    leaseOwner: string;
  }): Promise<void> {
    if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration < 1) {
      throw new Error('leaseGeneration is invalid');
    }
    await this.sql.begin(async (transaction) => {
      const rows = await transaction<{ id: string; storageGcPinId: string }[]>`
        UPDATE materialization_jobs
        SET
          state = 'FAILED',
          last_error_code = ${requireText(input.errorCode, 'errorCode', 128)},
          lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          updated_at = clock_timestamp()
        WHERE
          id = ${requireText(input.jobId, 'jobId', 128)}
          AND lease_owner = ${requireText(input.leaseOwner, 'leaseOwner', 512)}
          AND lease_generation = ${input.leaseGeneration}
          AND state IN ('MATERIALIZING', 'VERIFYING')
        RETURNING id, storage_gc_pin_id::text AS "storageGcPinId"
      `;
      const failed = rows[0];
      if (!failed) {
        throw new Error('Materialization failure fence is stale');
      }
      const released = await transaction<{ id: string }[]>`
        UPDATE storage_gc_release_pins
        SET
          released_at = COALESCE(released_at, clock_timestamp()),
          updated_at = clock_timestamp()
        WHERE id = ${failed.storageGcPinId}
        RETURNING id
      `;
      if (!released[0]) {
        throw new Error('Materialization failure lost its storage GC pin');
      }
    });
  }

  async failCapabilityJob(input: {
    capabilityId: string;
    coseSign1: Uint8Array;
    errorCode: string;
    jobId: string;
    leaseGeneration: number;
    materializerId: string;
    now?: Date;
    proofJti: string;
    verifiedProofKeyThumbprint: Uint8Array;
  }): Promise<void> {
    const now = input.now ?? new Date();
    await this.consumeMaterializerProof({
      capabilityId: requireText(input.capabilityId, 'capabilityId', 128),
      coseSign1: input.coseSign1,
      materializerId: requireText(input.materializerId, 'materializerId', 512),
      now,
      proofJti: input.proofJti,
      verifiedProofKeyThumbprint: input.verifiedProofKeyThumbprint,
    });
    await this.failJob({
      errorCode: input.errorCode,
      jobId: input.jobId,
      leaseGeneration: input.leaseGeneration,
      leaseOwner: input.materializerId,
    });
  }

  async claimNextJob(input: {
    lane?: 'large' | 'maintenance';
    leaseDurationMs: number;
    leaseOwner: string;
    now?: Date;
  }): Promise<MaterializationClaimResult> {
    const lane = input.lane ?? 'large';
    const leaseOwner = requireText(input.leaseOwner, 'leaseOwner', 512);
    const now = input.now ?? new Date();
    if (
      !Number.isSafeInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < MIN_LEASE_DURATION_MS ||
      input.leaseDurationMs > MAX_LEASE_DURATION_MS
    ) {
      throw new Error('Lease duration is outside the permitted range');
    }
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
    return this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE materialization_jobs
        SET
          state = 'QUEUED',
          lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          last_error_code = 'MATERIALIZATION_LEASE_EXPIRED',
          updated_at = ${now}
        WHERE
          lane = ${lane}
          AND state IN ('MATERIALIZING', 'VERIFYING')
          AND lease_expires_at <= ${now}
      `;
      await transaction`
        UPDATE storage_gc_release_pins pin
        SET
          expires_at = ${new Date(now.getTime() + this.storageGcPinRetentionSeconds * 1_000)},
          updated_at = ${now}
        FROM materialization_jobs job
        WHERE job.storage_gc_pin_id = pin.id
          AND job.lane = ${lane}
          AND job.state IN ('QUEUED', 'MATERIALIZING', 'VERIFYING')
          AND pin.released_at IS NULL
      `;
      const active = await transaction<{ id: string }[]>`
        SELECT id
        FROM materialization_jobs
        WHERE
          lease_owner = ${leaseOwner}
          AND lane = ${lane}
          AND state IN ('MATERIALIZING', 'VERIFYING')
          AND lease_expires_at > ${now}
        ORDER BY created_at, id
        LIMIT 1
      `;
      if (active[0]) {
        const queued = await transaction<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM materialization_jobs
          WHERE lane = ${lane} AND state = 'QUEUED'
        `;
        return {
          activeJobId: active[0].id,
          queuePosition: Math.max(1, queued[0]?.count ?? 1),
          status: 'saturated' as const,
        };
      }
      const next = await transaction<{ id: string }[]>`
        SELECT id
        FROM materialization_jobs
        WHERE lane = ${lane} AND state = 'QUEUED'
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      if (!next[0]) {
        return { status: 'idle' as const };
      }
      const updated = await transaction<
        { id: string; lease_expires_at: Date; lease_generation: number }[]
      >`
        UPDATE materialization_jobs
        SET
          state = 'MATERIALIZING',
          lease_owner = ${leaseOwner},
          lease_generation = lease_generation + 1,
          lease_expires_at = ${leaseExpiresAt},
          heartbeat_at = ${now},
          attempts = attempts + 1,
          updated_at = ${now}
        WHERE id = ${next[0].id} AND state = 'QUEUED'
        RETURNING id, lease_generation, lease_expires_at
      `;
      if (!updated[0]) {
        throw new Error('The materialization claim lost its database fence');
      }
      return {
        jobId: updated[0].id,
        leaseExpiresAt: new Date(updated[0].lease_expires_at),
        leaseGeneration: updated[0].lease_generation,
        status: 'claimed' as const,
      };
    });
  }

  async renewClaimLease(input: {
    jobId: string;
    leaseDurationMs: number;
    leaseGeneration: number;
    leaseOwner: string;
    now?: Date;
  }): Promise<{
    jobId: string;
    leaseExpiresAt: Date;
    leaseGeneration: number;
    status: 'renewed';
  }> {
    const jobId = requireText(input.jobId, 'jobId', 128);
    const leaseOwner = requireText(input.leaseOwner, 'leaseOwner', 512);
    const now = input.now ?? new Date();
    if (
      !Number.isSafeInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < MIN_LEASE_DURATION_MS ||
      input.leaseDurationMs > MAX_LEASE_DURATION_MS ||
      !Number.isSafeInteger(input.leaseGeneration) ||
      input.leaseGeneration < 1
    ) {
      throw new Error('Lease renewal fence is invalid');
    }
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
    const pinExpiresAt = new Date(now.getTime() + this.storageGcPinRetentionSeconds * 1_000);
    const renewed = await this.sql<
      {
        id: string;
        lease_expires_at: Date;
        lease_generation: number;
        storage_gc_pin_id: string;
      }[]
    >`
      UPDATE materialization_jobs
      SET
        lease_expires_at = ${leaseExpiresAt},
        heartbeat_at = ${now},
        updated_at = ${now}
      WHERE
        id = ${jobId}
        AND lease_owner = ${leaseOwner}
        AND lease_generation = ${input.leaseGeneration}
        AND lease_expires_at > ${now}
        AND state IN ('MATERIALIZING', 'VERIFYING')
      RETURNING id, lease_expires_at, lease_generation, storage_gc_pin_id
    `;
    const row = renewed[0];
    if (!row) {
      throw new Error('Materialization lease renewal fence is stale');
    }
    const pinned = await this.sql<{ id: string }[]>`
      UPDATE storage_gc_release_pins
      SET
        expires_at = GREATEST(expires_at, ${pinExpiresAt}),
        updated_at = ${now}
      WHERE id = ${row.storage_gc_pin_id} AND released_at IS NULL
      RETURNING id
    `;
    if (!pinned[0]) {
      throw new Error('Materialization lease renewal lost its storage GC pin');
    }
    return {
      jobId: row.id,
      leaseExpiresAt: new Date(row.lease_expires_at),
      leaseGeneration: row.lease_generation,
      status: 'renewed',
    };
  }

  async issueCapability(input: {
    jobId: string;
    keyId: Uint8Array;
    leaseGeneration: number;
    leaseOwner: string;
    lifetimeSeconds: number;
    now?: Date;
    privateKey: Uint8Array;
    proofKeyThumbprint: Uint8Array;
  }): Promise<SignedMaterializationCapability> {
    const now = input.now ?? new Date();
    if (
      !Number.isSafeInteger(input.lifetimeSeconds) ||
      input.lifetimeSeconds < 1 ||
      input.lifetimeSeconds > MATERIALIZATION_CAPABILITY_MAX_LIFETIME_SECONDS
    ) {
      throw new Error('Capability lifetime is outside the permitted range');
    }
    const expiresAt = new Date(now.getTime() + input.lifetimeSeconds * 1_000);
    const capabilityId = randomUUID();
    const nonce = randomBytes(SHA256_BYTES);
    const proofKeyThumbprint = requireBytes(input.proofKeyThumbprint, 'proofKeyThumbprint');
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<MaterializationJobRow[]>`
        SELECT
          id,
          creator_id AS "creatorId",
          product_id AS "productId",
          buyer_subject_pseudonym AS "buyerSubjectPseudonym",
          encrypted_subject_mapping AS "encryptedSubjectMapping",
          pseudonym_method AS "pseudonymMethod",
          release_root AS "releaseRoot",
          delivery_binding_root AS "bindingRoot",
          protected_source_root AS "protectedSourceRoot",
          source_version_id::text AS "sourceVersionId",
          source_manifest_sha256 AS "sourceManifestSha256",
          source_logical_bytes::float8 AS "sourceLogicalBytes",
          source_logical_files AS "sourceLogicalFiles",
          materialization_algorithm AS "materializationAlgorithm",
          plugin_version AS "pluginVersion",
          output_format AS "outputFormat",
          key_epoch AS "keyEpoch",
          grant_jti AS "grantJti",
          protected_files AS "protectedFiles",
          lane,
          state,
          lease_owner AS "leaseOwner",
          lease_generation AS "leaseGeneration",
          lease_expires_at AS "leaseExpiresAt",
          trace_id AS "traceId"
        FROM materialization_jobs
        WHERE id = ${input.jobId}
        FOR UPDATE
      `;
      const job = rows[0];
      if (!job) {
        throw new Error('Materialization job does not exist');
      }
      if (
        job.state !== 'MATERIALIZING' ||
        job.leaseOwner !== input.leaseOwner ||
        job.leaseGeneration !== input.leaseGeneration ||
        new Date(job.leaseExpiresAt).getTime() <= expiresAt.getTime()
      ) {
        throw new Error('Materialization job lease is stale or too short');
      }
      const capability: MaterializationJobCapabilityV2 = {
        buyerSubjectPseudonym: job.buyerSubjectPseudonym,
        capabilityId,
        creatorId: job.creatorId,
        expiresAt: toEpochSeconds(expiresAt),
        grantJti: job.grantJti,
        issuedAt: toEpochSeconds(now),
        jobId: job.id,
        keyEpoch: job.keyEpoch,
        leaseGeneration: job.leaseGeneration,
        materializationAlgorithm: job.materializationAlgorithm,
        oneUseNonce: nonce,
        outputFormat: job.outputFormat,
        pluginVersion: job.pluginVersion,
        productId: job.productId,
        proofKeyThumbprint,
        protectedFiles: restoreProtectedFiles(job.protectedFiles),
        protectedSourceRoot: job.protectedSourceRoot,
        pseudonymMethod: job.pseudonymMethod,
        releaseRoot: job.releaseRoot,
      };
      validateMaterializationCapabilityV2(capability);
      const signed = await signPackageContract({
        keyId: input.keyId,
        payload: encodeMaterializationCapabilityV2(capability),
        privateKey: input.privateKey,
        purpose: 'materialization-capability-v2',
      });
      const signedDigest = createHash('sha256').update(signed.coseSign1).digest();
      await transaction`
        INSERT INTO materialization_capabilities (
          capability_id,
          job_id,
          lease_generation,
          one_use_nonce,
          proof_key_thumbprint,
          signed_capability_sha256,
          issued_at,
          expires_at,
          trace_id
        )
        VALUES (
          ${capabilityId},
          ${job.id},
          ${job.leaseGeneration},
          ${nonce},
          ${proofKeyThumbprint},
          ${signedDigest},
          ${now},
          ${expiresAt},
          ${job.traceId}
        )
      `;
      return { capability, coseSign1: signed.coseSign1 };
    });
  }

  private async consumeMaterializerProof(input: {
    capabilityId: string;
    coseSign1: Uint8Array;
    materializerId: string;
    now: Date;
    proofJti: string;
    verifiedProofKeyThumbprint: Uint8Array;
  }): Promise<void> {
    const signedDigest = createHash('sha256').update(input.coseSign1).digest();
    const proofKeyThumbprint = requireBytes(
      input.verifiedProofKeyThumbprint,
      'verifiedProofKeyThumbprint'
    );
    await this.sql.begin(async (transaction) => {
      const rows = await transaction<
        {
          consumedBy: string | null;
          expiresAt: Date;
          proofKeyThumbprint: Buffer;
          signedSha256: Buffer;
        }[]
      >`
        SELECT
          consumed_by AS "consumedBy",
          expires_at AS "expiresAt",
          proof_key_thumbprint AS "proofKeyThumbprint",
          signed_capability_sha256 AS "signedSha256"
        FROM materialization_capabilities
        WHERE capability_id = ${input.capabilityId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (
        !row ||
        row.consumedBy !== input.materializerId ||
        new Date(row.expiresAt).getTime() <= input.now.getTime() ||
        !bytesEqual(row.proofKeyThumbprint, proofKeyThumbprint) ||
        !bytesEqual(row.signedSha256, signedDigest)
      ) {
        throw new Error('Materializer proof does not match its durable capability');
      }
      await transaction`
        INSERT INTO materialization_dpop_proofs (
          proof_key_thumbprint,
          proof_jti,
          capability_id,
          expires_at,
          consumed_at
        )
        VALUES (
          ${proofKeyThumbprint},
          ${requireText(input.proofJti, 'proofJti', 128)},
          ${input.capabilityId},
          ${row.expiresAt},
          ${input.now}
        )
      `;
    });
  }

  async consumeCapability(input: {
    coseSign1: Uint8Array;
    expectedKeyId?: Uint8Array;
    materializerId: string;
    now?: Date;
    publicKey: Uint8Array;
    proofJti: string;
    traceId: string;
    verifiedProofKeyThumbprint: Uint8Array;
  }): Promise<ConsumedMaterializationCapability> {
    const now = input.now ?? new Date();
    const materializerId = requireText(input.materializerId, 'materializerId', 512);
    const proofJti = requireText(input.proofJti, 'proofJti', 128);
    requireText(input.traceId, 'traceId', 512);
    const capability = await verifyMaterializationCapabilityV2({
      coseSign1: input.coseSign1,
      expectedKeyId: input.expectedKeyId,
      publicKey: input.publicKey,
    });
    if (!bytesEqual(capability.proofKeyThumbprint, input.verifiedProofKeyThumbprint)) {
      throw new Error('Capability proof key does not match');
    }
    const signedDigest = createHash('sha256').update(input.coseSign1).digest();
    const nowSeconds = toEpochSeconds(now);
    if (capability.issuedAt > nowSeconds || capability.expiresAt <= nowSeconds) {
      throw new Error('Materialization capability is not active');
    }

    const durableJob = await this.sql.begin(async (transaction) => {
      const rows = await transaction<
        (MaterializationJobRow & {
          capabilityConsumedAt: Date | null;
          capabilityExpiresAt: Date;
          capabilityProofKeyThumbprint: Buffer;
          capabilitySignedSha256: Buffer;
        })[]
      >`
        SELECT
          j.id,
          j.creator_id AS "creatorId",
          j.product_id AS "productId",
          j.buyer_subject_pseudonym AS "buyerSubjectPseudonym",
          j.encrypted_subject_mapping AS "encryptedSubjectMapping",
          j.pseudonym_method AS "pseudonymMethod",
          j.release_root AS "releaseRoot",
          j.delivery_binding_root AS "bindingRoot",
          j.protected_source_root AS "protectedSourceRoot",
          j.source_version_id::text AS "sourceVersionId",
          j.source_manifest_sha256 AS "sourceManifestSha256",
          j.source_logical_bytes::float8 AS "sourceLogicalBytes",
          j.source_logical_files AS "sourceLogicalFiles",
          j.materialization_algorithm AS "materializationAlgorithm",
          j.plugin_version AS "pluginVersion",
          j.output_format AS "outputFormat",
          j.key_epoch AS "keyEpoch",
          j.grant_jti AS "grantJti",
          j.protected_files AS "protectedFiles",
          j.lane,
          j.state,
          j.lease_owner AS "leaseOwner",
          j.lease_generation AS "leaseGeneration",
          j.lease_expires_at AS "leaseExpiresAt",
          j.trace_id AS "traceId",
          c.consumed_at AS "capabilityConsumedAt",
          c.expires_at AS "capabilityExpiresAt",
          c.proof_key_thumbprint AS "capabilityProofKeyThumbprint",
          c.signed_capability_sha256 AS "capabilitySignedSha256"
        FROM materialization_capabilities c
        JOIN materialization_jobs j ON j.id = c.job_id
        WHERE c.capability_id = ${capability.capabilityId}
        FOR UPDATE OF c, j
      `;
      const row = rows[0];
      if (!row) {
        throw new Error('Materialization capability is not registered');
      }
      if (row.capabilityConsumedAt) {
        throw new Error('Materialization capability was already consumed');
      }
      if (
        row.state !== 'MATERIALIZING' ||
        row.leaseOwner !== materializerId ||
        row.leaseGeneration !== capability.leaseGeneration ||
        new Date(row.leaseExpiresAt).getTime() <= now.getTime() ||
        new Date(row.capabilityExpiresAt).getTime() <= now.getTime()
      ) {
        throw new Error('Materialization capability lease is stale');
      }
      if (
        !bytesEqual(row.capabilityProofKeyThumbprint, input.verifiedProofKeyThumbprint) ||
        !bytesEqual(row.capabilitySignedSha256, signedDigest) ||
        !capabilityMatchesJob(capability, row)
      ) {
        throw new Error('Materialization capability does not match durable job state');
      }
      await transaction`
        INSERT INTO materialization_dpop_proofs (
          proof_key_thumbprint,
          proof_jti,
          capability_id,
          expires_at,
          consumed_at
        )
        VALUES (
          ${input.verifiedProofKeyThumbprint},
          ${proofJti},
          ${capability.capabilityId},
          ${new Date(capability.expiresAt * 1_000)},
          ${now}
        )
      `;
      const updated = await transaction<{ capability_id: string }[]>`
        UPDATE materialization_capabilities
        SET
          consumed_at = ${now},
          consumed_by = ${materializerId}
        WHERE capability_id = ${capability.capabilityId} AND consumed_at IS NULL
        RETURNING capability_id
      `;
      if (!updated[0]) {
        throw new Error('Materialization capability was already consumed');
      }
      return row;
    });

    const sourceGrantId = randomUUID();
    const sourceGrantIssuedAt = nowSeconds;
    const sourceGrantExpiresAt = Math.min(
      capability.expiresAt,
      sourceGrantIssuedAt + this.sourceGrant.lifetimeSeconds
    );
    const sourceScope = `materialization-source:${durableJob.sourceVersionId}`;
    const sourceGrant: DeliveryGrantV2 = {
      audience: this.sourceGrant.audience,
      bindingRoot: durableJob.bindingRoot,
      buyerId: materializerId,
      creatorId: capability.creatorId,
      deviceKeyThumbprint: capability.proofKeyThumbprint,
      expiresAt: sourceGrantExpiresAt,
      grantId: sourceGrantId,
      installSessionId: capability.jobId,
      issuedAt: sourceGrantIssuedAt,
      issuer: this.sourceGrant.issuer,
      notBefore: sourceGrantIssuedAt,
      productId: capability.productId,
      releaseRoot: capability.releaseRoot,
      scopes: [sourceScope],
    };
    const signedSourceGrant = await signPackageContract({
      keyId: this.sourceGrant.keyId,
      payload: encodeDeliveryGrantV2(sourceGrant),
      privateKey: this.sourceGrant.privateKey,
      purpose: PACKAGE_CONTRACT_PURPOSES.deliveryGrant,
    });
    await this.sql`
      INSERT INTO materialization_source_grants (
        grant_id,
        job_id,
        lease_generation,
        source_version_id,
        proof_key_thumbprint,
        signed_grant_sha256,
        issued_at,
        expires_at,
        trace_id
      )
      VALUES (
        ${sourceGrantId},
        ${capability.jobId},
        ${capability.leaseGeneration},
        ${durableJob.sourceVersionId},
        ${capability.proofKeyThumbprint},
        ${createHash('sha256').update(signedSourceGrant.coseSign1).digest()},
        ${new Date(sourceGrantIssuedAt * 1_000)},
        ${new Date(sourceGrantExpiresAt * 1_000)},
        ${durableJob.traceId}
      )
    `;
    const sourceManifestUrl = new URL(
      `/v2/internal/materialization-sources/${encodeURIComponent(durableJob.sourceVersionId)}/manifest`,
      this.sourceGrant.baseUrl
    );
    return {
      algorithmVersion: capability.materializationAlgorithm,
      buyerSubjectPseudonym: capability.buyerSubjectPseudonym,
      capabilityId: capability.capabilityId,
      creatorDomain: capability.creatorId,
      jobId: capability.jobId,
      keyEpoch: capability.keyEpoch,
      leaseGeneration: capability.leaseGeneration,
      outputFormat: capability.outputFormat,
      pluginVersion: capability.pluginVersion,
      protectedFiles: normalizeProtectedFiles(capability.protectedFiles),
      protectedSourceRoot: Buffer.from(capability.protectedSourceRoot).toString('hex'),
      releaseRoot: Buffer.from(capability.releaseRoot).toString('hex'),
      sourceTree: {
        grant: Buffer.from(signedSourceGrant.coseSign1).toString('base64url'),
        logicalBytes: durableJob.sourceLogicalBytes,
        logicalFiles: durableJob.sourceLogicalFiles,
        manifestSha256: Buffer.from(durableJob.sourceManifestSha256).toString('hex'),
        manifestUrl: sourceManifestUrl.toString(),
        versionId: durableJob.sourceVersionId,
      },
      success: true,
    };
  }

  async prepareRenditionUpload(input: {
    bytes: number;
    capabilityId: string;
    coseSign1: Uint8Array;
    jobId: string;
    leaseGeneration: number;
    materializerId: string;
    now?: Date;
    proofJti: string;
    sha256: string;
    traceId: string;
    verifiedProofKeyThumbprint: Uint8Array;
  }): Promise<PreparedRenditionUpload> {
    const now = input.now ?? new Date();
    const materializerId = requireText(input.materializerId, 'materializerId', 512);
    const capabilityId = requireText(input.capabilityId, 'capabilityId', 128);
    const jobId = requireText(input.jobId, 'jobId', 128);
    requireText(input.traceId, 'traceId', 512);
    const expectedSha256 = requireSha256Hex(input.sha256, 'rendition sha256');
    if (
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > 5 * 1024 ** 3 ||
      !Number.isSafeInteger(input.leaseGeneration) ||
      input.leaseGeneration < 1
    ) {
      throw new Error('Rendition upload request is invalid');
    }
    await this.consumeMaterializerProof({
      capabilityId,
      coseSign1: input.coseSign1,
      materializerId,
      now,
      proofJti: input.proofJti,
      verifiedProofKeyThumbprint: input.verifiedProofKeyThumbprint,
    });

    const durable = await this.sql.begin(async (transaction) => {
      const existing = await transaction<
        {
          bucketName: string;
          expectedBytes: number;
          expectedSha256: Buffer;
          expiresAt: Date;
          id: string;
          objectKey: string;
          state: string;
        }[]
      >`
        SELECT
          id::text,
          bucket_name AS "bucketName",
          object_key AS "objectKey",
          expected_sha256 AS "expectedSha256",
          expected_bytes::float8 AS "expectedBytes",
          state,
          expires_at AS "expiresAt"
        FROM materialization_rendition_write_intents
        WHERE job_id = ${jobId} AND lease_generation = ${input.leaseGeneration}
        FOR UPDATE
      `;
      if (existing[0]) {
        if (
          existing[0].state !== 'ISSUED' ||
          existing[0].bucketName !== this.renditionStorage.bucketName ||
          existing[0].expectedBytes !== input.bytes ||
          !bytesEqual(existing[0].expectedSha256, expectedSha256) ||
          new Date(existing[0].expiresAt).getTime() <= now.getTime()
        ) {
          throw new Error('Existing rendition write intent does not match this request');
        }
        return existing[0];
      }

      const rows = await transaction<
        {
          capabilityConsumedAt: Date | null;
          capabilityConsumedBy: string | null;
          capabilityId: string;
          encryptedSubjectMapping: Buffer | null;
          jobId: string;
          leaseExpiresAt: Date;
          leaseGeneration: number;
          leaseOwner: string;
          state: string;
        }[]
      >`
        SELECT
          j.id AS "jobId",
          j.state,
          j.lease_owner AS "leaseOwner",
          j.lease_generation AS "leaseGeneration",
          j.lease_expires_at AS "leaseExpiresAt",
          j.encrypted_subject_mapping AS "encryptedSubjectMapping",
          c.capability_id AS "capabilityId",
          c.consumed_at AS "capabilityConsumedAt",
          c.consumed_by AS "capabilityConsumedBy"
        FROM materialization_jobs j
        JOIN materialization_capabilities c ON c.job_id = j.id
        WHERE j.id = ${jobId} AND c.capability_id = ${capabilityId}
        FOR UPDATE OF j, c
      `;
      const row = rows[0];
      if (
        !row ||
        row.state !== 'MATERIALIZING' ||
        row.leaseOwner !== materializerId ||
        row.leaseGeneration !== input.leaseGeneration ||
        new Date(row.leaseExpiresAt).getTime() <= now.getTime() ||
        !row.capabilityConsumedAt ||
        row.capabilityConsumedBy !== materializerId ||
        !row.encryptedSubjectMapping
      ) {
        throw new Error('Rendition upload fence is stale or incomplete');
      }
      const expiresAt = new Date(
        Math.min(new Date(row.leaseExpiresAt).getTime(), now.getTime() + 5 * 60 * 1_000)
      );
      if (expiresAt.getTime() <= now.getTime()) {
        throw new Error('Rendition upload lease has expired');
      }
      const id = randomUUID();
      const objectKey = `v2/renditions/${id.slice(0, 2)}/${id}.zip`;
      await transaction`
        INSERT INTO materialization_rendition_write_intents (
          id,
          job_id,
          capability_id,
          lease_generation,
          bucket_name,
          object_key,
          expected_sha256,
          expected_bytes,
          issued_at,
          expires_at,
          trace_id
        )
        VALUES (
          ${id},
          ${jobId},
          ${capabilityId},
          ${input.leaseGeneration},
          ${this.renditionStorage.bucketName},
          ${objectKey},
          ${expectedSha256},
          ${input.bytes},
          ${now},
          ${expiresAt},
          ${input.traceId}
        )
      `;
      const updated = await transaction<{ id: string }[]>`
        UPDATE materialization_jobs
        SET state = 'VERIFYING', updated_at = ${now}
        WHERE
          id = ${jobId}
          AND state = 'MATERIALIZING'
          AND lease_owner = ${materializerId}
          AND lease_generation = ${input.leaseGeneration}
          AND lease_expires_at > ${now}
        RETURNING id
      `;
      if (!updated[0]) {
        throw new Error('Rendition upload lost its durable job fence');
      }
      return {
        bucketName: this.renditionStorage.bucketName,
        expectedBytes: input.bytes,
        expectedSha256,
        expiresAt,
        id,
        objectKey,
        state: 'ISSUED',
      };
    });

    const lifetimeSeconds = Math.max(
      1,
      Math.min(300, Math.floor((new Date(durable.expiresAt).getTime() - now.getTime()) / 1_000))
    );
    const upload = await this.renditionStorage.createUploadTicket({
      bytes: durable.expectedBytes,
      expiresSeconds: lifetimeSeconds,
      objectKey: durable.objectKey,
      now,
      sha256Hex: Buffer.from(durable.expectedSha256).toString('hex'),
    });
    if (
      upload.bucketName !== durable.bucketName ||
      upload.objectKey !== durable.objectKey ||
      upload.storageRole !== 'renditions'
    ) {
      throw new Error('Rendition storage port returned an invalid upload ticket');
    }
    return {
      expiresAt: new Date(durable.expiresAt).toISOString(),
      upload,
      writeIntentId: durable.id,
    };
  }

  async completeRendition(input: {
    attributionRecords: readonly MaterializationAttributionOutput[];
    builds: {
      codec: string;
      helper: string;
      runtime: string;
    };
    capabilityId: string;
    coseSign1: Uint8Array;
    jobId: string;
    leaseGeneration: number;
    materializerId: string;
    now?: Date;
    outputFiles: readonly DeclaredMaterializedFile[];
    outputTreeRoot: string;
    providerVersion: string;
    proofJti: string;
    traceId: string;
    verifiedProofKeyThumbprint: Uint8Array;
    writeIntentId: string;
  }): Promise<CompletedRendition> {
    const now = input.now ?? new Date();
    const materializerId = requireText(input.materializerId, 'materializerId', 512);
    const jobId = requireText(input.jobId, 'jobId', 128);
    const capabilityId = requireText(input.capabilityId, 'capabilityId', 128);
    const writeIntentId = requireText(input.writeIntentId, 'writeIntentId', 128);
    const providerVersion = requireText(input.providerVersion, 'providerVersion', 512);
    requireText(input.traceId, 'traceId', 512);
    const outputFiles = normalizeMaterializedFiles(input.outputFiles);
    const declaredOutputTreeRoot = requireSha256Hex(input.outputTreeRoot, 'outputTreeRoot');
    const builds = {
      codec: requireText(input.builds.codec, 'codecBuild', 512),
      helper: requireText(input.builds.helper, 'helperBuild', 512),
      runtime: requireText(input.builds.runtime, 'runtimeBuild', 512),
    };
    await this.consumeMaterializerProof({
      capabilityId,
      coseSign1: input.coseSign1,
      materializerId,
      now,
      proofJti: input.proofJti,
      verifiedProofKeyThumbprint: input.verifiedProofKeyThumbprint,
    });

    const existingReceiptIds = await this.sql<{ receipt_id: string }[]>`
      SELECT receipt_id
      FROM materialization_receipts
      WHERE job_id = ${jobId}
    `;
    if (existingReceiptIds[0]) {
      const existingReceipt = await this.sql<
        {
          capabilityId: string;
          consumedBy: string;
          providerVersion: string;
          receiptId: string;
          signedReceipt: Buffer;
          writeIntentId: string;
        }[]
      >`
        SELECT
          r.receipt_id AS "receiptId",
          r.capability_id AS "capabilityId",
          r.rendition_write_intent_id::text AS "writeIntentId",
          r.provider_version AS "providerVersion",
          r.signed_receipt AS "signedReceipt",
          c.consumed_by AS "consumedBy"
        FROM materialization_receipts r
        JOIN materialization_capabilities c ON c.capability_id = r.capability_id
        WHERE r.receipt_id = ${existingReceiptIds[0].receipt_id}
      `;
      if (!existingReceipt[0]) {
        throw new Error('Completed rendition receipt disappeared');
      }
      if (
        existingReceipt[0].capabilityId !== capabilityId ||
        existingReceipt[0].writeIntentId !== writeIntentId ||
        existingReceipt[0].providerVersion !== providerVersion ||
        existingReceipt[0].consumedBy !== materializerId
      ) {
        throw new Error('Completed rendition does not match this request');
      }
      return {
        receipt: Buffer.from(existingReceipt[0].signedReceipt).toString('base64url'),
        receiptId: existingReceipt[0].receiptId,
        success: true,
      };
    }

    const jobRows = await this.sql<MaterializationJobRow[]>`
      SELECT
        id,
        creator_id AS "creatorId",
        product_id AS "productId",
        buyer_subject_pseudonym AS "buyerSubjectPseudonym",
        encrypted_subject_mapping AS "encryptedSubjectMapping",
        pseudonym_method AS "pseudonymMethod",
        release_root AS "releaseRoot",
        delivery_binding_root AS "bindingRoot",
        protected_source_root AS "protectedSourceRoot",
        source_version_id::text AS "sourceVersionId",
        source_manifest_sha256 AS "sourceManifestSha256",
        source_logical_bytes::float8 AS "sourceLogicalBytes",
        source_logical_files AS "sourceLogicalFiles",
        materialization_algorithm AS "materializationAlgorithm",
        plugin_version AS "pluginVersion",
        output_format AS "outputFormat",
        key_epoch AS "keyEpoch",
        grant_jti AS "grantJti",
        protected_files AS "protectedFiles",
        lane,
        state,
        lease_owner AS "leaseOwner",
        lease_generation AS "leaseGeneration",
        lease_expires_at AS "leaseExpiresAt",
        trace_id AS "traceId"
      FROM materialization_jobs
      WHERE id = ${jobId}
    `;
    const capabilityRows = await this.sql<
      {
        capabilityConsumedAt: Date | null;
        capabilityConsumedBy: string | null;
      }[]
    >`
      SELECT
        consumed_at AS "capabilityConsumedAt",
        consumed_by AS "capabilityConsumedBy"
      FROM materialization_capabilities
      WHERE capability_id = ${capabilityId} AND job_id = ${jobId}
    `;
    const intentRows = await this.sql<
      {
        bucketName: string;
        expectedBytes: number;
        expectedSha256: Buffer;
        intentExpiresAt: Date;
        intentState: string;
        objectKey: string;
        writeIntentId: string;
      }[]
    >`
      SELECT
        id::text AS "writeIntentId",
        bucket_name AS "bucketName",
        object_key AS "objectKey",
        expected_sha256 AS "expectedSha256",
        expected_bytes::float8 AS "expectedBytes",
        state AS "intentState",
        expires_at AS "intentExpiresAt"
      FROM materialization_rendition_write_intents
      WHERE id = ${writeIntentId} AND job_id = ${jobId} AND capability_id = ${capabilityId}
    `;
    const job =
      jobRows[0] && capabilityRows[0] && intentRows[0]
        ? { ...jobRows[0], ...capabilityRows[0], ...intentRows[0] }
        : undefined;
    if (
      !job ||
      job.state !== 'VERIFYING' ||
      job.intentState !== 'ISSUED' ||
      job.leaseOwner !== materializerId ||
      job.capabilityConsumedBy !== materializerId ||
      !job.capabilityConsumedAt ||
      job.leaseGeneration !== input.leaseGeneration ||
      new Date(job.leaseExpiresAt).getTime() <= now.getTime() ||
      new Date(job.intentExpiresAt).getTime() <= now.getTime() ||
      job.bucketName !== this.renditionStorage.bucketName ||
      !job.encryptedSubjectMapping
    ) {
      throw new Error('Rendition completion fence is stale or incomplete');
    }

    const protectedFiles = new Map(
      job.protectedFiles.map((file) => [file.normalizedPath, file.sourceSha256])
    );
    if (
      input.attributionRecords.length !== outputFiles.length ||
      input.attributionRecords.some((record, index) => {
        const output = outputFiles[index];
        return (
          !output ||
          record.normalizedPath !== output.normalizedPath ||
          record.attributionId !== output.attributionId ||
          protectedFiles.get(record.normalizedPath) !== record.sourceSha256 ||
          !/^[0-9a-f]{64}$/.test(record.attributionTokenHash)
        );
      })
    ) {
      throw new Error('Rendition attribution records do not match durable output');
    }

    const head = await this.renditionStorage.headExactVersion(job.objectKey, providerVersion);
    if (
      head.contentLength !== job.expectedBytes ||
      head.metadata['yucp-sha256'] !== Buffer.from(job.expectedSha256).toString('hex') ||
      head.contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/zip'
    ) {
      throw new Error('Rendition exact-version metadata failed verification');
    }
    const verified = await verifyRenditionReadback({
      expectedBytes: job.expectedBytes,
      expectedObjectSha256: Buffer.from(job.expectedSha256).toString('hex'),
      expectedOutputFiles: input.outputFiles,
      response: await this.renditionStorage.getExactVersion(job.objectKey, providerVersion),
    });
    if (!bytesEqual(Buffer.from(verified.outputTreeRoot, 'hex'), declaredOutputTreeRoot)) {
      throw new Error('Rendition output tree does not match trusted readback');
    }

    const issuedAt = toEpochSeconds(now);
    const expiresAt = issuedAt + this.receiptSigning.lifetimeSeconds;
    const receiptId = randomUUID();
    const receipt: MaterializationReceiptV2 = {
      buyerSubjectPseudonym: job.buyerSubjectPseudonym,
      capabilityId,
      codecBuild: builds.codec,
      createdPaths: outputFiles.map((file) => file.normalizedPath),
      creatorId: job.creatorId,
      expiresAt,
      grantId: job.grantJti,
      helperBuild: builds.helper,
      issuedAt,
      jobId,
      keyEpoch: job.keyEpoch,
      leaseGeneration: input.leaseGeneration,
      materializationAlgorithm: job.materializationAlgorithm,
      materializerId,
      outputFiles,
      outputTreeRoot: Buffer.from(verified.outputTreeRoot, 'hex'),
      pluginVersion: job.pluginVersion,
      productId: job.productId,
      protectedSourceRoot: job.protectedSourceRoot,
      pseudonymMethod: job.pseudonymMethod,
      receiptId,
      releaseRoot: job.releaseRoot,
      rendition: {
        bucketName: job.bucketName,
        fileIdentifier: head.fileIdentifier,
        objectBytes: verified.objectBytes,
        objectKey: job.objectKey,
        objectSha256: Buffer.from(verified.objectSha256, 'hex'),
        providerVersion: head.providerVersion,
        storageRole: 'renditions',
      },
      runtimeBuild: builds.runtime,
      traceId: job.traceId,
    };
    const signed = await signPackageContract({
      keyId: this.receiptSigning.keyId,
      payload: encodeMaterializationReceiptV2(receipt),
      privateKey: this.receiptSigning.privateKey,
      purpose: PACKAGE_CONTRACT_PURPOSES.materializationReceipt,
    });
    const signedDigest = createHash('sha256').update(signed.coseSign1).digest();

    await this.sql.begin(async (transaction) => {
      const fence = await transaction<{ id: string }[]>`
        SELECT j.id
        FROM materialization_jobs j
        JOIN materialization_rendition_write_intents w ON w.job_id = j.id
        WHERE
          j.id = ${jobId}
          AND j.state = 'VERIFYING'
          AND j.lease_owner = ${materializerId}
          AND j.lease_generation = ${input.leaseGeneration}
          AND j.lease_expires_at > ${now}
          AND w.id = ${writeIntentId}
          AND w.state = 'ISSUED'
          AND w.expires_at > ${now}
        FOR UPDATE OF j, w
      `;
      if (!fence[0]) {
        throw new Error('Rendition completion lost its durable fence');
      }
      await transaction`
        UPDATE materialization_rendition_write_intents
        SET
          state = 'COMPLETED',
          provider_version = ${head.providerVersion},
          file_identifier = ${head.fileIdentifier},
          completed_at = ${now},
          updated_at = ${now}
        WHERE id = ${writeIntentId} AND state = 'ISSUED'
      `;
      await transaction`
        INSERT INTO materialization_receipts (
          receipt_id,
          job_id,
          capability_id,
          rendition_write_intent_id,
          lease_generation,
          output_tree_root,
          object_sha256,
          object_bytes,
          provider_version,
          file_identifier,
          signed_receipt,
          signed_receipt_sha256,
          issued_at,
          expires_at,
          trace_id
        )
        VALUES (
          ${receiptId},
          ${jobId},
          ${capabilityId},
          ${writeIntentId},
          ${input.leaseGeneration},
          ${receipt.outputTreeRoot},
          ${receipt.rendition.objectSha256},
          ${receipt.rendition.objectBytes},
          ${head.providerVersion},
          ${head.fileIdentifier},
          ${signed.coseSign1},
          ${signedDigest},
          ${new Date(issuedAt * 1_000)},
          ${new Date(expiresAt * 1_000)},
          ${job.traceId}
        )
      `;
      for (const [index, record] of input.attributionRecords.entries()) {
        const output = outputFiles[index];
        if (!output) {
          throw new Error('Rendition attribution output is missing');
        }
        await transaction`
          INSERT INTO materialization_attribution_records (
            attribution_id,
            job_id,
            capability_id,
            normalized_path,
            source_sha256,
            output_sha256,
            attribution_token_hash,
            encrypted_subject_mapping,
            key_epoch,
            algorithm_version,
            plugin_version,
            output_format,
            trace_id
          )
          VALUES (
            ${record.attributionId},
            ${jobId},
            ${capabilityId},
            ${record.normalizedPath},
            ${Buffer.from(record.sourceSha256, 'hex')},
            ${output.outputSha256},
            ${Buffer.from(record.attributionTokenHash, 'hex')},
            ${job.encryptedSubjectMapping},
            ${job.keyEpoch},
            ${job.materializationAlgorithm},
            ${job.pluginVersion},
            ${job.outputFormat},
            ${job.traceId}
          )
        `;
      }
      const completed = await transaction<{ id: string; storageGcPinId: string }[]>`
        UPDATE materialization_jobs
        SET
          state = 'SUCCEEDED',
          lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          updated_at = ${now}
        WHERE
          id = ${jobId}
          AND state = 'VERIFYING'
          AND lease_owner = ${materializerId}
          AND lease_generation = ${input.leaseGeneration}
        RETURNING id, storage_gc_pin_id::text AS "storageGcPinId"
      `;
      const completedJob = completed[0];
      if (!completedJob) {
        throw new Error('Rendition completion lost its final job fence');
      }
      const released = await transaction<{ id: string }[]>`
        UPDATE storage_gc_release_pins
        SET released_at = COALESCE(released_at, ${now}), updated_at = ${now}
        WHERE id = ${completedJob.storageGcPinId}
        RETURNING id
      `;
      if (!released[0]) {
        throw new Error('Rendition completion lost its storage GC pin');
      }
    });
    return {
      receipt: Buffer.from(signed.coseSign1).toString('base64url'),
      receiptId,
      success: true,
    };
  }
}
