import * as ed25519 from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { parseTraceparent } from '@yucp/shared/traceparent';
import { decode, encode, rfc8949EncodeOptions } from 'cborg';

/**
 * CBOR: https://www.rfc-editor.org/rfc/rfc8949
 * COSE_Sign1: https://www.rfc-editor.org/rfc/rfc9052#section-4.2
 * EdDSA: https://www.rfc-editor.org/rfc/rfc9053#section-2.2
 */

export const PACKAGE_CONTRACT_VERSION = 2;
export const PACKAGE_COSE_ALGORITHM_EDDSA = -8;
export const PACKAGE_COSE_PURPOSE_HEADER = 1001;
export const INSTALL_SESSION_TOKEN_TYPE = 'YUCP-InstallSession';
export const INSTALL_SESSION_MAX_LIFETIME_SECONDS = 15 * 60;
export const DELIVERY_GRANT_MAX_LIFETIME_SECONDS = 15 * 60;
export const MATERIALIZATION_CAPABILITY_MAX_LIFETIME_SECONDS = 15 * 60;
export const PACKAGE_OPERATION_CAPABILITY_MAX_LIFETIME_SECONDS = 5 * 60;

export const PACKAGE_CONTRACT_PURPOSES = {
  activeContentInventory: 'active-content-inventory-v2',
  deliveryBinding: 'delivery-binding-v2',
  deliveryGrant: 'delivery-grant-v2',
  fileTableIndex: 'file-table-index-v2',
  fileTableShard: 'file-table-shard-v2',
  installSession: 'install-session-v2',
  materializationCapability: 'materialization-capability-v2',
  materializationReceipt: 'materialization-receipt-v2',
  membershipIndex: 'membership-index-v2',
  membershipShard: 'membership-shard-v2',
  packageOperationCapability: 'package-operation-capability-v2',
  releaseDescriptor: 'release-descriptor-v2',
} as const;

export type PackageContractPurpose =
  (typeof PACKAGE_CONTRACT_PURPOSES)[keyof typeof PACKAGE_CONTRACT_PURPOSES];

export type PackageContractCborValue =
  | boolean
  | null
  | number
  | string
  | Uint8Array
  | PackageContractCborValue[]
  | Map<number | string, PackageContractCborValue>;

export type InstallSessionBootstrapV2 = {
  kind: string;
  sha256: Uint8Array;
  url: string;
};

export type InstallSessionOperation =
  | 'install'
  | 'preflight'
  | 'recover'
  | 'repair'
  | 'rollback'
  | 'uninstall'
  | 'update';

export type InstallSessionV2 = {
  aliasId: string;
  allowedApiOrigins: string[];
  allowedArtifactOrigins: string[];
  audience: string;
  bindingRoot: Uint8Array;
  bootstrap: InstallSessionBootstrapV2[];
  buyerId: string;
  creatorId: string;
  deviceKeyThumbprint: Uint8Array;
  expiresAt: number;
  issuedAt: number;
  issuer: string;
  keyId: string;
  maxLifetimeSeconds: number;
  notBefore: number;
  operation: InstallSessionOperation;
  productId: string;
  releaseRoot: Uint8Array;
  sessionId: string;
  tokenType: typeof INSTALL_SESSION_TOKEN_TYPE;
  version: string;
};

export type InstallSessionValidationContext = {
  aliasId: string;
  allowedApiOrigins: string[];
  allowedArtifactOrigins: string[];
  audience: string;
  bindingRoot: Uint8Array;
  deviceKeyThumbprint: Uint8Array;
  issuer: string;
  now: number;
  operation: InstallSessionOperation;
  releaseRoot: Uint8Array;
};

export type PackageOperationCapabilityV2 = {
  aliasId: string;
  approvedActiveContentDigest?: Uint8Array;
  approvedPolicyVersion?: string;
  audience: string;
  buyerId: string;
  capabilityId: string;
  deviceKeyThumbprint: Uint8Array;
  expectedCurrentReleaseRoot: Uint8Array;
  expiresAt: number;
  idempotencyKey: string;
  issuedAt: number;
  issuer: string;
  notBefore: number;
  oneUseNonce: Uint8Array;
  operation: InstallSessionOperation;
  projectIdentity: Uint8Array;
  releaseRoot: Uint8Array;
  traceparent: string;
};

export type PackageOperationCapabilityValidationContext = {
  aliasId: string;
  approvedActiveContentDigest?: Uint8Array;
  approvedPolicyVersion?: string;
  audience: string;
  deviceKeyThumbprint: Uint8Array;
  expectedCurrentReleaseRoot: Uint8Array;
  idempotencyKey: string;
  issuer: string;
  now: number;
  operation: InstallSessionOperation;
  projectIdentity: Uint8Array;
  releaseRoot: Uint8Array;
  traceparent: string;
};

export type DeliveryGrantV2 = {
  audience: string;
  bindingRoot: Uint8Array;
  buyerId: string;
  creatorId: string;
  deviceKeyThumbprint: Uint8Array;
  expiresAt: number;
  grantId: string;
  installSessionId: string;
  issuedAt: number;
  issuer: string;
  notBefore: number;
  productId: string;
  releaseRoot: Uint8Array;
  scopes: string[];
};

export type DeliveryGrantValidationContext = {
  audience: string;
  deviceKeyThumbprint: Uint8Array;
  issuer: string;
  now: number;
  requiredScope: string;
};

export type MaterializationCapabilityFileV2 = {
  materializerType: string;
  normalizedPath: string;
  required: boolean;
  sourceSha256: Uint8Array;
};

export type MaterializationJobCapabilityV2 = {
  buyerSubjectPseudonym: string;
  capabilityId: string;
  creatorId: string;
  expiresAt: number;
  grantJti: string;
  issuedAt: number;
  jobId: string;
  keyEpoch: number;
  leaseGeneration: number;
  materializationAlgorithm: string;
  oneUseNonce: Uint8Array;
  outputFormat: 'overlay' | 'zip';
  pluginVersion: string;
  productId: string;
  proofKeyThumbprint: Uint8Array;
  protectedFiles: MaterializationCapabilityFileV2[];
  protectedSourceRoot: Uint8Array;
  pseudonymMethod: string;
  releaseRoot: Uint8Array;
};

export type MaterializedFileV2 = {
  attributionId: string;
  normalizedPath: string;
  outputBytes: number;
  outputSha256: Uint8Array;
};

export type ExactRenditionVersionV2 = {
  bucketName: string;
  fileIdentifier: string;
  objectKey: string;
  objectSha256: Uint8Array;
  objectBytes: number;
  providerVersion: string;
  storageRole: 'renditions';
};

export type MaterializationReceiptV2 = {
  buyerSubjectPseudonym: string;
  capabilityId: string;
  codecBuild: string;
  createdPaths: string[];
  creatorId: string;
  expiresAt: number;
  grantId: string;
  helperBuild: string;
  issuedAt: number;
  jobId: string;
  keyEpoch: number;
  leaseGeneration: number;
  materializationAlgorithm: string;
  materializerId: string;
  outputFiles: MaterializedFileV2[];
  outputTreeRoot: Uint8Array;
  pluginVersion: string;
  productId: string;
  protectedSourceRoot: Uint8Array;
  pseudonymMethod: string;
  receiptId: string;
  releaseRoot: Uint8Array;
  rendition: ExactRenditionVersionV2;
  runtimeBuild: string;
  traceId: string;
};

export type SignedPackageContract = {
  coseSign1: Uint8Array;
  payload: Uint8Array;
};

const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const textEncoder = new TextEncoder();
const SHA256_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const PACKAGE_HASH_PURPOSE_PATTERN = /^yucp:[a-z0-9-]+:v[0-9]+$/;

const CBOR_DECODE_OPTIONS = {
  allowBigInt: false,
  allowIndefinite: false,
  allowInfinity: false,
  allowNaN: false,
  allowUndefined: false,
  rejectDuplicateMapKeys: true,
  strict: true,
  useMaps: true,
} as const;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function optionalBytesEqual(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left === undefined || right === undefined ? left === right : bytesEqual(left, right);
}

export function hashPackageContractFields(
  purpose: string,
  fields: readonly Uint8Array[]
): Uint8Array {
  if (!PACKAGE_HASH_PURPOSE_PATTERN.test(purpose)) {
    throw new Error('Package hash purpose must be a versioned ASCII YUCP purpose');
  }
  const hash = sha256.create();
  hash.update(textEncoder.encode(purpose));
  for (const field of fields) {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(field.byteLength));
    hash.update(length);
    hash.update(field);
  }
  return hash.digest();
}

