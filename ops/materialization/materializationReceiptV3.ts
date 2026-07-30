import {
  computeOutputTreeRootV2,
  decodeCanonicalPackageCbor,
  encodeCanonicalPackageCbor,
  type MaterializationReceiptV2,
  type MaterializedFileV2,
  PACKAGE_CONTRACT_VERSION,
  type PackageContractCborValue,
  type PackageContractPurpose,
  verifyPackageContract,
} from '../storage-core/packageContractsV2';

/**
 * Materialization receipt v3 for per-file coupled delivery.
 *
 * The CBOR label layout is identical to materialization-receipt-v2 EXCEPT the
 * rendition exact-object label (14: fileIdentifier/objectBytes/objectSha256)
 * is ABSENT, and the output file cap is 4096 instead of 512. The COSE purpose
 * string is 'materialization-receipt-v3'. All other labels and bindings
 * (receiptId, jobId, grantId, productId, creatorId, releaseRoot,
 * outputTreeRoot, createdPaths, issuedAt/expiresAt) are unchanged.
 *
 * This lives beside the broker rather than in packageContractsV2 because
 * ops/storage-core is frozen on this branch; fold it into packageContractsV2
 * when that module thaws.
 */

export const MATERIALIZATION_RECEIPT_V3_PURPOSE = 'materialization-receipt-v3';
export const MATERIALIZATION_RECEIPT_V3_MAX_OUTPUT_FILES = 4_096;

export type MaterializationReceiptV3 = Omit<MaterializationReceiptV2, 'rendition'>;

const SHA256_BYTES = 32;
const RECEIPT_V3_LABELS: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
];

const textEncoder = new TextEncoder();

// ponytail: local copies of packageContractsV2's private CBOR validators;
// storage-core is owned by another branch right now, so they cannot be exported.
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

