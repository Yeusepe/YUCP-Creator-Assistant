import { isProtectionPolicyId } from './protectionPolicyId';
import { normalizeVpmBootstrapMedia, type VpmBootstrapMediaObject } from './vpmBootstrapMedia';
import {
  normalizeVpmBootstrapMetadata,
  type VpmBootstrapPackageMetadata,
} from './vpmBootstrapMetadata';

export const DESYNC_STORAGE_FORMAT_VERSION = 'desync-uncompressed-sha256-v1';
export const DESYNC_CHUNK_AVG_KIB = 256;
export const LOGICAL_TREE_MANIFEST_SCHEMA_VERSION = 4;

export type DeliveryManifestChunk = {
  id: string;
  sha256: string;
  size: number;
};

export type DeliveryManifestFile = {
  bytes: number;
  chunks: DeliveryManifestChunk[];
  classification: 'common' | 'protected';
  materializerType?: string;
  normalizedPath: string;
  sha256: string;
};

export type DeliveryManifest = {
  activeContentDigest: string;
  activePolicyVersion: string;
  chunkAvgKib: number;
  files: DeliveryManifestFile[];
  commonRoot: string;
  normalizationPolicyVersion: string;
  packageId: string;
  protectionPolicyDigest: string;
  protectionPolicyId: string;
  protectedSourceRoot: string;
  releaseRoot: string;
  schemaVersion: typeof LOGICAL_TREE_MANIFEST_SCHEMA_VERSION;
  storageFormatVersion: string;
  version: string;
  versionId: string;
  bootstrapMedia?: VpmBootstrapMediaObject[];
  packageMetadata?: VpmBootstrapPackageMetadata;
  vpmDependencies: Record<string, string>;
  vpmRepositories: Record<string, string>;
};

