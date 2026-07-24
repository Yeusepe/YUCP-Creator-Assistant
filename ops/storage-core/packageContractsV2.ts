import { createHash } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
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

const textDecoder = new TextDecoder('utf-8', { fatal: true });
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

export function hashPackageContractFields(
  purpose: string,
  fields: readonly Uint8Array[]
): Uint8Array {
  if (!PACKAGE_HASH_PURPOSE_PATTERN.test(purpose)) {
    throw new Error('Package hash purpose must be a versioned ASCII YUCP purpose');
  }
  const hash = createHash('sha256');
  hash.update(purpose, 'ascii');
  for (const field of fields) {
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(field.byteLength));
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
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
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
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
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
    Array.from({ length: 21 }, (_, index) => index),
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