function readStringArray(value: PackageContractCborValue | undefined, name: string): string[] {
  return requireArray(value, name).map((entry, index) => requireString(entry, `${name}[${index}]`));
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

function materializedFileMap(file: MaterializedFileV2) {
  return new Map<number, PackageContractCborValue>([
    [0, file.normalizedPath],
    [1, file.outputSha256],
    [2, file.outputBytes],
    [3, file.attributionId],
  ]);
}

function materializationReceiptV3Map(receipt: MaterializationReceiptV3) {
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

export function validateMaterializationReceiptV3(receipt: MaterializationReceiptV3): void {
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
    requireBoundedText(value, `MaterializationReceiptV3.${name}`, 512);
  }
  requireBytes(receipt.releaseRoot, 'MaterializationReceiptV3.releaseRoot', SHA256_BYTES);
  requireBytes(
    receipt.protectedSourceRoot,
    'MaterializationReceiptV3.protectedSourceRoot',
    SHA256_BYTES
  );
  requireBytes(receipt.outputTreeRoot, 'MaterializationReceiptV3.outputTreeRoot', SHA256_BYTES);
  requireNonNegativeInteger(receipt.leaseGeneration, 'MaterializationReceiptV3.leaseGeneration');
  requireNonNegativeInteger(receipt.keyEpoch, 'MaterializationReceiptV3.keyEpoch');
  if (
    !Number.isSafeInteger(receipt.issuedAt) ||
    !Number.isSafeInteger(receipt.expiresAt) ||
    receipt.issuedAt < 0 ||
    receipt.expiresAt <= receipt.issuedAt
  ) {
    throw new Error('MaterializationReceiptV3 time claims are invalid');
  }
  if (
    receipt.outputFiles.length === 0 ||
    receipt.outputFiles.length > MATERIALIZATION_RECEIPT_V3_MAX_OUTPUT_FILES
  ) {
    throw new Error(
      `MaterializationReceiptV3 output file count must be between 1 and ${MATERIALIZATION_RECEIPT_V3_MAX_OUTPUT_FILES}`
    );
  }
  for (const [index, file] of receipt.outputFiles.entries()) {
    requireMaterializedPath(
      requireBoundedText(
        file.normalizedPath,
        `MaterializationReceiptV3.outputFiles[${index}].normalizedPath`,
        1_024
      ),
      `MaterializationReceiptV3.outputFiles[${index}].normalizedPath`
    );
    requireBytes(
      file.outputSha256,
      `MaterializationReceiptV3.outputFiles[${index}].outputSha256`,
      SHA256_BYTES
    );
    requireNonNegativeInteger(
      file.outputBytes,
      `MaterializationReceiptV3.outputFiles[${index}].outputBytes`
    );
    requireBoundedText(
      file.attributionId,
      `MaterializationReceiptV3.outputFiles[${index}].attributionId`,
      512
    );
    if (
      index > 0 &&
      compareUtf8(receipt.outputFiles[index - 1].normalizedPath, file.normalizedPath) >= 0
    ) {
      throw new Error('MaterializationReceiptV3 output files must use strict UTF-8 path order');
    }
  }
  if (
    receipt.createdPaths.length !== receipt.outputFiles.length ||
    receipt.createdPaths.some(
      (createdPath, index) => createdPath !== receipt.outputFiles[index]?.normalizedPath
    )
  ) {
    throw new Error('MaterializationReceiptV3 created paths do not match its output files');
  }
  if (!bytesEqual(receipt.outputTreeRoot, computeOutputTreeRootV2(receipt.outputFiles))) {
    throw new Error('MaterializationReceiptV3 output tree root is invalid');
  }
}

export function encodeMaterializationReceiptV3(receipt: MaterializationReceiptV3): Uint8Array {
  validateMaterializationReceiptV3(receipt);
  return encodeCanonicalPackageCbor(materializationReceiptV3Map(receipt));
}

export function decodeMaterializationReceiptV3(payload: Uint8Array): MaterializationReceiptV3 {
  const map = requireMap(decodeCanonicalPackageCbor(payload), 'MaterializationReceiptV3');
  requireExactLabels(map, RECEIPT_V3_LABELS, 'MaterializationReceiptV3');
  if (
    requireInteger(map.get(0), 'MaterializationReceiptV3.schemaVersion') !==
    PACKAGE_CONTRACT_VERSION
  ) {
    throw new Error('MaterializationReceiptV3 schema version is invalid');
  }
  const outputFiles = requireArray(map.get(10), 'MaterializationReceiptV3.outputFiles').map(
    (value, index) => {
      const file = requireMap(value, `MaterializationReceiptV3.outputFiles[${index}]`);
      requireExactLabels(file, [0, 1, 2, 3], `MaterializationReceiptV3.outputFiles[${index}]`);
      return {
        attributionId: requireBoundedText(
          file.get(3),
          `MaterializationReceiptV3.outputFiles[${index}].attributionId`,
          512
        ),
        normalizedPath: requireMaterializedPath(
          requireBoundedText(
            file.get(0),
            `MaterializationReceiptV3.outputFiles[${index}].normalizedPath`,
            1_024
          ),
          `MaterializationReceiptV3.outputFiles[${index}].normalizedPath`
        ),
        outputBytes: requireNonNegativeInteger(
          file.get(2),
          `MaterializationReceiptV3.outputFiles[${index}].outputBytes`
        ),
        outputSha256: requireBytes(
          file.get(1),
          `MaterializationReceiptV3.outputFiles[${index}].outputSha256`,
          SHA256_BYTES
        ),
      };
    }
  );
  const receipt: MaterializationReceiptV3 = {
    buyerSubjectPseudonym: requireBoundedText(
      map.get(4),
      'MaterializationReceiptV3.buyerSubjectPseudonym',
      512
    ),
    capabilityId: requireBoundedText(map.get(2), 'MaterializationReceiptV3.capabilityId', 512),
    codecBuild: requireBoundedText(map.get(17), 'MaterializationReceiptV3.codecBuild', 512),
    createdPaths: readStringArray(map.get(21), 'MaterializationReceiptV3.createdPaths'),
    creatorId: requireBoundedText(map.get(3), 'MaterializationReceiptV3.creatorId', 512),
    expiresAt: requireInteger(map.get(23), 'MaterializationReceiptV3.expiresAt'),
    grantId: requireBoundedText(map.get(11), 'MaterializationReceiptV3.grantId', 512),
    helperBuild: requireBoundedText(map.get(19), 'MaterializationReceiptV3.helperBuild', 512),
    issuedAt: requireInteger(map.get(22), 'MaterializationReceiptV3.issuedAt'),
    jobId: requireBoundedText(map.get(12), 'MaterializationReceiptV3.jobId', 512),
    keyEpoch: requireNonNegativeInteger(map.get(18), 'MaterializationReceiptV3.keyEpoch'),
    leaseGeneration: requireNonNegativeInteger(
      map.get(13),
      'MaterializationReceiptV3.leaseGeneration'
    ),
    materializationAlgorithm: requireBoundedText(
      map.get(15),
      'MaterializationReceiptV3.materializationAlgorithm',
      512
    ),
    materializerId: requireBoundedText(map.get(24), 'MaterializationReceiptV3.materializerId', 512),
    outputFiles,
    outputTreeRoot: requireBytes(
      map.get(9),
      'MaterializationReceiptV3.outputTreeRoot',
      SHA256_BYTES
    ),
    pluginVersion: requireBoundedText(map.get(16), 'MaterializationReceiptV3.pluginVersion', 512),
    productId: requireBoundedText(map.get(6), 'MaterializationReceiptV3.productId', 512),
    protectedSourceRoot: requireBytes(
      map.get(8),
      'MaterializationReceiptV3.protectedSourceRoot',
      SHA256_BYTES
    ),
    pseudonymMethod: requireBoundedText(
      map.get(5),
      'MaterializationReceiptV3.pseudonymMethod',
      512
    ),
    receiptId: requireBoundedText(map.get(1), 'MaterializationReceiptV3.receiptId', 512),
    releaseRoot: requireBytes(map.get(7), 'MaterializationReceiptV3.releaseRoot', SHA256_BYTES),
    runtimeBuild: requireBoundedText(map.get(20), 'MaterializationReceiptV3.runtimeBuild', 512),
    traceId: requireBoundedText(map.get(25), 'MaterializationReceiptV3.traceId', 512),
  };
  validateMaterializationReceiptV3(receipt);
  return receipt;
}

export async function verifyMaterializationReceiptV3(input: {
  coseSign1: Uint8Array;
  expectedKeyId?: Uint8Array;
  publicKey: Uint8Array;
}): Promise<MaterializationReceiptV3> {
  return decodeMaterializationReceiptV3(
    await verifyPackageContract({
      coseSign1: input.coseSign1,
      ...(input.expectedKeyId ? { expectedKeyId: input.expectedKeyId } : {}),
      // The purpose union lives in the frozen storage-core module; the string
      // is the fixed cross-repo contract value.
      expectedPurpose: MATERIALIZATION_RECEIPT_V3_PURPOSE as PackageContractPurpose,
      publicKey: input.publicKey,
    })
  );
}