const STORAGE_FORMAT_VERSION_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_FILES = 100_000;
const MAX_CHUNKS = 1_000_000;
const MAX_FILE_BYTES = 64 * 1024 ** 3;
const MAX_IDENTITY_BYTES = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateLogicalPath(value: unknown, index: number): string {
  if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/')) {
    throw new Error(`Delivery manifest file ${index} has an invalid normalizedPath`);
  }
  const segments = value.split('/');
  if (
    (segments[0] !== 'Assets' && segments[0] !== 'Packages') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Delivery manifest file ${index} has an invalid normalizedPath`);
  }
  return value;
}

function parseChunk(value: unknown, fileIndex: number, chunkIndex: number): DeliveryManifestChunk {
  if (!isRecord(value)) {
    throw new Error(`Delivery manifest file ${fileIndex} chunk ${chunkIndex} is invalid`);
  }
  if (typeof value.id !== 'string' || !SHA256_PATTERN.test(value.id)) {
    throw new Error(`Delivery manifest file ${fileIndex} chunk ${chunkIndex} has an invalid id`);
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error(
      `Delivery manifest file ${fileIndex} chunk ${chunkIndex} has an invalid sha256`
    );
  }
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) {
    throw new Error(`Delivery manifest file ${fileIndex} chunk ${chunkIndex} has an invalid size`);
  }
  return { id: value.id, sha256: value.sha256, size: value.size as number };
}

function parseFile(value: unknown, index: number): DeliveryManifestFile {
  if (!isRecord(value)) {
    throw new Error(`Delivery manifest file ${index} is invalid`);
  }
  const normalizedPath = validateLogicalPath(value.normalizedPath, index);
  if (value.classification !== 'common' && value.classification !== 'protected') {
    throw new Error(`Delivery manifest file ${index} has an invalid classification`);
  }
  const materializerType =
    typeof value.materializerType === 'string' ? value.materializerType.trim() : undefined;
  if (
    (value.classification === 'protected' &&
      (!materializerType || new TextEncoder().encode(materializerType).byteLength > 128)) ||
    (value.classification === 'common' && value.materializerType !== undefined)
  ) {
    throw new Error(`Delivery manifest file ${index} has an invalid materializerType`);
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error(`Delivery manifest file ${index} has an invalid sha256`);
  }
  if (
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    (value.bytes as number) > MAX_FILE_BYTES
  ) {
    throw new Error(`Delivery manifest file ${index} has an invalid byte count`);
  }
  if (!Array.isArray(value.chunks) || value.chunks.length === 0) {
    throw new Error(`Delivery manifest file ${index} has no chunks`);
  }
  const chunks = value.chunks.map((chunk, chunkIndex) => parseChunk(chunk, index, chunkIndex));
  if (
    (value.bytes === 0 &&
      (chunks.length !== 1 || chunks[0]?.size !== 0 || chunks[0]?.sha256 !== value.sha256)) ||
    (value.bytes !== 0 && chunks.some((chunk) => chunk.size === 0))
  ) {
    throw new Error(`Delivery manifest file ${index} has an invalid empty-file recipe`);
  }
  const chunkBytes = chunks.reduce((total, chunk) => total + chunk.size, 0);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes !== value.bytes) {
    throw new Error(`Delivery manifest file ${index} chunk sizes do not equal its bytes`);
  }
  return {
    bytes: value.bytes as number,
    chunks,
    classification: value.classification,
    ...(materializerType ? { materializerType } : {}),
    normalizedPath,
    sha256: value.sha256,
  };
}

function parseIdentity(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    new TextEncoder().encode(value).byteLength > MAX_IDENTITY_BYTES
  ) {
    throw new Error(`Delivery manifest has an invalid ${name}`);
  }
  return value;
}

export function deliveryManifestObjectId(versionId: string): string {
  if (!VERSION_ID_PATTERN.test(versionId)) {
    throw new Error('Delivery manifest versionId must be a safe object-key segment');
  }
  return `${versionId}.logical-tree-v4.json`;
}

export function deliveryAssemblyObjectId(versionId: string): string {
  if (!VERSION_ID_PATTERN.test(versionId)) {
    throw new Error('Delivery assembly versionId must be a safe object-key segment');
  }
  return `${versionId}.logical-tree-assembly-v4.json`;
}

export function parseDeliveryManifest(value: unknown): DeliveryManifest {
  if (!isRecord(value)) {
    throw new Error('Delivery manifest must be a JSON object');
  }
  if (value.schemaVersion !== LOGICAL_TREE_MANIFEST_SCHEMA_VERSION) {
    throw new Error('Delivery manifest has an invalid schemaVersion');
  }
  if (
    typeof value.storageFormatVersion !== 'string' ||
    !STORAGE_FORMAT_VERSION_PATTERN.test(value.storageFormatVersion)
  ) {
    throw new Error('Delivery manifest has an invalid storageFormatVersion');
  }
  if (typeof value.versionId !== 'string' || !VERSION_ID_PATTERN.test(value.versionId)) {
    throw new Error('Delivery manifest has an invalid versionId');
  }
  if (value.chunkAvgKib !== DESYNC_CHUNK_AVG_KIB) {
    throw new Error('Delivery manifest has an invalid chunkAvgKib');
  }
  if (typeof value.releaseRoot !== 'string' || !SHA256_PATTERN.test(value.releaseRoot)) {
    throw new Error('Delivery manifest has an invalid releaseRoot');
  }
  if (typeof value.commonRoot !== 'string' || !SHA256_PATTERN.test(value.commonRoot)) {
    throw new Error('Delivery manifest has an invalid commonRoot');
  }
  if (
    typeof value.protectedSourceRoot !== 'string' ||
    !SHA256_PATTERN.test(value.protectedSourceRoot)
  ) {
    throw new Error('Delivery manifest has an invalid protectedSourceRoot');
  }
  if (
    typeof value.protectionPolicyDigest !== 'string' ||
    !SHA256_PATTERN.test(value.protectionPolicyDigest)
  ) {
    throw new Error('Delivery manifest has an invalid protectionPolicyDigest');
  }
  if (
    typeof value.activeContentDigest !== 'string' ||
    !SHA256_PATTERN.test(value.activeContentDigest)
  ) {
    throw new Error('Delivery manifest has an invalid activeContentDigest');
  }
  if (
    typeof value.activePolicyVersion !== 'string' ||
    !POLICY_VERSION_PATTERN.test(value.activePolicyVersion)
  ) {
    throw new Error('Delivery manifest has an invalid activePolicyVersion');
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_FILES) {
    throw new Error('Delivery manifest has an invalid files list');
  }
  const files = value.files.map(parseFile);
  const packageId = parseIdentity(value.packageId, 'packageId');
  const normalizationPolicyVersion = parseIdentity(
    value.normalizationPolicyVersion,
    'normalizationPolicyVersion'
  );
  const protectionPolicyId = parseIdentity(value.protectionPolicyId, 'protectionPolicyId');
  if (!isProtectionPolicyId(protectionPolicyId)) {
    throw new Error('Delivery manifest has an unsupported protectionPolicyId');
  }
  const version = parseIdentity(value.version, 'version');
  const bootstrapMetadata = normalizeVpmBootstrapMetadata({
    packageMetadata: value.packageMetadata,
    vpmDependencies: value.vpmDependencies,
    vpmRepositories: value.vpmRepositories,
  });
  let chunkCount = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index] as DeliveryManifestFile;
    if (
      index > 0 &&
      compareText((files[index - 1] as DeliveryManifestFile).normalizedPath, file.normalizedPath) >=
        0
    ) {
      throw new Error('Delivery manifest files must be strictly sorted');
    }
    chunkCount += file.chunks.length;
    if (chunkCount > MAX_CHUNKS) {
      throw new Error('Delivery manifest chunk count exceeds the limit');
    }
  }
  return {
    activeContentDigest: value.activeContentDigest,
    activePolicyVersion: value.activePolicyVersion,
    bootstrapMedia: normalizeVpmBootstrapMedia(value.bootstrapMedia),
    chunkAvgKib: value.chunkAvgKib,
    commonRoot: value.commonRoot,
    files,
    normalizationPolicyVersion,
    packageId,
    protectionPolicyDigest: value.protectionPolicyDigest,
    protectionPolicyId,
    protectedSourceRoot: value.protectedSourceRoot,
    releaseRoot: value.releaseRoot,
    schemaVersion: LOGICAL_TREE_MANIFEST_SCHEMA_VERSION,
    storageFormatVersion: value.storageFormatVersion,
    version,
    versionId: value.versionId,
    ...(bootstrapMetadata.packageMetadata
      ? { packageMetadata: bootstrapMetadata.packageMetadata }
      : {}),
    vpmDependencies: bootstrapMetadata.vpmDependencies,
    vpmRepositories: bootstrapMetadata.vpmRepositories,
  };
}

export function createDeliveryManifest(input: DeliveryManifest): DeliveryManifest {
  return parseDeliveryManifest(input);
}