function assertCborSubset(value: unknown, path: string): asserts value is PackageContractCborValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    value instanceof Uint8Array
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${path} must contain only safe integers`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertCborSubset(entry, `${path}[${index}]`);
    });
    return;
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      if (!(typeof key === 'string' || (typeof key === 'number' && Number.isSafeInteger(key)))) {
        throw new Error(`${path} contains an unsupported map key`);
      }
      assertCborSubset(entry, `${path}.${String(key)}`);
    }
    return;
  }
  throw new Error(`${path} contains an unsupported CBOR value`);
}

export function encodeCanonicalPackageCbor(value: PackageContractCborValue): Uint8Array {
  assertCborSubset(value, 'CBOR value');
  return encode(value, rfc8949EncodeOptions);
}

export function decodeCanonicalPackageCbor(bytes: Uint8Array): PackageContractCborValue {
  const value = decode(bytes, CBOR_DECODE_OPTIONS);
  assertCborSubset(value, 'CBOR value');
  const canonical = encodeCanonicalPackageCbor(value);
  if (!bytesEqual(bytes, canonical)) {
    throw new Error('Package contract CBOR is not deterministic RFC 8949 encoding');
  }
  return value;
}

function requireMap(value: PackageContractCborValue | undefined, name: string) {
  if (!(value instanceof Map)) {
    throw new Error(`${name} must be a CBOR map`);
  }
  return value;
}

function requireArray(value: PackageContractCborValue | undefined, name: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be a CBOR array`);
  }
  return value;
}

function requireString(value: PackageContractCborValue | undefined, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${name} must be a non-empty text string`);
  }
  return value;
}

function requireInteger(value: PackageContractCborValue | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function requireBytes(
  value: PackageContractCborValue | undefined,
  name: string,
  length?: number
): Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) {
    throw new Error(
      length === undefined
        ? `${name} must be a byte string`
        : `${name} must be a ${length}-byte string`
    );
  }
  return value;
}

function requireExactLabels(
  value: Map<number | string, PackageContractCborValue>,
  labels: readonly number[],
  name: string
): void {
  const actual = [...value.keys()];
  if (actual.length !== labels.length || actual.some((label, index) => label !== labels[index])) {
    throw new Error(`${name} contains missing, unknown, or noncanonical labels`);
  }
}

function normalizeOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute origin`);
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (
    (url.protocol !== 'https:' && !loopbackHttp) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTPS or loopback HTTP origin`);
  }
  return url.origin;
}

function normalizeOriginList(values: string[], name: string): string[] {
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one origin`);
  }
  const normalized = values.map((value, index) => normalizeOrigin(value, `${name}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${name} must not contain duplicate origins`);
  }
  return normalized;
}

function readStringArray(value: PackageContractCborValue | undefined, name: string): string[] {
  return requireArray(value, name).map((entry, index) => requireString(entry, `${name}[${index}]`));
}

