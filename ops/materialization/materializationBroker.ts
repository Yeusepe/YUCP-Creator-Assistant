import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CatalogDatabase } from '../catalog';
import { PACKAGE_INSTALL_DPOP_MAX_REPLAY_RESERVATION_LIFETIME_MS } from '../storage-core/dpopReplayPolicy';
import {
  computeOutputTreeRootV2,
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
  type PackageContractPurpose,
  signPackageContract,
  validateMaterializationCapabilityV2,
  verifyMaterializationCapabilityV2,
} from '../storage-core/packageContractsV2';
import type { MaterializationKeyBrokerPort } from './keyBrokerClient';
import {
  encodeMaterializationReceiptV3,
  MATERIALIZATION_RECEIPT_V3_MAX_OUTPUT_FILES,
  MATERIALIZATION_RECEIPT_V3_PURPOSE,
} from './materializationReceiptV3';

export type DeclaredMaterializedFile = {
  attributionId: string;
  normalizedPath: string;
  outputBytes: number;
  outputSha256: string;
};

const SHA256_BYTES = 32;
const MAX_LEASE_DURATION_MS = 60 * 60 * 1_000;
const MIN_LEASE_DURATION_MS = 1_000;
export const DEFAULT_MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MIN_MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS = 60 * 60;
const MAX_MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_GC_PIN_UNAVAILABLE_MESSAGE =
  'Storage GC pin cannot reference an object that is deleting or deleted';
export const MATERIALIZATION_SOURCE_UNAVAILABLE_ERROR_CODE = 'MATERIALIZATION_SOURCE_UNAVAILABLE';

class MaterializationSourceUnavailableError extends Error {
  constructor(
    readonly jobId: string,
    options: { cause: unknown }
  ) {
    super('Materialization source became unavailable before claim', options);
  }
}

function isStorageGcPinUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === STORAGE_GC_PIN_UNAVAILABLE_MESSAGE &&
    'code' in error &&
    error.code === 'P0001'
  );
}

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
      progress?: MaterializationJobProgress;
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

export type MaterializationJobProgress = {
  batchChunks?: number;
  batchIndex?: number;
  completedBatches?: number;
  completedFiles?: number;
  completedLogicalBytes?: number;
  outputBytes?: number;
  outputFiles?: number;
  sequence: number;
  stage:
    | 'archive_build'
    | 'capability_consume'
    | 'codec'
    | 'completion'
    | 'key_derivation'
    | 'rendition_verify'
    | 'source_assembly'
    | 'source_manifest'
    | 'tree_extraction';
  status: 'completed' | 'progress' | 'started';
  totalFiles?: number;
  totalLogicalBytes?: number;
  totalUniqueChunks?: number;
  updatedAt: string;
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
    expiresAt: string;
    grant: string;
    logicalBytes: number;
    logicalFiles: number;
    manifestSha256: string;
    manifestUrl: string;
    versionId: string;
  };
  success: true;
};

