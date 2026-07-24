import { sha256 } from '@noble/hashes/sha2.js';
import {
  encodeCanonicalPackageCbor,
  hashPackageContractFields,
  type PackageContractCborValue,
} from './packageContractsV2';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function hexToBytes(value: string): Uint8Array {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error('SHA-256 value must use lowercase hexadecimal');
  }
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  );
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type LogicalReleaseFileV4 = {
  bytes: number;
  classification: 'common' | 'protected';
  materializerType?: string;
  normalizedPath: string;
  sha256: string;
};

export type LogicalReleaseIdentityV4 = {
  commonRoot: string;
  protectedSourceRoot: string;
  releaseRoot: string;
};

export type LogicalReleasePublicationV4 = LogicalReleaseIdentityV4 & {
  bindingRoot: string;
  manifestSha256: string;
};

export type LogicalReleaseInputV4 = {
  files: LogicalReleaseFileV4[];
  packageId: string;
  version: string;
  versionId: string;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > 512) {
    throw new Error(`${name} must contain 1 through 512 UTF-8 bytes`);
  }
  return normalized;
}

function filePayload(
  files: LogicalReleaseFileV4[],
  allowEmpty = false
): PackageContractCborValue[] {
  if ((!allowEmpty && files.length === 0) || files.length > 100_000) {
    throw new Error('files contains an invalid logical file count');
  }
  const sorted = [...files].sort((left, right) =>
    compareText(left.normalizedPath, right.normalizedPath)
  );
  return sorted.map((file, index) => {
    if (index > 0 && sorted[index - 1]?.normalizedPath === file.normalizedPath) {
      throw new Error(`files contains a duplicate path: ${file.normalizedPath}`);
    }
    if (
      !file.normalizedPath ||
      file.normalizedPath.includes('\\') ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !SHA256_PATTERN.test(file.sha256) ||
      (file.classification !== 'common' && file.classification !== 'protected') ||
      (file.classification === 'protected' &&
        (!file.materializerType ||
          new TextEncoder().encode(file.materializerType).byteLength > 128)) ||
      (file.classification === 'common' && file.materializerType !== undefined)
    ) {
      throw new Error(`files contains an invalid entry: ${file.normalizedPath}`);
    }
    return new Map<number, PackageContractCborValue>([
      [0, file.normalizedPath],
      [1, file.bytes],
      [2, hexToBytes(file.sha256)],
      [3, file.classification],
      [4, file.materializerType ?? ''],
    ]);
  });
}

function subtreeRoot(
  purpose: 'yucp:common-source-tree:v4' | 'yucp:protected-source-tree:v4',
  files: LogicalReleaseFileV4[]
): string {
  const payload = encodeCanonicalPackageCbor(
    new Map<number, PackageContractCborValue>([
      [0, 4],
      [1, filePayload(files, true)],
    ])
  );
  return bytesToHex(hashPackageContractFields(purpose, [payload]));
}

export function createLogicalReleaseRootV4(input: LogicalReleaseInputV4): LogicalReleaseIdentityV4 {
  const files = [...input.files].sort((left, right) =>
    compareText(left.normalizedPath, right.normalizedPath)
  );
  const commonRoot = subtreeRoot(
    'yucp:common-source-tree:v4',
    files.filter((file) => file.classification === 'common')
  );
  const protectedSourceRoot = subtreeRoot(
    'yucp:protected-source-tree:v4',
    files.filter((file) => file.classification === 'protected')
  );
  const payload = encodeCanonicalPackageCbor(
    new Map<number, PackageContractCborValue>([
      [0, 4],
      [1, 'logical-release-v4'],
      [2, requireText(input.packageId, 'packageId')],
      [3, requireText(input.version, 'version')],
      [4, requireText(input.versionId, 'versionId')],
      [5, filePayload(files)],
      [6, hexToBytes(commonRoot)],
      [7, hexToBytes(protectedSourceRoot)],
    ])
  );
  return {
    commonRoot,
    protectedSourceRoot,
    releaseRoot: bytesToHex(hashPackageContractFields('yucp:logical-release:v4', [payload])),
  };
}

export function createLogicalReleasePublicationV4(
  input: LogicalReleaseInputV4 & { manifest: Uint8Array }
): LogicalReleasePublicationV4 {
  if (input.manifest.byteLength === 0) {
    throw new Error('manifest must not be empty');
  }
  const { commonRoot, protectedSourceRoot, releaseRoot } = createLogicalReleaseRootV4(input);
  const manifestSha256 = bytesToHex(sha256(input.manifest));
  const bindingPayload = encodeCanonicalPackageCbor(
    new Map<number, PackageContractCborValue>([
      [0, 4],
      [1, hexToBytes(releaseRoot)],
      [2, hexToBytes(manifestSha256)],
      [3, hexToBytes(commonRoot)],
      [4, hexToBytes(protectedSourceRoot)],
    ])
  );
  return {
    bindingRoot: bytesToHex(
      hashPackageContractFields('yucp:delivery-binding:v3', [bindingPayload])
    ),
    commonRoot,
    manifestSha256,
    protectedSourceRoot,
    releaseRoot,
  };
}