function requireBoundedText(
  value: PackageContractCborValue | undefined,
  name: string,
  maxBytes: number
): string {
  const text = requireString(value, name);
  if (textEncoder.encode(text).byteLength > maxBytes) {
    throw new Error(`${name} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return text;
}

function requireNonNegativeInteger(
  value: PackageContractCborValue | undefined,
  name: string
): number {
  const integer = requireInteger(value, name);
  if (integer < 0) {
    throw new Error(`${name} must not be negative`);
  }
  return integer;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function requireMaterializedPath(value: string, name: string): string {
  if (
    value !== value.normalize('NFC') ||
    textEncoder.encode(value).byteLength > 1_024 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    !/^(Assets|Packages)\//.test(value) ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`${name} is not a safe normalized Unity path`);
  }
  return value;
}

function uint64Bytes(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Unsigned 64-bit value must be a non-negative safe integer');
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

export function computeOutputTreeRootV2(files: readonly MaterializedFileV2[]): Uint8Array {
  const sorted = [...files].sort((left, right) =>
    compareUtf8(left.normalizedPath, right.normalizedPath)
  );
  return hashPackageContractFields(
    'yucp:output-tree:v2',
    sorted.flatMap((file) => [
      textEncoder.encode(file.normalizedPath),
      file.outputSha256,
      uint64Bytes(file.outputBytes),
    ])
  );
}

function materializationCapabilityFileMap(file: MaterializationCapabilityFileV2) {
  return new Map<number, PackageContractCborValue>([
    [0, file.normalizedPath],
    [1, file.materializerType],
    [2, file.sourceSha256],
    [3, file.required],
  ]);
}

function materializationCapabilityMap(capability: MaterializationJobCapabilityV2) {
  return new Map<number, PackageContractCborValue>([
    [0, PACKAGE_CONTRACT_VERSION],
    [1, capability.capabilityId],
    [2, capability.jobId],
    [3, capability.leaseGeneration],
    [4, capability.creatorId],
    [5, capability.productId],
    [6, capability.buyerSubjectPseudonym],
    [7, capability.pseudonymMethod],
    [8, capability.releaseRoot],
    [9, capability.protectedSourceRoot],
    [10, capability.keyEpoch],
    [11, capability.materializationAlgorithm],
    [12, capability.pluginVersion],
    [13, capability.outputFormat],
    [14, capability.protectedFiles.map(materializationCapabilityFileMap)],
    [15, capability.oneUseNonce],
    [16, capability.issuedAt],
    [17, capability.expiresAt],
    [18, capability.grantJti],
    [19, capability.proofKeyThumbprint],
  ]);
}

export function validateMaterializationCapabilityV2(
  capability: MaterializationJobCapabilityV2
): void {
  for (const [name, value] of Object.entries({
    buyerSubjectPseudonym: capability.buyerSubjectPseudonym,
    capabilityId: capability.capabilityId,
    creatorId: capability.creatorId,
    grantJti: capability.grantJti,
    jobId: capability.jobId,
    materializationAlgorithm: capability.materializationAlgorithm,
    pluginVersion: capability.pluginVersion,
    productId: capability.productId,
    pseudonymMethod: capability.pseudonymMethod,
  })) {
    requireBoundedText(value, `MaterializationJobCapabilityV2.${name}`, 512);
  }
  requireBytes(capability.releaseRoot, 'MaterializationJobCapabilityV2.releaseRoot', SHA256_BYTES);
  requireBytes(
    capability.protectedSourceRoot,
    'MaterializationJobCapabilityV2.protectedSourceRoot',
    SHA256_BYTES
  );
  requireBytes(
    capability.proofKeyThumbprint,
    'MaterializationJobCapabilityV2.proofKeyThumbprint',
    SHA256_BYTES
  );
  requireBytes(capability.oneUseNonce, 'MaterializationJobCapabilityV2.oneUseNonce', SHA256_BYTES);
  requireNonNegativeInteger(
    capability.leaseGeneration,
    'MaterializationJobCapabilityV2.leaseGeneration'
  );
  requireNonNegativeInteger(capability.keyEpoch, 'MaterializationJobCapabilityV2.keyEpoch');
  if (
    !Number.isSafeInteger(capability.issuedAt) ||
    !Number.isSafeInteger(capability.expiresAt) ||
    capability.issuedAt < 0 ||
    capability.expiresAt <= capability.issuedAt
  ) {
    throw new Error('MaterializationJobCapabilityV2 time claims are invalid');
  }
  if (
    capability.expiresAt - capability.issuedAt >
    MATERIALIZATION_CAPABILITY_MAX_LIFETIME_SECONDS
  ) {
    throw new Error('MaterializationJobCapabilityV2 exceeds its maximum lifetime');
  }
  if (capability.outputFormat !== 'overlay' && capability.outputFormat !== 'zip') {
    throw new Error('MaterializationJobCapabilityV2 output format is invalid');
  }
  if (capability.protectedFiles.length === 0 || capability.protectedFiles.length > 512) {
    throw new Error(
      'MaterializationJobCapabilityV2 protected file count must be between 1 and 512'
    );
  }
  for (const [index, file] of capability.protectedFiles.entries()) {
    requireMaterializedPath(
      requireBoundedText(
        file.normalizedPath,
        `MaterializationJobCapabilityV2.protectedFiles[${index}].normalizedPath`,
        1_024
      ),
      `MaterializationJobCapabilityV2.protectedFiles[${index}].normalizedPath`
    );
    requireBoundedText(
      file.materializerType,
      `MaterializationJobCapabilityV2.protectedFiles[${index}].materializerType`,
      128
    );
    requireBytes(
      file.sourceSha256,
      `MaterializationJobCapabilityV2.protectedFiles[${index}].sourceSha256`,
      SHA256_BYTES
    );
    if (typeof file.required !== 'boolean') {
      throw new Error(
        `MaterializationJobCapabilityV2.protectedFiles[${index}].required must be boolean`
      );
    }
    if (
      index > 0 &&
      compareUtf8(capability.protectedFiles[index - 1].normalizedPath, file.normalizedPath) >= 0
    ) {
      throw new Error(
        'MaterializationJobCapabilityV2 protected files must use strict UTF-8 path order'
      );
    }
  }
}

export function encodeMaterializationCapabilityV2(
  capability: MaterializationJobCapabilityV2
): Uint8Array {
  validateMaterializationCapabilityV2(capability);
  return encodeCanonicalPackageCbor(materializationCapabilityMap(capability));
}

export function decodeMaterializationCapabilityV2(
  payload: Uint8Array
): MaterializationJobCapabilityV2 {
  const map = requireMap(decodeCanonicalPackageCbor(payload), 'MaterializationJobCapabilityV2');
  requireExactLabels(
    map,
    Array.from({ length: 20 }, (_, index) => index),
    'MaterializationJobCapabilityV2'
  );
  if (requireInteger(map.get(0), 'MaterializationJobCapabilityV2.schemaVersion') !== 2) {
    throw new Error('MaterializationJobCapabilityV2 schema version is invalid');
  }
  const outputFormat = requireString(map.get(13), 'MaterializationJobCapabilityV2.outputFormat');
  if (outputFormat !== 'overlay' && outputFormat !== 'zip') {
    throw new Error('MaterializationJobCapabilityV2 output format is invalid');
  }
  const protectedFiles = requireArray(
    map.get(14),
    'MaterializationJobCapabilityV2.protectedFiles'
  ).map((value, index) => {
    const file = requireMap(value, `MaterializationJobCapabilityV2.protectedFiles[${index}]`);
    requireExactLabels(
      file,
      [0, 1, 2, 3],
      `MaterializationJobCapabilityV2.protectedFiles[${index}]`
    );
    const required = file.get(3);
    if (typeof required !== 'boolean') {
      throw new Error(
        `MaterializationJobCapabilityV2.protectedFiles[${index}].required must be boolean`
      );
    }
    return {
      materializerType: requireBoundedText(
        file.get(1),
        `MaterializationJobCapabilityV2.protectedFiles[${index}].materializerType`,
        128
      ),
      normalizedPath: requireMaterializedPath(
        requireBoundedText(
          file.get(0),
          `MaterializationJobCapabilityV2.protectedFiles[${index}].normalizedPath`,
          1_024
        ),
        `MaterializationJobCapabilityV2.protectedFiles[${index}].normalizedPath`
      ),
      required,
      sourceSha256: requireBytes(
        file.get(2),
        `MaterializationJobCapabilityV2.protectedFiles[${index}].sourceSha256`,
        SHA256_BYTES
      ),
    };
  });
  const capability: MaterializationJobCapabilityV2 = {
    buyerSubjectPseudonym: requireBoundedText(
      map.get(6),
      'MaterializationJobCapabilityV2.buyerSubjectPseudonym',
      512
    ),
    capabilityId: requireBoundedText(
      map.get(1),
      'MaterializationJobCapabilityV2.capabilityId',
      512
    ),
    creatorId: requireBoundedText(map.get(4), 'MaterializationJobCapabilityV2.creatorId', 512),
    expiresAt: requireInteger(map.get(17), 'MaterializationJobCapabilityV2.expiresAt'),
    grantJti: requireBoundedText(map.get(18), 'MaterializationJobCapabilityV2.grantJti', 512),
    issuedAt: requireInteger(map.get(16), 'MaterializationJobCapabilityV2.issuedAt'),
    jobId: requireBoundedText(map.get(2), 'MaterializationJobCapabilityV2.jobId', 512),
    keyEpoch: requireNonNegativeInteger(map.get(10), 'MaterializationJobCapabilityV2.keyEpoch'),
    leaseGeneration: requireNonNegativeInteger(
      map.get(3),
      'MaterializationJobCapabilityV2.leaseGeneration'
    ),
    materializationAlgorithm: requireBoundedText(
      map.get(11),
      'MaterializationJobCapabilityV2.materializationAlgorithm',
      512
    ),
    oneUseNonce: requireBytes(
      map.get(15),
      'MaterializationJobCapabilityV2.oneUseNonce',
      SHA256_BYTES
    ),
    outputFormat,
    pluginVersion: requireBoundedText(
      map.get(12),
      'MaterializationJobCapabilityV2.pluginVersion',
      512
    ),
    productId: requireBoundedText(map.get(5), 'MaterializationJobCapabilityV2.productId', 512),
    proofKeyThumbprint: requireBytes(
      map.get(19),
      'MaterializationJobCapabilityV2.proofKeyThumbprint',
      SHA256_BYTES
    ),
    protectedFiles,
    protectedSourceRoot: requireBytes(
      map.get(9),
      'MaterializationJobCapabilityV2.protectedSourceRoot',
      SHA256_BYTES
    ),
    pseudonymMethod: requireBoundedText(
      map.get(7),
      'MaterializationJobCapabilityV2.pseudonymMethod',
      512
    ),
    releaseRoot: requireBytes(
      map.get(8),
      'MaterializationJobCapabilityV2.releaseRoot',
      SHA256_BYTES
    ),
  };
  validateMaterializationCapabilityV2(capability);
  return capability;
}

function materializedFileMap(file: MaterializedFileV2) {
  return new Map<number, PackageContractCborValue>([
    [0, file.normalizedPath],
    [1, file.outputSha256],
    [2, file.outputBytes],
    [3, file.attributionId],
  ]);
}

function exactRenditionMap(rendition: ExactRenditionVersionV2) {
  return new Map<number, PackageContractCborValue>([
    [0, rendition.storageRole],
    [1, rendition.bucketName],
    [2, rendition.objectKey],
    [3, rendition.providerVersion],
    [4, rendition.fileIdentifier],
    [5, rendition.objectSha256],
    [6, rendition.objectBytes],
  ]);
}

function materializationReceiptMap(receipt: MaterializationReceiptV2) {
  return new Map<number, PackageContractCborValue>([
    [0, PACKAGE_CONTRACT_VERSION],
    [1, receipt.receiptId],
    [2, receipt.capabilityId],
    [3, receipt.creatorId],
    [4, receipt.buyerSubjectPseudonym],
    [5, receipt.pseudonymMethod],
    [6, receipt.productId],
    [7, receipt.releaseRoot],
    [8, receipt.protectedSourceRoot],
    [9, receipt.outputTreeRoot],
    [10, receipt.outputFiles.map(materializedFileMap)],
    [11, receipt.grantId],
    [12, receipt.jobId],
    [13, receipt.leaseGeneration],
    [14, exactRenditionMap(receipt.rendition)],
    [15, receipt.materializationAlgorithm],
    [16, receipt.pluginVersion],
    [17, receipt.codecBuild],
    [18, receipt.keyEpoch],
    [19, receipt.helperBuild],
    [20, receipt.runtimeBuild],
    [21, receipt.createdPaths],
    [22, receipt.issuedAt],
    [23, receipt.expiresAt],
    [24, receipt.materializerId],
    [25, receipt.traceId],
  ]);
}

export function validateMaterializationReceiptV2(receipt: MaterializationReceiptV2): void {
  for (const [name, value] of Object.entries({
    buyerSubjectPseudonym: receipt.buyerSubjectPseudonym,
    capabilityId: receipt.capabilityId,
    codecBuild: receipt.codecBuild,
    creatorId: receipt.creatorId,
    grantId: receipt.grantId,
    helperBuild: receipt.helperBuild,
    jobId: receipt.jobId,
    materializationAlgorithm: receipt.materializationAlgorithm,
    materializerId: receipt.materializerId,
    pluginVersion: receipt.pluginVersion,
    productId: receipt.productId,
    pseudonymMethod: receipt.pseudonymMethod,
    receiptId: receipt.receiptId,
    runtimeBuild: receipt.runtimeBuild,
    traceId: receipt.traceId,
  })) {
    requireBoundedText(value, `MaterializationReceiptV2.${name}`, 512);
  }
  requireBytes(receipt.releaseRoot, 'MaterializationReceiptV2.releaseRoot', SHA256_BYTES);
  requireBytes(
    receipt.protectedSourceRoot,
    'MaterializationReceiptV2.protectedSourceRoot',
    SHA256_BYTES
  );
  requireBytes(receipt.outputTreeRoot, 'MaterializationReceiptV2.outputTreeRoot', SHA256_BYTES);
  requireNonNegativeInteger(receipt.leaseGeneration, 'MaterializationReceiptV2.leaseGeneration');
  requireNonNegativeInteger(receipt.keyEpoch, 'MaterializationReceiptV2.keyEpoch');
  if (
    !Number.isSafeInteger(receipt.issuedAt) ||
    !Number.isSafeInteger(receipt.expiresAt) ||
    receipt.issuedAt < 0 ||
    receipt.expiresAt <= receipt.issuedAt
  ) {
    throw new Error('MaterializationReceiptV2 time claims are invalid');
  }
  if (receipt.outputFiles.length === 0 || receipt.outputFiles.length > 512) {
    throw new Error('MaterializationReceiptV2 output file count must be between 1 and 512');
  }
  for (const [index, file] of receipt.outputFiles.entries()) {
    requireMaterializedPath(
      requireBoundedText(
        file.normalizedPath,
        `MaterializationReceiptV2.outputFiles[${index}].normalizedPath`,
        1_024
      ),
      `MaterializationReceiptV2.outputFiles[${index}].normalizedPath`
    );
    requireBytes(
      file.outputSha256,
      `MaterializationReceiptV2.outputFiles[${index}].outputSha256`,
      SHA256_BYTES
    );
    requireNonNegativeInteger(
      file.outputBytes,
      `MaterializationReceiptV2.outputFiles[${index}].outputBytes`
    );
    requireBoundedText(
      file.attributionId,
      `MaterializationReceiptV2.outputFiles[${index}].attributionId`,
      512
    );
    if (
      index > 0 &&
      compareUtf8(receipt.outputFiles[index - 1].normalizedPath, file.normalizedPath) >= 0
    ) {
      throw new Error('MaterializationReceiptV2 output files must use strict UTF-8 path order');
    }
  }
  if (
    receipt.createdPaths.length !== receipt.outputFiles.length ||
    receipt.createdPaths.some(
      (createdPath, index) => createdPath !== receipt.outputFiles[index]?.normalizedPath
    )
  ) {
    throw new Error('MaterializationReceiptV2 created paths do not match its output files');
  }
  if (!bytesEqual(receipt.outputTreeRoot, computeOutputTreeRootV2(receipt.outputFiles))) {
    throw new Error('MaterializationReceiptV2 output tree root is invalid');
  }

  if (receipt.rendition.storageRole !== 'renditions') {
    throw new Error('MaterializationReceiptV2 rendition storage role is invalid');
  }
  requireBoundedText(
    receipt.rendition.bucketName,
    'MaterializationReceiptV2.rendition.bucketName',
    255
  );
  requireBoundedText(
    receipt.rendition.objectKey,
    'MaterializationReceiptV2.rendition.objectKey',
    2_048
  );
  requireBoundedText(
    receipt.rendition.providerVersion,
    'MaterializationReceiptV2.rendition.providerVersion',
    512
  );
  requireBoundedText(
    receipt.rendition.fileIdentifier,
    'MaterializationReceiptV2.rendition.fileIdentifier',
    512
  );
  requireBytes(
    receipt.rendition.objectSha256,
    'MaterializationReceiptV2.rendition.objectSha256',
    SHA256_BYTES
  );
  if (!Number.isSafeInteger(receipt.rendition.objectBytes) || receipt.rendition.objectBytes <= 0) {
    throw new Error('MaterializationReceiptV2 rendition object bytes must be positive');
  }
}

export function encodeMaterializationReceiptV2(receipt: MaterializationReceiptV2): Uint8Array {
  validateMaterializationReceiptV2(receipt);
  return encodeCanonicalPackageCbor(materializationReceiptMap(receipt));
}

export function decodeMaterializationReceiptV2(payload: Uint8Array): MaterializationReceiptV2 {
  const map = requireMap(decodeCanonicalPackageCbor(payload), 'MaterializationReceiptV2');
  requireExactLabels(
    map,
    Array.from({ length: 26 }, (_, index) => index),
    'MaterializationReceiptV2'
  );
  if (requireInteger(map.get(0), 'MaterializationReceiptV2.schemaVersion') !== 2) {
    throw new Error('MaterializationReceiptV2 schema version is invalid');
  }
  const outputFiles = requireArray(map.get(10), 'MaterializationReceiptV2.outputFiles').map(
    (value, index) => {
      const file = requireMap(value, `MaterializationReceiptV2.outputFiles[${index}]`);
      requireExactLabels(file, [0, 1, 2, 3], `MaterializationReceiptV2.outputFiles[${index}]`);
      return {
        attributionId: requireBoundedText(
          file.get(3),
          `MaterializationReceiptV2.outputFiles[${index}].attributionId`,
          512
        ),
        normalizedPath: requireMaterializedPath(
          requireBoundedText(
            file.get(0),
            `MaterializationReceiptV2.outputFiles[${index}].normalizedPath`,
            1_024
          ),
          `MaterializationReceiptV2.outputFiles[${index}].normalizedPath`
        ),
        outputBytes: requireNonNegativeInteger(
          file.get(2),
          `MaterializationReceiptV2.outputFiles[${index}].outputBytes`
        ),
        outputSha256: requireBytes(
          file.get(1),
          `MaterializationReceiptV2.outputFiles[${index}].outputSha256`,
          SHA256_BYTES
        ),
      };
    }
  );
  const renditionMap = requireMap(map.get(14), 'MaterializationReceiptV2.rendition');
  requireExactLabels(renditionMap, [0, 1, 2, 3, 4, 5, 6], 'MaterializationReceiptV2.rendition');
  const storageRole = requireString(
    renditionMap.get(0),
    'MaterializationReceiptV2.rendition.storageRole'
  );
  if (storageRole !== 'renditions') {
    throw new Error('MaterializationReceiptV2 rendition storage role is invalid');
  }
  const receipt: MaterializationReceiptV2 = {
    buyerSubjectPseudonym: requireBoundedText(
      map.get(4),
      'MaterializationReceiptV2.buyerSubjectPseudonym',
      512
    ),
    capabilityId: requireBoundedText(map.get(2), 'MaterializationReceiptV2.capabilityId', 512),
    codecBuild: requireBoundedText(map.get(17), 'MaterializationReceiptV2.codecBuild', 512),
    createdPaths: readStringArray(map.get(21), 'MaterializationReceiptV2.createdPaths'),
    creatorId: requireBoundedText(map.get(3), 'MaterializationReceiptV2.creatorId', 512),
    expiresAt: requireInteger(map.get(23), 'MaterializationReceiptV2.expiresAt'),
    grantId: requireBoundedText(map.get(11), 'MaterializationReceiptV2.grantId', 512),
    helperBuild: requireBoundedText(map.get(19), 'MaterializationReceiptV2.helperBuild', 512),
    issuedAt: requireInteger(map.get(22), 'MaterializationReceiptV2.issuedAt'),
    jobId: requireBoundedText(map.get(12), 'MaterializationReceiptV2.jobId', 512),
    keyEpoch: requireNonNegativeInteger(map.get(18), 'MaterializationReceiptV2.keyEpoch'),
    leaseGeneration: requireNonNegativeInteger(
      map.get(13),
      'MaterializationReceiptV2.leaseGeneration'
    ),
    materializationAlgorithm: requireBoundedText(
      map.get(15),
      'MaterializationReceiptV2.materializationAlgorithm',
      512
    ),
    materializerId: requireBoundedText(map.get(24), 'MaterializationReceiptV2.materializerId', 512),
    outputFiles,
    outputTreeRoot: requireBytes(
      map.get(9),
      'MaterializationReceiptV2.outputTreeRoot',
      SHA256_BYTES
    ),
    pluginVersion: requireBoundedText(map.get(16), 'MaterializationReceiptV2.pluginVersion', 512),
    productId: requireBoundedText(map.get(6), 'MaterializationReceiptV2.productId', 512),
    protectedSourceRoot: requireBytes(
      map.get(8),
      'MaterializationReceiptV2.protectedSourceRoot',
      SHA256_BYTES
    ),
    pseudonymMethod: requireBoundedText(
      map.get(5),
      'MaterializationReceiptV2.pseudonymMethod',
      512
    ),
    receiptId: requireBoundedText(map.get(1), 'MaterializationReceiptV2.receiptId', 512),
    releaseRoot: requireBytes(map.get(7), 'MaterializationReceiptV2.releaseRoot', SHA256_BYTES),
    rendition: {
      bucketName: requireBoundedText(
        renditionMap.get(1),
        'MaterializationReceiptV2.rendition.bucketName',
        255
      ),
      fileIdentifier: requireBoundedText(
        renditionMap.get(4),
        'MaterializationReceiptV2.rendition.fileIdentifier',
        512
      ),
      objectBytes: requireInteger(
        renditionMap.get(6),
        'MaterializationReceiptV2.rendition.objectBytes'
      ),
      objectKey: requireBoundedText(
        renditionMap.get(2),
        'MaterializationReceiptV2.rendition.objectKey',
        2_048
      ),
      objectSha256: requireBytes(
        renditionMap.get(5),
        'MaterializationReceiptV2.rendition.objectSha256',
        SHA256_BYTES
      ),
      providerVersion: requireBoundedText(
        renditionMap.get(3),
        'MaterializationReceiptV2.rendition.providerVersion',
        512
      ),
      storageRole: 'renditions',
    },
    runtimeBuild: requireBoundedText(map.get(20), 'MaterializationReceiptV2.runtimeBuild', 512),
    traceId: requireBoundedText(map.get(25), 'MaterializationReceiptV2.traceId', 512),
  };
  validateMaterializationReceiptV2(receipt);
  return receipt;
}

function packageOperationCapabilityMap(capability: PackageOperationCapabilityV2) {
  return new Map<number, PackageContractCborValue>([
    [0, PACKAGE_CONTRACT_VERSION],
    [1, capability.capabilityId],
    [2, capability.issuer],
    [3, capability.audience],
    [4, capability.buyerId],
    [5, capability.aliasId],
    [6, capability.releaseRoot],
    [7, capability.expectedCurrentReleaseRoot],
    [8, capability.operation],
    [9, capability.projectIdentity],
    [10, capability.approvedActiveContentDigest ?? null],
    [11, capability.approvedPolicyVersion ?? null],
    [12, capability.idempotencyKey],
    [13, capability.deviceKeyThumbprint],
    [14, capability.oneUseNonce],
    [15, capability.issuedAt],
    [16, capability.notBefore],
    [17, capability.expiresAt],
    [18, capability.traceparent],
  ]);
}

export function validatePackageOperationCapabilityV2(
  capability: PackageOperationCapabilityV2,
  context?: PackageOperationCapabilityValidationContext
): void {
  for (const [name, value] of Object.entries({
    aliasId: capability.aliasId,
    audience: capability.audience,
    buyerId: capability.buyerId,
    capabilityId: capability.capabilityId,
    idempotencyKey: capability.idempotencyKey,
    issuer: capability.issuer,
  })) {
    requireBoundedText(value, `PackageOperationCapabilityV2.${name}`, 512);
  }
  const issuer = normalizeOrigin(capability.issuer, 'PackageOperationCapabilityV2.issuer');
  const audience = normalizeOrigin(capability.audience, 'PackageOperationCapabilityV2.audience');
  if (
    !['install', 'preflight', 'recover', 'repair', 'rollback', 'uninstall', 'update'].includes(
      capability.operation
    )
  ) {
    throw new Error('PackageOperationCapabilityV2 operation is invalid');
  }
  requireBytes(
    capability.deviceKeyThumbprint,
    'PackageOperationCapabilityV2.deviceKeyThumbprint',
    SHA256_BYTES
  );
  requireBytes(capability.oneUseNonce, 'PackageOperationCapabilityV2.oneUseNonce', SHA256_BYTES);
  requireBytes(
    capability.projectIdentity,
    'PackageOperationCapabilityV2.projectIdentity',
    SHA256_BYTES
  );
  requireBytes(capability.releaseRoot, 'PackageOperationCapabilityV2.releaseRoot', SHA256_BYTES);
  requireBytes(
    capability.expectedCurrentReleaseRoot,
    'PackageOperationCapabilityV2.expectedCurrentReleaseRoot',
    SHA256_BYTES
  );
  const hasApproval =
    capability.approvedActiveContentDigest !== undefined ||
    capability.approvedPolicyVersion !== undefined;
  if (capability.operation === 'preflight') {
    if (hasApproval) {
      throw new Error('PackageOperationCapabilityV2 preflight must not carry content approval');
    }
  } else {
    requireBytes(
      capability.approvedActiveContentDigest,
      'PackageOperationCapabilityV2.approvedActiveContentDigest',
      SHA256_BYTES
    );
    requireBoundedText(
      capability.approvedPolicyVersion,
      'PackageOperationCapabilityV2.approvedPolicyVersion',
      512
    );
  }
  if (!parseTraceparent(capability.traceparent)) {
    throw new Error('PackageOperationCapabilityV2 traceparent is invalid');
  }
  if (
    !Number.isSafeInteger(capability.issuedAt) ||
    !Number.isSafeInteger(capability.notBefore) ||
    !Number.isSafeInteger(capability.expiresAt) ||
    capability.issuedAt < 0 ||
    capability.notBefore < capability.issuedAt ||
    capability.expiresAt <= capability.notBefore ||
    capability.expiresAt - capability.issuedAt > PACKAGE_OPERATION_CAPABILITY_MAX_LIFETIME_SECONDS
  ) {
    throw new Error('PackageOperationCapabilityV2 time claims are invalid');
  }
  if (!context) {
    return;
  }
  if (context.now < capability.notBefore || context.now >= capability.expiresAt) {
    throw new Error('PackageOperationCapabilityV2 is not active');
  }
  if (
    capability.aliasId !== context.aliasId ||
    capability.approvedPolicyVersion !== context.approvedPolicyVersion ||
    capability.idempotencyKey !== context.idempotencyKey ||
    capability.operation !== context.operation ||
    capability.traceparent !== context.traceparent ||
    issuer !== normalizeOrigin(context.issuer, 'Expected package operation issuer') ||
    audience !== normalizeOrigin(context.audience, 'Expected package operation audience') ||
    !bytesEqual(capability.deviceKeyThumbprint, context.deviceKeyThumbprint) ||
    !bytesEqual(capability.projectIdentity, context.projectIdentity) ||
    !bytesEqual(capability.releaseRoot, context.releaseRoot) ||
    !optionalBytesEqual(
      capability.approvedActiveContentDigest,
      context.approvedActiveContentDigest
    ) ||
    !bytesEqual(capability.expectedCurrentReleaseRoot, context.expectedCurrentReleaseRoot)
  ) {
    throw new Error('PackageOperationCapabilityV2 is not bound to the requested operation');
  }
}

export function encodePackageOperationCapabilityV2(
  capability: PackageOperationCapabilityV2
): Uint8Array {
  validatePackageOperationCapabilityV2(capability);
  return encodeCanonicalPackageCbor(packageOperationCapabilityMap(capability));
}

export function decodePackageOperationCapabilityV2(
  payload: Uint8Array
): PackageOperationCapabilityV2 {
  const map = requireMap(decodeCanonicalPackageCbor(payload), 'PackageOperationCapabilityV2');
  requireExactLabels(
    map,
    Array.from({ length: 19 }, (_, index) => index),
    'PackageOperationCapabilityV2'
  );
  if (requireInteger(map.get(0), 'PackageOperationCapabilityV2.schemaVersion') !== 2) {
    throw new Error('PackageOperationCapabilityV2 schema version is invalid');
  }
  const approvedActiveContentDigest = map.get(10);
  const approvedPolicyVersion = map.get(11);
  const capability: PackageOperationCapabilityV2 = {
    aliasId: requireBoundedText(map.get(5), 'PackageOperationCapabilityV2.aliasId', 512),
    audience: requireBoundedText(map.get(3), 'PackageOperationCapabilityV2.audience', 2_048),
    buyerId: requireBoundedText(map.get(4), 'PackageOperationCapabilityV2.buyerId', 512),
    capabilityId: requireBoundedText(map.get(1), 'PackageOperationCapabilityV2.capabilityId', 512),
    deviceKeyThumbprint: requireBytes(
      map.get(13),
      'PackageOperationCapabilityV2.deviceKeyThumbprint',
      SHA256_BYTES
    ),
    expiresAt: requireInteger(map.get(17), 'PackageOperationCapabilityV2.expiresAt'),
    expectedCurrentReleaseRoot: requireBytes(
      map.get(7),
      'PackageOperationCapabilityV2.expectedCurrentReleaseRoot',
      SHA256_BYTES
    ),
    idempotencyKey: requireBoundedText(
      map.get(12),
      'PackageOperationCapabilityV2.idempotencyKey',
      512
    ),
    issuedAt: requireInteger(map.get(15), 'PackageOperationCapabilityV2.issuedAt'),
    issuer: requireBoundedText(map.get(2), 'PackageOperationCapabilityV2.issuer', 2_048),
    notBefore: requireInteger(map.get(16), 'PackageOperationCapabilityV2.notBefore'),
    oneUseNonce: requireBytes(
      map.get(14),
      'PackageOperationCapabilityV2.oneUseNonce',
      SHA256_BYTES
    ),
    operation: requireBoundedText(
      map.get(8),
      'PackageOperationCapabilityV2.operation',
      32
    ) as InstallSessionOperation,
    projectIdentity: requireBytes(
      map.get(9),
      'PackageOperationCapabilityV2.projectIdentity',
      SHA256_BYTES
    ),
    releaseRoot: requireBytes(map.get(6), 'PackageOperationCapabilityV2.releaseRoot', SHA256_BYTES),
    traceparent: requireBoundedText(map.get(18), 'PackageOperationCapabilityV2.traceparent', 55),
    ...(approvedActiveContentDigest === null
      ? {}
      : {
          approvedActiveContentDigest: requireBytes(
            approvedActiveContentDigest,
            'PackageOperationCapabilityV2.approvedActiveContentDigest',
            SHA256_BYTES
          ),
        }),
    ...(approvedPolicyVersion === null
      ? {}
      : {
          approvedPolicyVersion: requireBoundedText(
            approvedPolicyVersion,
            'PackageOperationCapabilityV2.approvedPolicyVersion',
            512
          ),
        }),
  };
  validatePackageOperationCapabilityV2(capability);
  return capability;
}

export async function verifyPackageOperationCapabilityV2(input: {
  context: PackageOperationCapabilityValidationContext;
  coseSign1: Uint8Array;
  expectedKeyId: Uint8Array;
  publicKey: Uint8Array;
}): Promise<PackageOperationCapabilityV2> {
  const payload = await verifyPackageContract({
    coseSign1: input.coseSign1,
    expectedKeyId: input.expectedKeyId,
    expectedPurpose: PACKAGE_CONTRACT_PURPOSES.packageOperationCapability,
    publicKey: input.publicKey,
  });
  const capability = decodePackageOperationCapabilityV2(payload);
  validatePackageOperationCapabilityV2(capability, input.context);
  return capability;
}

function deliveryGrantMap(grant: DeliveryGrantV2) {
  return new Map<number, PackageContractCborValue>([
    [0, PACKAGE_CONTRACT_VERSION],
    [1, grant.grantId],
    [2, grant.issuer],
    [3, grant.audience],
    [4, grant.creatorId],
    [5, grant.buyerId],
    [6, grant.productId],
    [7, grant.releaseRoot],
    [8, grant.bindingRoot],
    [9, grant.deviceKeyThumbprint],
    [10, grant.issuedAt],
    [11, grant.notBefore],
    [12, grant.expiresAt],
    [13, grant.scopes],
    [14, grant.installSessionId],
  ]);
}

export function validateDeliveryGrantV2(
  grant: DeliveryGrantV2,
  context?: DeliveryGrantValidationContext
): void {
  for (const [name, value] of Object.entries({
    audience: grant.audience,
    buyerId: grant.buyerId,
    creatorId: grant.creatorId,
    grantId: grant.grantId,
    installSessionId: grant.installSessionId,
    issuer: grant.issuer,
    productId: grant.productId,
  })) {
    requireBoundedText(value, `DeliveryGrantV2.${name}`, 512);
  }
  const issuer = normalizeOrigin(grant.issuer, 'DeliveryGrantV2.issuer');
  requireBytes(grant.releaseRoot, 'DeliveryGrantV2.releaseRoot', SHA256_BYTES);
  requireBytes(grant.bindingRoot, 'DeliveryGrantV2.bindingRoot', SHA256_BYTES);
  requireBytes(grant.deviceKeyThumbprint, 'DeliveryGrantV2.deviceKeyThumbprint', SHA256_BYTES);
  if (grant.scopes.length < 1 || grant.scopes.length > 16) {
    throw new Error('DeliveryGrantV2 scope count must be between 1 and 16');
  }
  for (const [index, scope] of grant.scopes.entries()) {
    requireBoundedText(scope, `DeliveryGrantV2.scopes[${index}]`, 512);
    if (index > 0 && compareUtf8(grant.scopes[index - 1] ?? '', scope) >= 0) {
      throw new Error('DeliveryGrantV2 scopes must use strict UTF-8 order');
    }
  }
  if (
    !Number.isSafeInteger(grant.issuedAt) ||
    !Number.isSafeInteger(grant.notBefore) ||
    !Number.isSafeInteger(grant.expiresAt) ||
    grant.issuedAt < 0 ||
    grant.notBefore < grant.issuedAt ||
    grant.expiresAt <= grant.notBefore ||
    grant.expiresAt - grant.issuedAt > DELIVERY_GRANT_MAX_LIFETIME_SECONDS
  ) {
    throw new Error('DeliveryGrantV2 time claims are invalid');
  }
  if (!context) {
    return;
  }
  if (context.now < grant.notBefore || context.now >= grant.expiresAt) {
    throw new Error('DeliveryGrantV2 is not active');
  }
  if (grant.audience !== context.audience) {
    throw new Error('DeliveryGrantV2 audience is not bound to the requested delivery');
  }
  if (issuer !== normalizeOrigin(context.issuer, 'Expected delivery grant issuer')) {
    throw new Error('DeliveryGrantV2 issuer is not bound to the requested delivery');
  }
  if (!bytesEqual(grant.deviceKeyThumbprint, context.deviceKeyThumbprint)) {
    throw new Error('DeliveryGrantV2 device key is not bound to the requested delivery');
  }
  if (!grant.scopes.includes(context.requiredScope)) {
    throw new Error('DeliveryGrantV2 scope is not bound to the requested delivery');
  }
}

export function encodeDeliveryGrantV2(grant: DeliveryGrantV2): Uint8Array {
  validateDeliveryGrantV2(grant);
  return encodeCanonicalPackageCbor(deliveryGrantMap(grant));
}

export function decodeDeliveryGrantV2(payload: Uint8Array): DeliveryGrantV2 {
  const map = requireMap(decodeCanonicalPackageCbor(payload), 'DeliveryGrantV2');
  requireExactLabels(
    map,
    Array.from({ length: 15 }, (_, index) => index),
    'DeliveryGrantV2'
  );
  if (requireInteger(map.get(0), 'DeliveryGrantV2.schemaVersion') !== 2) {
    throw new Error('DeliveryGrantV2 schema version is invalid');
  }
  const grant: DeliveryGrantV2 = {
    audience: requireBoundedText(map.get(3), 'DeliveryGrantV2.audience', 512),
    bindingRoot: requireBytes(map.get(8), 'DeliveryGrantV2.bindingRoot', SHA256_BYTES),
    buyerId: requireBoundedText(map.get(5), 'DeliveryGrantV2.buyerId', 512),
    creatorId: requireBoundedText(map.get(4), 'DeliveryGrantV2.creatorId', 512),
    deviceKeyThumbprint: requireBytes(
      map.get(9),
      'DeliveryGrantV2.deviceKeyThumbprint',
      SHA256_BYTES
    ),
    expiresAt: requireInteger(map.get(12), 'DeliveryGrantV2.expiresAt'),
    grantId: requireBoundedText(map.get(1), 'DeliveryGrantV2.grantId', 512),
    installSessionId: requireBoundedText(map.get(14), 'DeliveryGrantV2.installSessionId', 512),
    issuedAt: requireInteger(map.get(10), 'DeliveryGrantV2.issuedAt'),
    issuer: requireBoundedText(map.get(2), 'DeliveryGrantV2.issuer', 2_048),
    notBefore: requireInteger(map.get(11), 'DeliveryGrantV2.notBefore'),
    productId: requireBoundedText(map.get(6), 'DeliveryGrantV2.productId', 512),
    releaseRoot: requireBytes(map.get(7), 'DeliveryGrantV2.releaseRoot', SHA256_BYTES),
    scopes: readStringArray(map.get(13), 'DeliveryGrantV2.scopes'),
  };
  validateDeliveryGrantV2(grant);
  return grant;
}

function bootstrapMap(bootstrap: InstallSessionBootstrapV2) {
  return new Map<number, PackageContractCborValue>([
    [0, bootstrap.kind],
    [1, bootstrap.url],
    [2, bootstrap.sha256],
  ]);
}

function installSessionMap(session: InstallSessionV2) {
  return new Map<number, PackageContractCborValue>([
    [0, PACKAGE_CONTRACT_VERSION],
    [1, session.tokenType],
    [2, session.issuer],
    [3, session.audience],
    [4, session.keyId],
    [5, session.creatorId],
    [6, session.buyerId],
    [7, session.productId],
    [8, session.version],
    [9, session.aliasId],
    [10, session.releaseRoot],
    [11, session.bindingRoot],
    [12, session.deviceKeyThumbprint],
    [13, session.allowedApiOrigins],
    [14, session.allowedArtifactOrigins],
    [15, session.bootstrap.map(bootstrapMap)],
    [16, session.issuedAt],
    [17, session.notBefore],
    [18, session.expiresAt],
    [19, session.sessionId],
    [20, session.maxLifetimeSeconds],
    [21, session.operation],
  ]);
}

export function encodeInstallSessionV2(session: InstallSessionV2): Uint8Array {
  validateInstallSessionV2(session);
  return encodeCanonicalPackageCbor(installSessionMap(session));
}

export function decodeInstallSessionV2(payload: Uint8Array): InstallSessionV2 {
  const map = requireMap(decodeCanonicalPackageCbor(payload), 'InstallSessionV2');
  requireExactLabels(
    map,
    Array.from({ length: 22 }, (_, index) => index),
    'InstallSessionV2'
  );
  const bootstrap = requireArray(map.get(15), 'InstallSessionV2.bootstrap').map((value, index) => {
    const item = requireMap(value, `InstallSessionV2.bootstrap[${index}]`);
    requireExactLabels(item, [0, 1, 2], `InstallSessionV2.bootstrap[${index}]`);
    return {
      kind: requireString(item.get(0), `InstallSessionV2.bootstrap[${index}].kind`),
      url: requireString(item.get(1), `InstallSessionV2.bootstrap[${index}].url`),
      sha256: requireBytes(
        item.get(2),
        `InstallSessionV2.bootstrap[${index}].sha256`,
        SHA256_BYTES
      ),
    };
  });
  const tokenType = requireString(map.get(1), 'InstallSessionV2.tokenType');
  if (tokenType !== INSTALL_SESSION_TOKEN_TYPE) {
    throw new Error('InstallSessionV2 token type is invalid');
  }
  const session: InstallSessionV2 = {
    aliasId: requireString(map.get(9), 'InstallSessionV2.aliasId'),
    allowedApiOrigins: readStringArray(map.get(13), 'InstallSessionV2.allowedApiOrigins'),
    allowedArtifactOrigins: readStringArray(map.get(14), 'InstallSessionV2.allowedArtifactOrigins'),
    audience: requireString(map.get(3), 'InstallSessionV2.audience'),
    bindingRoot: requireBytes(map.get(11), 'InstallSessionV2.bindingRoot', SHA256_BYTES),
    bootstrap,
    buyerId: requireString(map.get(6), 'InstallSessionV2.buyerId'),
    creatorId: requireString(map.get(5), 'InstallSessionV2.creatorId'),
    deviceKeyThumbprint: requireBytes(
      map.get(12),
      'InstallSessionV2.deviceKeyThumbprint',
      SHA256_BYTES
    ),
    expiresAt: requireInteger(map.get(18), 'InstallSessionV2.expiresAt'),
    issuedAt: requireInteger(map.get(16), 'InstallSessionV2.issuedAt'),
    issuer: requireString(map.get(2), 'InstallSessionV2.issuer'),
    keyId: requireString(map.get(4), 'InstallSessionV2.keyId'),
    maxLifetimeSeconds: requireInteger(map.get(20), 'InstallSessionV2.maxLifetimeSeconds'),
    notBefore: requireInteger(map.get(17), 'InstallSessionV2.notBefore'),
    operation: requireString(map.get(21), 'InstallSessionV2.operation') as InstallSessionOperation,
    productId: requireString(map.get(7), 'InstallSessionV2.productId'),
    releaseRoot: requireBytes(map.get(10), 'InstallSessionV2.releaseRoot', SHA256_BYTES),
    sessionId: requireString(map.get(19), 'InstallSessionV2.sessionId'),
    tokenType: INSTALL_SESSION_TOKEN_TYPE,
    version: requireString(map.get(8), 'InstallSessionV2.version'),
  };
  if (requireInteger(map.get(0), 'InstallSessionV2.schemaVersion') !== 2) {
    throw new Error('InstallSessionV2 schema version is invalid');
  }
  validateInstallSessionV2(session);
  return session;
}

export function validateInstallSessionV2(
  session: InstallSessionV2,
  context?: InstallSessionValidationContext
): void {
  if (session.tokenType !== INSTALL_SESSION_TOKEN_TYPE) {
    throw new Error('InstallSessionV2 token type is invalid');
  }
  if (
    !['install', 'preflight', 'recover', 'repair', 'rollback', 'uninstall', 'update'].includes(
      session.operation
    )
  ) {
    throw new Error('InstallSessionV2 operation is invalid');
  }
  for (const [name, value] of Object.entries({
    aliasId: session.aliasId,
    audience: session.audience,
    buyerId: session.buyerId,
    creatorId: session.creatorId,
    issuer: session.issuer,
    keyId: session.keyId,
    productId: session.productId,
    sessionId: session.sessionId,
    version: session.version,
  })) {
    if (!value || value.length > 512) {
      throw new Error(`InstallSessionV2 ${name} must contain 1 through 512 characters`);
    }
  }
  requireBytes(session.releaseRoot, 'InstallSessionV2.releaseRoot', SHA256_BYTES);
  requireBytes(session.bindingRoot, 'InstallSessionV2.bindingRoot', SHA256_BYTES);
  requireBytes(session.deviceKeyThumbprint, 'InstallSessionV2.deviceKeyThumbprint', SHA256_BYTES);
  const apiOrigins = normalizeOriginList(
    session.allowedApiOrigins,
    'InstallSessionV2.allowedApiOrigins'
  );
  const artifactOrigins = normalizeOriginList(
    session.allowedArtifactOrigins,
    'InstallSessionV2.allowedArtifactOrigins'
  );
  if (session.bootstrap.length === 0 || session.bootstrap.length > 16) {
    throw new Error('InstallSessionV2 bootstrap count must be between 1 and 16');
  }
  const allowedBootstrapOrigins = new Set([...apiOrigins, ...artifactOrigins]);
  for (const [index, bootstrap] of session.bootstrap.entries()) {
    requireString(bootstrap.kind, `InstallSessionV2.bootstrap[${index}].kind`);
    requireBytes(bootstrap.sha256, `InstallSessionV2.bootstrap[${index}].sha256`, SHA256_BYTES);
    const url = new URL(bootstrap.url);
    if (!allowedBootstrapOrigins.has(url.origin) || url.username || url.password || url.hash) {
      throw new Error(`InstallSessionV2 bootstrap[${index}] URL is outside allowed origins`);
    }
  }
  if (
    !Number.isSafeInteger(session.issuedAt) ||
    !Number.isSafeInteger(session.notBefore) ||
    !Number.isSafeInteger(session.expiresAt) ||
    session.issuedAt < 0 ||
    session.notBefore < session.issuedAt ||
    session.expiresAt <= session.notBefore
  ) {
    throw new Error('InstallSessionV2 time claims are invalid');
  }
  if (
    !Number.isSafeInteger(session.maxLifetimeSeconds) ||
    session.maxLifetimeSeconds <= 0 ||
    session.maxLifetimeSeconds > INSTALL_SESSION_MAX_LIFETIME_SECONDS ||
    session.expiresAt - session.issuedAt > session.maxLifetimeSeconds
  ) {
    throw new Error('InstallSessionV2 lifetime exceeds its bounded policy');
  }
  if (!context) {
    return;
  }
  if (context.now < session.notBefore || context.now >= session.expiresAt) {
    throw new Error('InstallSessionV2 is not active');
  }
  if (
    session.aliasId !== context.aliasId ||
    session.audience !== context.audience ||
    session.issuer !== context.issuer ||
    session.operation !== context.operation ||
    !bytesEqual(session.releaseRoot, context.releaseRoot) ||
    !bytesEqual(session.bindingRoot, context.bindingRoot) ||
    !bytesEqual(session.deviceKeyThumbprint, context.deviceKeyThumbprint)
  ) {
    throw new Error('InstallSessionV2 is not bound to the requested install');
  }
  if (
    apiOrigins.length !== context.allowedApiOrigins.length ||
    artifactOrigins.length !== context.allowedArtifactOrigins.length ||
    apiOrigins.some(
      (origin, index) =>
        origin !== normalizeOrigin(context.allowedApiOrigins[index], 'Expected API origin')
    ) ||
    artifactOrigins.some(
      (origin, index) =>
        origin !==
        normalizeOrigin(context.allowedArtifactOrigins[index], 'Expected artifact origin')
    )
  ) {
    throw new Error('InstallSessionV2 origin binding is invalid');
  }
}

function protectedHeader(purpose: PackageContractPurpose, keyId: Uint8Array) {
  return new Map<number, PackageContractCborValue>([
    [1, PACKAGE_COSE_ALGORITHM_EDDSA],
    [2, [PACKAGE_COSE_PURPOSE_HEADER]],
    [4, keyId],
    [PACKAGE_COSE_PURPOSE_HEADER, purpose],
  ]);
}

function signatureStructure(protectedBytes: Uint8Array, payload: Uint8Array) {
  return encodeCanonicalPackageCbor(['Signature1', protectedBytes, new Uint8Array(), payload]);
}

export async function signPackageContract(input: {
  keyId: Uint8Array;
  payload: Uint8Array;
  privateKey: Uint8Array;
  purpose: PackageContractPurpose;
}): Promise<SignedPackageContract> {
  decodeCanonicalPackageCbor(input.payload);
  if (input.keyId.length === 0 || input.keyId.length > 64) {
    throw new Error('Package contract key ID must contain 1 through 64 bytes');
  }
  const protectedBytes = encodeCanonicalPackageCbor(protectedHeader(input.purpose, input.keyId));
  const signature = await ed25519.signAsync(
    signatureStructure(protectedBytes, input.payload),
    input.privateKey
  );
  const coseSign1 = encodeCanonicalPackageCbor([
    protectedBytes,
    new Map(),
    input.payload,
    signature,
  ]);
  return { coseSign1, payload: input.payload };
}

export async function verifyPackageContract(input: {
  coseSign1: Uint8Array;
  expectedKeyId?: Uint8Array;
  expectedPurpose: PackageContractPurpose;
  publicKey: Uint8Array;
}): Promise<Uint8Array> {
  const envelope = requireArray(decodeCanonicalPackageCbor(input.coseSign1), 'COSE_Sign1');
  if (envelope.length !== 4) {
    throw new Error('COSE_Sign1 must contain four fields');
  }
  const protectedBytes = requireBytes(envelope[0], 'COSE_Sign1 protected headers');
  const unprotected = requireMap(envelope[1], 'COSE_Sign1 unprotected headers');
  if (unprotected.size !== 0) {
    throw new Error('COSE_Sign1 unprotected headers must be empty');
  }
  const payload = requireBytes(envelope[2], 'COSE_Sign1 payload');
  const signature = requireBytes(envelope[3], 'COSE_Sign1 signature', ED25519_SIGNATURE_BYTES);
  const headers = requireMap(
    decodeCanonicalPackageCbor(protectedBytes),
    'COSE_Sign1 protected headers'
  );
  requireExactLabels(headers, [1, 2, 4, PACKAGE_COSE_PURPOSE_HEADER], 'COSE_Sign1 headers');
  if (requireInteger(headers.get(1), 'COSE algorithm') !== PACKAGE_COSE_ALGORITHM_EDDSA) {
    throw new Error('COSE_Sign1 algorithm is not EdDSA');
  }
  const critical = requireArray(headers.get(2), 'COSE critical headers');
  if (
    critical.length !== 1 ||
    requireInteger(critical[0], 'COSE purpose critical header') !== PACKAGE_COSE_PURPOSE_HEADER
  ) {
    throw new Error('COSE_Sign1 purpose header is not critical');
  }
  const keyId = requireBytes(headers.get(4), 'COSE key ID');
  if (input.expectedKeyId && !bytesEqual(keyId, input.expectedKeyId)) {
    throw new Error('COSE_Sign1 key ID is not trusted');
  }
  if (
    requireString(headers.get(PACKAGE_COSE_PURPOSE_HEADER), 'COSE purpose') !==
    input.expectedPurpose
  ) {
    throw new Error('COSE_Sign1 purpose does not match the expected contract');
  }
  decodeCanonicalPackageCbor(payload);
  if (
    !(await ed25519.verifyAsync(
      signature,
      signatureStructure(protectedBytes, payload),
      input.publicKey
    ))
  ) {
    throw new Error('COSE_Sign1 signature is invalid');
  }
  return payload;
}

export async function verifyMaterializationReceiptV2(input: {
  coseSign1: Uint8Array;
  expectedKeyId?: Uint8Array;
  publicKey: Uint8Array;
}): Promise<MaterializationReceiptV2> {
  return decodeMaterializationReceiptV2(
    await verifyPackageContract({
      coseSign1: input.coseSign1,
      expectedKeyId: input.expectedKeyId,
      expectedPurpose: PACKAGE_CONTRACT_PURPOSES.materializationReceipt,
      publicKey: input.publicKey,
    })
  );
}

export async function verifyMaterializationCapabilityV2(input: {
  coseSign1: Uint8Array;
  expectedKeyId?: Uint8Array;
  publicKey: Uint8Array;
}): Promise<MaterializationJobCapabilityV2> {
  return decodeMaterializationCapabilityV2(
    await verifyPackageContract({
      coseSign1: input.coseSign1,
      expectedKeyId: input.expectedKeyId,
      expectedPurpose: PACKAGE_CONTRACT_PURPOSES.materializationCapability,
      publicKey: input.publicKey,
    })
  );
}

export async function verifyDeliveryGrantV2(input: {
  context: DeliveryGrantValidationContext;
  coseSign1: Uint8Array;
  expectedKeyId?: Uint8Array;
  publicKey: Uint8Array;
}): Promise<DeliveryGrantV2> {
  const grant = decodeDeliveryGrantV2(
    await verifyPackageContract({
      coseSign1: input.coseSign1,
      expectedKeyId: input.expectedKeyId,
      expectedPurpose: PACKAGE_CONTRACT_PURPOSES.deliveryGrant,
      publicKey: input.publicKey,
    })
  );
  validateDeliveryGrantV2(grant, input.context);
  return grant;
}

export async function verifyInstallSessionV2(input: {
  context: InstallSessionValidationContext;
  coseSign1: Uint8Array;
  expectedKeyId: Uint8Array;
  publicKey: Uint8Array;
}): Promise<InstallSessionV2> {
  const payload = await verifyPackageContract({
    coseSign1: input.coseSign1,
    expectedKeyId: input.expectedKeyId,
    expectedPurpose: PACKAGE_CONTRACT_PURPOSES.installSession,
    publicKey: input.publicKey,
  });
  const session = decodeInstallSessionV2(payload);
  if (session.keyId !== textDecoder.decode(input.expectedKeyId)) {
    throw new Error('InstallSessionV2 key ID claim does not match its COSE header');
  }
  validateInstallSessionV2(session, input.context);
  return session;
}

export function packageContractKeyId(value: string): Uint8Array {
  const bytes = textEncoder.encode(value);
  if (bytes.length === 0 || bytes.length > 64) {
    throw new Error('Package contract key ID must contain 1 through 64 UTF-8 bytes');
  }
  return bytes;
}