export type MaterializationSourceAuthorization = {
  expiresAt: Date;
  grant: string;
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
  /**
   * Which broker derivation minted this record's file key: container
   * materializations couple with the v2 per-job keys, worker-lane (coupled
   * receipt) materializations with the v3 per-buyer+release keys. The
   * attribution decoder must re-derive with the same family or every decode
   * misses.
   */
  keyDerivation: 'v2' | 'v3';
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
/**
 * A trace de-anonymises the handful of records it actually matched, never the
 * candidate set it scanned, so this bound is far below the candidate limit.
 */
const MATERIALIZATION_ATTRIBUTION_REVEAL_LIMIT = 64;
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
  files: readonly DeclaredMaterializedFile[],
  maxFiles: number
): MaterializedFileV2[] {
  if (files.length < 1 || files.length > maxFiles) {
    throw new Error(`Materialized output file count must be between 1 and ${maxFiles}`);
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
  private readonly sourceGrant: MaterializationSourceGrantConfig;
  private readonly sql: CatalogDatabase;
  private readonly storageGcPinRetentionSeconds: number;

  constructor(input: {
    keyBroker: MaterializationKeyBrokerPort;
    receiptSigning: MaterializationReceiptSigningConfig;
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
    this.receiptSigning = {
      keyId: Uint8Array.from(input.receiptSigning.keyId),
      lifetimeSeconds: input.receiptSigning.lifetimeSeconds,
      privateKey: Uint8Array.from(input.receiptSigning.privateKey),
    };
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

  private async issueSourceAuthorization(input: {
    bindingRoot: Buffer;
    buyerId: string;
    creatorId: string;
    jobId: string;
    leaseGeneration: number;
    maximumExpiresAt: Date;
    now: Date;
    productId: string;
    proofKeyThumbprint: Uint8Array;
    releaseRoot: Buffer;
    sourceVersionId: string;
    traceId: string;
  }): Promise<MaterializationSourceAuthorization> {
    const issuedAt = toEpochSeconds(input.now);
    const expiresAt = Math.min(
      toEpochSeconds(input.maximumExpiresAt),
      issuedAt + this.sourceGrant.lifetimeSeconds
    );
    if (expiresAt <= issuedAt) {
      throw new Error('Materialization source authorization lease is stale');
    }
    const grantId = randomUUID();
    const grant: DeliveryGrantV2 = {
      audience: this.sourceGrant.audience,
      bindingRoot: input.bindingRoot,
      buyerId: input.buyerId,
      creatorId: input.creatorId,
      deviceKeyThumbprint: input.proofKeyThumbprint,
      expiresAt,
      grantId,
      installSessionId: input.jobId,
      issuedAt,
      issuer: this.sourceGrant.issuer,
      notBefore: issuedAt,
      productId: input.productId,
      releaseRoot: input.releaseRoot,
      scopes: [`materialization-source:${input.sourceVersionId}`],
    };
    const signed = await signPackageContract({
      keyId: this.sourceGrant.keyId,
      payload: encodeDeliveryGrantV2(grant),
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
        ${grantId},
        ${input.jobId},
        ${input.leaseGeneration},
        ${input.sourceVersionId},
        ${input.proofKeyThumbprint},
        ${createHash('sha256').update(signed.coseSign1).digest()},
        ${new Date(issuedAt * 1_000)},
        ${new Date(expiresAt * 1_000)},
        ${input.traceId}
      )
      ON CONFLICT (job_id, lease_generation)
      DO UPDATE SET
        grant_id = EXCLUDED.grant_id,
        source_version_id = EXCLUDED.source_version_id,
        proof_key_thumbprint = EXCLUDED.proof_key_thumbprint,
        signed_grant_sha256 = EXCLUDED.signed_grant_sha256,
        issued_at = EXCLUDED.issued_at,
        expires_at = EXCLUDED.expires_at,
        trace_id = EXCLUDED.trace_id,
        created_at = clock_timestamp()
    `;
    return {
      expiresAt: new Date(expiresAt * 1_000),
      grant: Buffer.from(signed.coseSign1).toString('base64url'),
    };
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
    const cacheAffinityKey = createHash('sha256')
      .update('yucp:materialization-cache-affinity:v1', 'ascii')
      .update('\0', 'ascii')
      .update(input.sourceVersionId, 'utf8')
      .update('\0', 'ascii')
      .update(input.sourceManifestSha256)
      .digest();
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
        await transaction`
          INSERT INTO materialization_dispatch_outbox (
            job_id,
            trace_id,
            lane,
            cache_affinity_key
          )
          VALUES (
            ${input.id},
            ${input.traceId},
            ${lane},
            ${cacheAffinityKey}
          )
          ON CONFLICT (job_id) DO NOTHING
        `;
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
      await transaction`
        INSERT INTO materialization_dispatch_outbox (
          job_id,
          trace_id,
          lane,
          cache_affinity_key
        )
        VALUES (
          ${input.id},
          ${input.traceId},
          ${lane},
          ${cacheAffinityKey}
        )
      `;
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
        progress: Omit<MaterializationJobProgress, 'updatedAt'> | null;
        progressSequence: number | string;
        progressUpdatedAt: Date | null;
        receiptId: string | null;
        signedReceipt: Buffer | null;
        state: string;
      }[]
    >`
      SELECT
        j.state,
        j.last_error_code AS "lastErrorCode",
        j.progress,
        j.progress_sequence AS "progressSequence",
        j.progress_updated_at AS "progressUpdatedAt",
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
      ...(job.progress && Number(job.progressSequence) > 0 && job.progressUpdatedAt
        ? {
            progress: {
              ...job.progress,
              sequence: Number(job.progressSequence),
              updatedAt: new Date(job.progressUpdatedAt).toISOString(),
            },
          }
        : {}),
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
        keyDerivation: string;
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
          -- Coupled (worker-lane) completions store a v3 receipt whose
          -- rendition identity is honest NULLs (migration 0031); those jobs
          -- derived their file keys with the v3 derivation. Container jobs
          -- store the rendition object and derived with v2. The decoder must
          -- re-derive with the same family, so the receipt shape rides along.
          CASE
            WHEN r.receipt_id IS NOT NULL AND r.object_sha256 IS NULL THEN 'v3'
            ELSE 'v2'
          END AS "keyDerivation",
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
        LEFT JOIN materialization_receipts r ON r.job_id = j.id
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
        "keyDerivation",
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
          (row.keyDerivation !== 'v2' && row.keyDerivation !== 'v3') ||
          !Number.isSafeInteger(createdAt) ||
          createdAt < 0
        ) {
          throw new Error('Durable materialization attribution record has an invalid format');
        }
        return {
          ...row,
          createdAt,
          keyDerivation: row.keyDerivation,
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

  /**
   * Hands back the sealed buyer mapping behind matched attribution records.
   *
   * The blob stays sealed here: this broker cannot open it, and neither can
   * anything else that does not hold the master epoch key. What this method
   * decides is *whose* mappings a caller may ask about at all, so the scope is
   * the same as the candidate listing it follows - the creator's own jobs, for
   * the product the trace ran against. An attribution id from another product
   * or another creator simply is not returned.
   *
   * The pseudonym rides along so the caller can prove the opened mapping
   * belongs to the record it matched rather than trusting the pairing.
   */
  async listAttributionSubjectMappings(input: {
    attributionIds: string[];
    creatorId: string;
    productId: string;
  }): Promise<{
    subjects: Array<{
      attributionId: string;
      buyerSubjectPseudonym: string;
      encryptedSubjectMapping: string;
      jobId: string;
      keyEpoch: number;
    }>;
  }> {
    const creatorId = requireText(input.creatorId, 'creatorId', 512);
    const productId = requireText(input.productId, 'productId', 512);
    if (!Array.isArray(input.attributionIds) || input.attributionIds.length < 1) {
      throw new Error('attributionIds are required');
    }
    if (input.attributionIds.length > MATERIALIZATION_ATTRIBUTION_REVEAL_LIMIT) {
      throw new Error('attributionIds exceed the reveal limit');
    }
    const attributionIds = input.attributionIds.map((value, index) =>
      requireText(value, `attributionIds[${index}]`, 512)
    );
    const rows = await this.sql<
      Array<{
        attributionId: string;
        buyerSubjectPseudonym: string;
        encryptedSubjectMapping: string | null;
        jobId: string;
        keyEpoch: number;
      }>
    >`
      SELECT DISTINCT ON (a.attribution_id)
        a.attribution_id AS "attributionId",
        j.buyer_subject_pseudonym AS "buyerSubjectPseudonym",
        encode(j.encrypted_subject_mapping, 'base64') AS "encryptedSubjectMapping",
        j.id AS "jobId",
        a.key_epoch AS "keyEpoch"
      FROM materialization_attribution_records a
      JOIN materialization_jobs j ON j.id = a.job_id
      WHERE
        j.creator_id = ${creatorId}
        AND j.product_id = ${productId}
        AND j.state = 'SUCCEEDED'
        AND a.attribution_id = ANY(${attributionIds})
      ORDER BY a.attribution_id, a.created_at DESC, j.id DESC
    `;
    return {
      subjects: rows.flatMap((row) =>
        row.encryptedSubjectMapping
          ? [
              {
                attributionId: row.attributionId,
                buyerSubjectPseudonym: row.buyerSubjectPseudonym,
                // Postgres encodes base64 with padding; the mapping travels as
                // base64url everywhere else.
                encryptedSubjectMapping: Buffer.from(
                  row.encryptedSubjectMapping,
                  'base64'
                ).toString('base64url'),
                jobId: row.jobId,
                keyEpoch: Number(row.keyEpoch),
              },
            ]
          : []
      ),
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
      jobStates: ['MATERIALIZING', 'VERIFYING'],
      jobId: requireText(input.jobId, 'jobId', 128),
      leaseGeneration: input.leaseGeneration,
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

  private async isolateUnavailableSourceJob(input: {
    jobId: string;
    lane: 'large' | 'maintenance';
    now: Date;
  }): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const jobs = await transaction<
        {
          id: string;
          sourceVersionId: string;
          storageGcPinId: string;
        }[]
      >`
        SELECT
          id,
          source_version_id::text AS "sourceVersionId",
          storage_gc_pin_id::text AS "storageGcPinId"
        FROM materialization_jobs
        WHERE id = ${input.jobId}
          AND lane = ${input.lane}
          AND (
            state = 'QUEUED'
            OR (
              state IN ('MATERIALIZING', 'VERIFYING')
              AND lease_expires_at <= ${input.now}
            )
          )
        FOR UPDATE
      `;
      const job = jobs[0];
      if (!job) {
        return false;
      }
      const unavailableObjects = await transaction<{ id: string }[]>`
        SELECT object.id
        FROM package_release_storage_objects release_object
        JOIN storage_object_versions object
          ON object.id = release_object.object_version_id
        LEFT JOIN storage_gc_candidates candidate
          ON candidate.object_version_id = object.id
        WHERE release_object.package_version_id = ${job.sourceVersionId}
          AND (
            object.verification_state <> 'VERIFIED'
            OR candidate.state IN ('DELETING', 'DELETED')
          )
        ORDER BY object.id
        LIMIT 1
        FOR UPDATE OF object
      `;
      if (!unavailableObjects[0]) {
        return false;
      }
      const failed = await transaction<{ id: string }[]>`
        UPDATE materialization_jobs
        SET
          state = 'FAILED',
          last_error_code = ${MATERIALIZATION_SOURCE_UNAVAILABLE_ERROR_CODE},
          lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          updated_at = ${input.now}
        WHERE id = ${job.id}
          AND (
            state = 'QUEUED'
            OR (
              state IN ('MATERIALIZING', 'VERIFYING')
              AND lease_expires_at <= ${input.now}
            )
          )
        RETURNING id
      `;
      if (!failed[0]) {
        return false;
      }
      const released = await transaction<{ id: string }[]>`
        UPDATE storage_gc_release_pins
        SET
          released_at = COALESCE(released_at, ${input.now}),
          updated_at = ${input.now}
        WHERE id = ${job.storageGcPinId}
        RETURNING id
      `;
      if (!released[0]) {
        throw new Error('Unavailable materialization source lost its storage GC pin');
      }
      return true;
    });
  }

  async claimNextJob(input: {
    jobId?: string;
    lane?: 'large' | 'maintenance';
    leaseDurationMs: number;
    leaseOwner: string;
    now?: Date;
  }): Promise<MaterializationClaimResult> {
    const lane = input.lane ?? 'large';
    const requestedJobId =
      input.jobId === undefined ? undefined : requireText(input.jobId, 'jobId', 128);
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
    const pinExpiresAt = new Date(now.getTime() + this.storageGcPinRetentionSeconds * 1_000);
    while (true) {
      try {
        return await this.sql.begin(async (transaction) => {
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
          // A durable-workflow step can be retried after it already took the lease.
          // Re-issuing the same fence to the owner that holds it keeps the claim
          // idempotent; without this the retry sees its own lease as saturation and
          // the job can never progress.
          if (requestedJobId !== undefined) {
            const owned = await transaction<
              { id: string; lease_expires_at: Date; lease_generation: number }[]
            >`
              UPDATE materialization_jobs
              SET
                lease_expires_at = ${leaseExpiresAt},
                heartbeat_at = ${now},
                updated_at = ${now}
              WHERE
                id = ${requestedJobId}
                AND lane = ${lane}
                AND lease_owner = ${leaseOwner}
                AND state IN ('MATERIALIZING', 'VERIFYING')
                AND lease_expires_at > ${now}
              RETURNING id, lease_generation, lease_expires_at
            `;
            if (owned[0]) {
              return {
                jobId: owned[0].id,
                leaseExpiresAt: new Date(owned[0].lease_expires_at),
                leaseGeneration: owned[0].lease_generation,
                status: 'claimed' as const,
              };
            }
          }
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
          const next = await transaction<
            {
              id: string;
              sourceVersionId: string;
              storageGcPinId: string;
            }[]
          >`
            SELECT
              id,
              source_version_id::text AS "sourceVersionId",
              storage_gc_pin_id::text AS "storageGcPinId"
            FROM materialization_jobs
            WHERE
              lane = ${lane}
              AND state = 'QUEUED'
              AND (
                ${requestedJobId ?? null}::text IS NULL
                OR id = ${requestedJobId ?? null}
              )
            ORDER BY created_at, id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          `;
          const candidate = next[0];
          if (!candidate) {
            return { status: 'idle' as const };
          }
          let pinned: { pinId: string }[];
          try {
            pinned = await transaction<{ pinId: string }[]>`
              SELECT storage_gc_acquire_release_pin(
                ${candidate.storageGcPinId},
                ${candidate.sourceVersionId},
                'materialization-job',
                ${candidate.id},
                ${pinExpiresAt}
              )::text AS "pinId"
            `;
          } catch (error) {
            if (isStorageGcPinUnavailableError(error)) {
              throw new MaterializationSourceUnavailableError(candidate.id, { cause: error });
            }
            throw error;
          }
          if (pinned[0]?.pinId !== candidate.storageGcPinId) {
            throw new Error('Materialization job storage GC pin binding is invalid');
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
              progress_sequence = 0,
              progress = NULL,
              progress_updated_at = NULL,
              updated_at = ${now}
            WHERE id = ${candidate.id} AND state = 'QUEUED'
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
      } catch (error) {
        if (!(error instanceof MaterializationSourceUnavailableError)) {
          throw error;
        }
        try {
          await this.isolateUnavailableSourceJob({
            jobId: error.jobId,
            lane,
            now,
          });
        } catch (isolationError) {
          throw new AggregateError(
            [error, isolationError],
            'Materialization source isolation failed'
          );
        }
      }
    }
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
    sourceAuthorization?: MaterializationSourceAuthorization | undefined;
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
    const renewedJob = await this.sql.begin(async (transaction) => {
      const renewed = await transaction<
        {
          bindingRoot: Buffer;
          creatorId: string;
          id: string;
          leaseExpiresAt: Date;
          leaseGeneration: number;
          productId: string;
          releaseRoot: Buffer;
          sourceVersionId: string;
          storageGcPinId: string;
          traceId: string;
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
        RETURNING
          delivery_binding_root AS "bindingRoot",
          creator_id AS "creatorId",
          id,
          lease_expires_at AS "leaseExpiresAt",
          lease_generation AS "leaseGeneration",
          product_id AS "productId",
          release_root AS "releaseRoot",
          source_version_id::text AS "sourceVersionId",
          storage_gc_pin_id::text AS "storageGcPinId",
          trace_id AS "traceId"
      `;
      const row = renewed[0];
      if (!row) {
        throw new Error('Materialization lease renewal fence is stale');
      }
      const pinned = await transaction<{ pinId: string }[]>`
        SELECT storage_gc_acquire_release_pin(
          ${row.storageGcPinId},
          ${row.sourceVersionId},
          'materialization-job',
          ${row.id},
          ${pinExpiresAt}
        )::text AS "pinId"
      `;
      if (pinned[0]?.pinId !== row.storageGcPinId) {
        throw new Error('Materialization lease renewal lost its storage GC pin');
      }
      const sourceProof = await transaction<{ proofKeyThumbprint: Buffer }[]>`
        SELECT proof_key_thumbprint AS "proofKeyThumbprint"
        FROM materialization_source_grants
        WHERE
          job_id = ${row.id}
          AND lease_generation = ${row.leaseGeneration}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return { proofKeyThumbprint: sourceProof[0]?.proofKeyThumbprint, row };
    });
    const sourceAuthorization = renewedJob.proofKeyThumbprint
      ? await this.issueSourceAuthorization({
          bindingRoot: renewedJob.row.bindingRoot,
          buyerId: leaseOwner,
          creatorId: renewedJob.row.creatorId,
          jobId: renewedJob.row.id,
          leaseGeneration: renewedJob.row.leaseGeneration,
          maximumExpiresAt: renewedJob.row.leaseExpiresAt,
          now,
          productId: renewedJob.row.productId,
          proofKeyThumbprint: renewedJob.proofKeyThumbprint,
          releaseRoot: renewedJob.row.releaseRoot,
          sourceVersionId: renewedJob.row.sourceVersionId,
          traceId: renewedJob.row.traceId,
        })
      : undefined;
    return {
      jobId: renewedJob.row.id,
      leaseExpiresAt: new Date(renewedJob.row.leaseExpiresAt),
      leaseGeneration: renewedJob.row.leaseGeneration,
      ...(sourceAuthorization ? { sourceAuthorization } : {}),
      status: 'renewed',
    };
  }

  async reportJobProgress(input: {
    jobId: string;
    leaseGeneration: number;
    leaseOwner: string;
    now?: Date;
    progress: Omit<MaterializationJobProgress, 'updatedAt'>;
  }): Promise<{ sequence: number; status: 'accepted' }> {
    const jobId = requireText(input.jobId, 'jobId', 128);
    const leaseOwner = requireText(input.leaseOwner, 'leaseOwner', 512);
    const now = input.now ?? new Date();
    const progress = input.progress;
    if (
      !Number.isSafeInteger(input.leaseGeneration) ||
      input.leaseGeneration < 1 ||
      !Number.isSafeInteger(progress.sequence) ||
      progress.sequence < 1
    ) {
      throw new Error('Materialization progress fence is invalid');
    }
    const updated = await this.sql<{ id: string }[]>`
      UPDATE materialization_jobs
      SET
        progress_sequence = ${progress.sequence},
        progress = ${this.sql.json(progress)},
        progress_updated_at = ${now},
        updated_at = ${now}
      WHERE
        id = ${jobId}
        AND lease_owner = ${leaseOwner}
        AND lease_generation = ${input.leaseGeneration}
        AND lease_expires_at > ${now}
        AND state IN ('MATERIALIZING', 'VERIFYING')
        AND progress_sequence < ${progress.sequence}
      RETURNING id
    `;
    if (!updated[0]) {
      throw new Error('Materialization progress fence is stale');
    }
    return {
      sequence: progress.sequence,
      status: 'accepted',
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
    jobStates: readonly ('MATERIALIZING' | 'SUCCEEDED' | 'VERIFYING')[];
    jobId: string;
    leaseGeneration: number;
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
          capabilityLeaseGeneration: number;
          consumedBy: string | null;
          jobLeaseGeneration: number;
          jobState: string;
          leaseExpiresAt: Date | null;
          leaseOwner: string | null;
          proofKeyThumbprint: Buffer;
          signedSha256: Buffer;
        }[]
      >`
        SELECT
          c.consumed_by AS "consumedBy",
          c.lease_generation AS "capabilityLeaseGeneration",
          c.proof_key_thumbprint AS "proofKeyThumbprint",
          c.signed_capability_sha256 AS "signedSha256",
          j.state AS "jobState",
          j.lease_owner AS "leaseOwner",
          j.lease_generation AS "jobLeaseGeneration",
          j.lease_expires_at AS "leaseExpiresAt"
        FROM materialization_capabilities c
        JOIN materialization_jobs j ON j.id = c.job_id
        WHERE c.capability_id = ${input.capabilityId}
          AND c.job_id = ${input.jobId}
        FOR UPDATE OF c, j
      `;
      const row = rows[0];
      // Capability expiry fences its one-time consumption. After consumption,
      // the durable job lease and bound proof key fence the materializer session.
      const hasActiveLease = row?.jobState === 'MATERIALIZING' || row?.jobState === 'VERIFYING';
      if (
        !row ||
        row.consumedBy !== input.materializerId ||
        !input.jobStates.some((jobState) => jobState === row.jobState) ||
        row.capabilityLeaseGeneration !== input.leaseGeneration ||
        row.jobLeaseGeneration !== input.leaseGeneration ||
        (hasActiveLease &&
          (row.leaseOwner !== input.materializerId ||
            !row.leaseExpiresAt ||
            new Date(row.leaseExpiresAt).getTime() <= input.now.getTime())) ||
        !bytesEqual(row.proofKeyThumbprint, proofKeyThumbprint) ||
        !bytesEqual(row.signedSha256, signedDigest)
      ) {
        throw new Error('Materializer proof does not match its durable capability');
      }
      const proofExpiresAt = hasActiveLease
        ? row.leaseExpiresAt
        : // A successful job has released its lease. Keep replay protection for
          // the accepted proof window so completion retries remain idempotent.
          new Date(input.now.getTime() + PACKAGE_INSTALL_DPOP_MAX_REPLAY_RESERVATION_LIFETIME_MS);
      if (!proofExpiresAt) {
        throw new Error('Materializer proof does not have a durable replay fence');
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
          ${proofExpiresAt},
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

    const sourceAuthorization = await this.issueSourceAuthorization({
      bindingRoot: durableJob.bindingRoot,
      buyerId: materializerId,
      creatorId: durableJob.creatorId,
      jobId: durableJob.id,
      leaseGeneration: durableJob.leaseGeneration,
      maximumExpiresAt: durableJob.leaseExpiresAt,
      now,
      productId: durableJob.productId,
      proofKeyThumbprint: capability.proofKeyThumbprint,
      releaseRoot: durableJob.releaseRoot,
      sourceVersionId: durableJob.sourceVersionId,
      traceId: durableJob.traceId,
    });
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
        expiresAt: sourceAuthorization.expiresAt.toISOString(),
        grant: sourceAuthorization.grant,
        logicalBytes: durableJob.sourceLogicalBytes,
        logicalFiles: durableJob.sourceLogicalFiles,
        manifestSha256: Buffer.from(durableJob.sourceManifestSha256).toString('hex'),
        manifestUrl: sourceManifestUrl.toString(),
        versionId: durableJob.sourceVersionId,
      },
      success: true,
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
    completionSchema?: 'v3';
    coseSign1: Uint8Array;
    coupledJobManifestKey?: string;
    jobId: string;
    leaseGeneration: number;
    materializerId: string;
    now?: Date;
    outputFiles: readonly DeclaredMaterializedFile[];
    outputTreeRoot: string;
    proofJti: string;
    renditionBytes?: number;
    renditionSha256?: string;
    traceId: string;
    verifiedProofKeyThumbprint: Uint8Array;
  }): Promise<CompletedRendition> {
    const now = input.now ?? new Date();
    const materializerId = requireText(input.materializerId, 'materializerId', 512);
    const jobId = requireText(input.jobId, 'jobId', 128);
    const capabilityId = requireText(input.capabilityId, 'capabilityId', 128);
    const coupled = input.completionSchema === 'v3';
    if (input.completionSchema !== undefined && input.completionSchema !== 'v3') {
      throw new Error('Rendition completion schema is invalid');
    }
    let fileIdentifier: string;
    let renditionSha256: Buffer | undefined;
    if (coupled) {
      // v3 coupled completions carry no monolithic rendition object; the
      // outputs are served per file from the materializer's coupled-job store.
      if (
        input.renditionBytes !== undefined ||
        input.renditionSha256 !== undefined ||
        input.coupledJobManifestKey !== `coupled-jobs/${jobId}.v1.json`
      ) {
        throw new Error('Coupled completion request is invalid');
      }
      fileIdentifier = input.coupledJobManifestKey;
    } else {
      if (input.coupledJobManifestKey !== undefined) {
        throw new Error('Rendition completion request is invalid');
      }
      fileIdentifier = `${jobId}.zip`;
      if (typeof input.renditionSha256 !== 'string') {
        throw new Error('Rendition completion request is invalid');
      }
      renditionSha256 = requireSha256Hex(input.renditionSha256, 'renditionSha256');
      if (
        !Number.isSafeInteger(input.renditionBytes) ||
        (input.renditionBytes as number) < 1 ||
        (input.renditionBytes as number) > 5 * 1024 ** 3
      ) {
        throw new Error('Rendition completion request is invalid');
      }
    }
    requireText(input.traceId, 'traceId', 512);
    const outputFiles = normalizeMaterializedFiles(
      input.outputFiles,
      coupled ? MATERIALIZATION_RECEIPT_V3_MAX_OUTPUT_FILES : 512
    );
    const declaredOutputTreeRoot = requireSha256Hex(input.outputTreeRoot, 'outputTreeRoot');
    const builds = {
      codec: requireText(input.builds.codec, 'codecBuild', 512),
      helper: requireText(input.builds.helper, 'helperBuild', 512),
      runtime: requireText(input.builds.runtime, 'runtimeBuild', 512),
    };
    await this.consumeMaterializerProof({
      capabilityId,
      coseSign1: input.coseSign1,
      jobStates: ['MATERIALIZING', 'SUCCEEDED'],
      jobId,
      leaseGeneration: input.leaseGeneration,
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
          fileIdentifier: string | null;
          objectBytes: number | null;
          objectSha256: Buffer | null;
          receiptId: string;
          signedReceipt: Buffer;
        }[]
      >`
        SELECT
          r.receipt_id AS "receiptId",
          r.capability_id AS "capabilityId",
          r.file_identifier AS "fileIdentifier",
          r.object_sha256 AS "objectSha256",
          r.object_bytes::float8 AS "objectBytes",
          r.signed_receipt AS "signedReceipt",
          c.consumed_by AS "consumedBy"
        FROM materialization_receipts r
        JOIN materialization_capabilities c ON c.capability_id = r.capability_id
        WHERE r.receipt_id = ${existingReceiptIds[0].receipt_id}
      `;
      if (!existingReceipt[0]) {
        throw new Error('Completed rendition receipt disappeared');
      }
      // A coupled (v3) row stores NULL rendition identity; a retry must present the
      // same schema and, for v2, the same rendition object.
      const renditionMatches = coupled
        ? existingReceipt[0].fileIdentifier === null &&
          existingReceipt[0].objectBytes === null &&
          existingReceipt[0].objectSha256 === null
        : existingReceipt[0].fileIdentifier === fileIdentifier &&
          existingReceipt[0].objectBytes === input.renditionBytes &&
          existingReceipt[0].objectSha256 !== null &&
          bytesEqual(existingReceipt[0].objectSha256, renditionSha256 as Buffer);
      if (
        existingReceipt[0].capabilityId !== capabilityId ||
        !renditionMatches ||
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
    const job =
      jobRows[0] && capabilityRows[0] ? { ...jobRows[0], ...capabilityRows[0] } : undefined;
    if (
      !job ||
      job.state !== 'MATERIALIZING' ||
      job.leaseOwner !== materializerId ||
      job.capabilityConsumedBy !== materializerId ||
      !job.capabilityConsumedAt ||
      job.leaseGeneration !== input.leaseGeneration ||
      new Date(job.leaseExpiresAt).getTime() <= now.getTime() ||
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

    if (!bytesEqual(computeOutputTreeRootV2(outputFiles), declaredOutputTreeRoot)) {
      throw new Error('Rendition output tree does not match its declared outputs');
    }

    // Backdated so a buyer clock up to 60s behind still accepts a receipt it
    // validates within a second of signing; the helper's own leeway only
    // reaches machines once their runtime self-updates.
    const issuedAt = toEpochSeconds(now) - 60;
    const expiresAt = toEpochSeconds(now) + this.receiptSigning.lifetimeSeconds;
    const receiptId = randomUUID();
    const receiptBase = {
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
      outputTreeRoot: declaredOutputTreeRoot,
      pluginVersion: job.pluginVersion,
      productId: job.productId,
      protectedSourceRoot: job.protectedSourceRoot,
      pseudonymMethod: job.pseudonymMethod,
      receiptId,
      releaseRoot: job.releaseRoot,
      runtimeBuild: builds.runtime,
      traceId: job.traceId,
    };
    const signed = coupled
      ? await signPackageContract({
          keyId: this.receiptSigning.keyId,
          payload: encodeMaterializationReceiptV3(receiptBase),
          privateKey: this.receiptSigning.privateKey,
          // The purpose union lives in the frozen storage-core module; the
          // string is the fixed cross-repo contract value.
          purpose: MATERIALIZATION_RECEIPT_V3_PURPOSE as PackageContractPurpose,
        })
      : await signPackageContract({
          keyId: this.receiptSigning.keyId,
          payload: encodeMaterializationReceiptV2({
            ...receiptBase,
            rendition: {
              fileIdentifier,
              objectBytes: input.renditionBytes as number,
              objectSha256: renditionSha256 as Buffer,
            },
          } satisfies MaterializationReceiptV2),
          privateKey: this.receiptSigning.privateKey,
          purpose: PACKAGE_CONTRACT_PURPOSES.materializationReceipt,
        });
    const signedDigest = createHash('sha256').update(signed.coseSign1).digest();

    await this.sql.begin(async (transaction) => {
      const fence = await transaction<{ id: string }[]>`
        SELECT id
        FROM materialization_jobs
        WHERE
          id = ${jobId}
          AND state = 'MATERIALIZING'
          AND lease_owner = ${materializerId}
          AND lease_generation = ${input.leaseGeneration}
          AND lease_expires_at > ${now}
        FOR UPDATE
      `;
      if (!fence[0]) {
        throw new Error('Rendition completion lost its durable fence');
      }
      // v3 coupled completions carry no monolithic rendition object; the rendition
      // identity columns are NULL for them (migration 0031 enforces all-or-nothing).
      await transaction`
        INSERT INTO materialization_receipts (
          receipt_id,
          job_id,
          capability_id,
          lease_generation,
          output_tree_root,
          object_sha256,
          object_bytes,
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
          ${input.leaseGeneration},
          ${declaredOutputTreeRoot},
          ${coupled ? null : (renditionSha256 as Buffer)},
          ${coupled ? null : (input.renditionBytes as number)},
          ${coupled ? null : fileIdentifier},
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
          AND state = 'MATERIALIZING'
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
