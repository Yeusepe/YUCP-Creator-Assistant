import { Gunzip, type Zippable, zipSync } from 'fflate';
import { MAX_BACKSTAGE_PACKAGE_BYTES } from './backstageLimits';
import { stripBackstagePackageMediaManifestMetadata } from './backstagePackageMedia';
import {
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY,
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY,
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_MARKERS,
  BACKSTAGE_VPM_SOURCE_KINDS,
  detectBackstageVpmDeliverySourceKind,
  stripBackstageVpmReservedMetadata,
} from './backstageVpmDelivery';
import { sha256Hex } from './crypto';
import { applyYucpAliasPackageManifestDefaults } from './yucpAliasPackageContract';

const FIXED_ZIP_MTIME = new Date(315619200000);
export const MAX_UNITYPACKAGE_DECOMPRESSED_BYTES = MAX_BACKSTAGE_PACKAGE_BYTES * 2;
export const MAX_ZIP_DECOMPRESSED_BYTES = MAX_BACKSTAGE_PACKAGE_BYTES * 2;
export const MAX_UNITYPACKAGE_ENTRIES = 100_000;
const MAX_UNITYPACKAGE_PATHNAME_BYTES = 64 * 1024;
const UNITYPACKAGE_GUNZIP_INPUT_CHUNK_BYTES = 64 * 1024;
const UNITYPACKAGE_LIMIT_ERROR_MESSAGE =
  'Backstage unitypackage exceeds the decompressed size/entry limit.';
const ZIP_DECOMPRESSED_LIMIT_ERROR_MESSAGE = 'Backstage ZIP exceeds the decompressed size limit.';
const ZIP64_UNCOMPRESSED_SIZE_MALFORMED_ERROR_MESSAGE =
  'Backstage ZIP64 uncompressed size is malformed.';
// ponytail: These ceilings allow twice the accepted source-package bytes and 100,000 tar entries.
// A truly larger legitimate package needs an end-to-end streaming materialization redesign first.
const MAX_ZIP_CENTRAL_DIRECTORY_ENTRIES = 100_000;
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE = 0x02014b50;
const ZIP_CENTRAL_DIRECTORY_DIGITAL_SIGNATURE = 0x05054b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD_ID = 0x0001;
const ZIP_UTF8_FILE_NAME_FLAG = 0x0800;
const CP437_HIGH_CHARACTERS = Array.from(
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
);

export type ArchiveSourceKind = 'unitypackage' | 'zip';

type MaterializedBackstageReleaseArtifactBase = {
  contentType: 'application/octet-stream' | 'application/zip';
  deliveryName: string;
  materializationStrategy: 'normalized_repack';
  originalSourceKind: ArchiveSourceKind;
  sourceKind: ArchiveSourceKind;
};

export type ByteMaterializedBackstageReleaseArtifact = MaterializedBackstageReleaseArtifactBase & {
  deliverable: {
    kind: 'bytes';
    bytes: Uint8Array;
    byteSize: number;
    sha256: string;
  };
};

export type MaterializedBackstageReleaseArtifact = ByteMaterializedBackstageReleaseArtifact;

function resolvePersistedSourceKind(
  metadata: Record<string, unknown> | undefined
): ArchiveSourceKind | undefined {
  if (
    metadata?.[BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY] !==
    BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_MARKERS.serverDerived
  ) {
    return undefined;
  }
  const persistedSourceKind = metadata?.[BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY];
  if (persistedSourceKind === BACKSTAGE_VPM_SOURCE_KINDS.unitypackage) {
    return BACKSTAGE_VPM_SOURCE_KINDS.unitypackage;
  }
  if (persistedSourceKind === BACKSTAGE_VPM_SOURCE_KINDS.zip) {
    return BACKSTAGE_VPM_SOURCE_KINDS.zip;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVpmDependencies(metadata: Record<string, unknown>): Record<string, unknown> {
  const rawVpmDependencies = isRecord(metadata.vpmDependencies)
    ? metadata.vpmDependencies
    : metadata.dependencies;
  const normalizedVpmDependencies = isRecord(rawVpmDependencies)
    ? Object.fromEntries(
        Object.entries(rawVpmDependencies)
          .map(([key, value]) => [key.trim(), typeof value === 'string' ? value.trim() : value])
          .filter(
            (entry): entry is [string, string] =>
              Boolean(entry[0]) && typeof entry[1] === 'string' && Boolean(entry[1])
          )
      )
    : undefined;
  const { dependencies: _legacyDependencies, ...nextMetadata } = metadata;
  if (normalizedVpmDependencies && Object.keys(normalizedVpmDependencies).length > 0) {
    nextMetadata.vpmDependencies = normalizedVpmDependencies;
  } else {
    delete nextMetadata.vpmDependencies;
  }
  return nextMetadata;
}

function sanitizePackageManifestMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  return applyYucpAliasPackageManifestDefaults(
    normalizeVpmDependencies(
      metadata
        ? stripBackstagePackageMediaManifestMetadata(stripBackstageVpmReservedMetadata(metadata))
        : {}
    )
  );
}

function sanitizeUnityPackageDisplayName(displayName: string): string {
  const invalidCharacters = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
  return Array.from(displayName)
    .map((character) =>
      invalidCharacters.has(character) || character.charCodeAt(0) < 32 ? '-' : character
    )
    .join('')
    .trim();
}

function preserveAliasPackageDisplayName(
  metadata: Record<string, unknown>,
  displayName?: string
): Record<string, unknown> {
  const packageDisplayName = displayName?.trim();
  if (!packageDisplayName || !isRecord(metadata.yucp)) {
    return metadata;
  }

  return {
    ...metadata,
    yucp: {
      ...metadata.yucp,
      packageDisplayName,
    },
  };
}

function normalizeRelativeArchivePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
}

function assertSafeArchivePath(input: string): string {
  const slashed = input.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) {
    throw new Error(`Backstage release artifact contains unsafe archive path: ${input}`);
  }
  const normalized = normalizeRelativeArchivePath(input);
  if (!normalized) {
    throw new Error('Backstage release artifact contains an empty archive path.');
  }
  if (normalized.startsWith('../') || normalized === '..') {
    throw new Error(`Backstage release artifact contains unsafe archive path: ${input}`);
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Backstage release artifact contains unsafe archive path: ${input}`);
  }
  return normalized;
}

function readTarString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const max = Math.min(offset + length, bytes.byteLength);
  while (end < max && bytes[end] !== 0) {
    end += 1;
  }
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

function readTarOctal(bytes: Uint8Array, offset: number, length: number): number {
  const raw = readTarString(bytes, offset, length).trim().replace(/\0/g, '');
  if (!raw) {
    return 0;
  }
  return Number.parseInt(raw, 8);
}

function isEmptyTarBlock(bytes: Uint8Array, offset: number): boolean {
  for (let index = 0; index < 512 && offset + index < bytes.byteLength; index++) {
    if (bytes[offset + index] !== 0) {
      return false;
    }
  }
  return true;
}

function assertSafeProjectImportPath(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
  if (!normalized) {
    throw new Error('Backstage unitypackage contains an empty pathname.');
  }
  if (
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Backstage unitypackage contains unsafe pathname: ${input}`);
  }
  return normalized;
}

export type UnityPackageImportPathCollectionLimits = Readonly<{
  maxDecompressedBytes?: number;
  maxEntries?: number;
}>;

function resolveUnityPackageCollectionLimit(
  requestedLimit: number | undefined,
  hardLimit: number,
  label: string
): number {
  if (requestedLimit === undefined) {
    return hardLimit;
  }
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error(`Backstage unitypackage ${label} limit must be a positive safe integer.`);
  }
  return Math.min(requestedLimit, hardLimit);
}

function throwUnityPackageLimitError(): never {
  throw new Error(UNITYPACKAGE_LIMIT_ERROR_MESSAGE);
}

export function collectUnityPackageImportPaths(
  sourceBytes: Uint8Array,
  limits: UnityPackageImportPathCollectionLimits = {}
): string[] {
  const maxDecompressedBytes = resolveUnityPackageCollectionLimit(
    limits.maxDecompressedBytes,
    MAX_UNITYPACKAGE_DECOMPRESSED_BYTES,
    'decompressed byte'
  );
  const maxEntries = resolveUnityPackageCollectionLimit(
    limits.maxEntries,
    MAX_UNITYPACKAGE_ENTRIES,
    'entry'
  );
  const entriesByDirectory = new Map<
    string,
    {
      asset: boolean;
      assetMeta: boolean;
      pathname?: string;
    }
  >();
  const headerBytes = new Uint8Array(512);
  let headerByteLength = 0;
  let totalDecompressed = 0;
  let entryCount = 0;
  let tarEnded = false;
  let currentEntry:
    | {
        dataRemaining: number;
        directory?: string;
        paddingRemaining: number;
        pathnameBytes?: Uint8Array;
        pathnameOffset: number;
      }
    | undefined;

  const completeCurrentEntryContent = (): void => {
    if (!currentEntry) {
      return;
    }
    if (currentEntry.pathnameBytes && currentEntry.directory !== undefined) {
      const entry = entriesByDirectory.get(currentEntry.directory);
      if (entry) {
        entry.pathname = new TextDecoder().decode(currentEntry.pathnameBytes).trim();
      }
    }
    currentEntry.pathnameBytes = undefined;
    if (currentEntry.paddingRemaining === 0) {
      currentEntry = undefined;
    }
  };

  const consumeTarBytes = (chunk: Uint8Array): void => {
    let offset = 0;
    while (offset < chunk.byteLength && !tarEnded) {
      if (!currentEntry) {
        const headerBytesNeeded = 512 - headerByteLength;
        const headerBytesAvailable = Math.min(headerBytesNeeded, chunk.byteLength - offset);
        headerBytes.set(chunk.subarray(offset, offset + headerBytesAvailable), headerByteLength);
        headerByteLength += headerBytesAvailable;
        offset += headerBytesAvailable;
        if (headerByteLength < 512) {
          continue;
        }
        headerByteLength = 0;
        if (isEmptyTarBlock(headerBytes, 0)) {
          tarEnded = true;
          continue;
        }

        entryCount += 1;
        if (entryCount > maxEntries) {
          throwUnityPackageLimitError();
        }

        const entryPath = readTarString(headerBytes, 0, 100);
        const size = readTarOctal(headerBytes, 124, 12);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error('Backstage unitypackage contains an invalid tar entry size.');
        }

        let directory: string | undefined;
        let pathnameBytes: Uint8Array | undefined;
        if (entryPath) {
          const slashIndex = entryPath.lastIndexOf('/');
          directory = slashIndex >= 0 ? entryPath.slice(0, slashIndex) : '';
          const fileName = slashIndex >= 0 ? entryPath.slice(slashIndex + 1) : entryPath;
          const entry = entriesByDirectory.get(directory) ?? {
            asset: false,
            assetMeta: false,
          };

          if (fileName === 'pathname') {
            if (size > MAX_UNITYPACKAGE_PATHNAME_BYTES) {
              throwUnityPackageLimitError();
            }
            pathnameBytes = new Uint8Array(size);
          } else if (fileName === 'asset') {
            entry.asset = true;
          } else if (fileName === 'asset.meta') {
            entry.assetMeta = true;
          }

          entriesByDirectory.set(directory, entry);
        }

        currentEntry = {
          dataRemaining: size,
          directory,
          paddingRemaining: (512 - (size % 512)) % 512,
          pathnameBytes,
          pathnameOffset: 0,
        };
        if (size === 0) {
          completeCurrentEntryContent();
        }
        continue;
      }

      if (currentEntry.dataRemaining > 0) {
        const dataBytesAvailable = Math.min(currentEntry.dataRemaining, chunk.byteLength - offset);
        if (currentEntry.pathnameBytes) {
          currentEntry.pathnameBytes.set(
            chunk.subarray(offset, offset + dataBytesAvailable),
            currentEntry.pathnameOffset
          );
          currentEntry.pathnameOffset += dataBytesAvailable;
        }
        currentEntry.dataRemaining -= dataBytesAvailable;
        offset += dataBytesAvailable;
        if (currentEntry.dataRemaining === 0) {
          completeCurrentEntryContent();
        }
        continue;
      }

      const paddingBytesAvailable = Math.min(
        currentEntry.paddingRemaining,
        chunk.byteLength - offset
      );
      currentEntry.paddingRemaining -= paddingBytesAvailable;
      offset += paddingBytesAvailable;
      if (currentEntry.paddingRemaining === 0) {
        currentEntry = undefined;
      }
    }
  };

  const gunzip = new Gunzip((chunk) => {
    totalDecompressed += chunk.byteLength;
    if (totalDecompressed > maxDecompressedBytes) {
      throwUnityPackageLimitError();
    }
    consumeTarBytes(chunk);
  });

  if (sourceBytes.byteLength === 0) {
    gunzip.push(sourceBytes, true);
  } else {
    for (
      let offset = 0;
      offset < sourceBytes.byteLength;
      offset += UNITYPACKAGE_GUNZIP_INPUT_CHUNK_BYTES
    ) {
      const end = Math.min(offset + UNITYPACKAGE_GUNZIP_INPUT_CHUNK_BYTES, sourceBytes.byteLength);
      gunzip.push(sourceBytes.subarray(offset, end), end === sourceBytes.byteLength);
    }
  }

  const managedPaths = new Set<string>();
  for (const entry of entriesByDirectory.values()) {
    if (!entry.pathname || !entry.asset) {
      continue;
    }

    const projectPath = assertSafeProjectImportPath(entry.pathname);
    managedPaths.add(projectPath);
    if (entry.assetMeta) {
      managedPaths.add(`${projectPath}.meta`);
    }
  }

  return Array.from(managedPaths).sort((left, right) => left.localeCompare(right));
}

function assertZipRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.byteLength - length
  ) {
    throw new Error(`Backstage ZIP ${label} is outside the archive bounds.`);
  }
}

function readZipUint16(bytes: Uint8Array, offset: number, label: string): number {
  assertZipRange(bytes, offset, 2, label);
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readZipUint32(bytes: Uint8Array, offset: number, label: string): number {
  assertZipRange(bytes, offset, 4, label);
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function readZipUint64(bytes: Uint8Array, offset: number, label: string): number {
  const low = readZipUint32(bytes, offset, label);
  const high = readZipUint32(bytes, offset + 4, label);
  const value = high * 0x1_0000_0000 + low;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Backstage ZIP ${label} exceeds the supported safe integer range.`);
  }
  return value;
}

function findZipEndOfCentralDirectory(sourceBytes: Uint8Array): number {
  const minimumRecordSize = 22;
  const maximumCommentSize = 0xffff;
  const firstCandidate = sourceBytes.byteLength - minimumRecordSize;
  const lastCandidate = Math.max(0, firstCandidate - maximumCommentSize);
  for (let offset = firstCandidate; offset >= lastCandidate; offset -= 1) {
    if (
      readZipUint32(sourceBytes, offset, 'end-of-central-directory signature') ===
        ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE &&
      offset + minimumRecordSize + readZipUint16(sourceBytes, offset + 20, 'comment length') ===
        sourceBytes.byteLength
    ) {
      return offset;
    }
  }
  throw new Error('Backstage ZIP end-of-central-directory record is missing or malformed.');
}

function readZipCentralDirectoryLocation(sourceBytes: Uint8Array): {
  entryCount: number;
  offset: number;
  size: number;
} {
  const endOffset = findZipEndOfCentralDirectory(sourceBytes);
  const diskNumber = readZipUint16(sourceBytes, endOffset + 4, 'disk number');
  const centralDirectoryDisk = readZipUint16(
    sourceBytes,
    endOffset + 6,
    'central-directory disk number'
  );
  const diskEntryCount = readZipUint16(sourceBytes, endOffset + 8, 'disk entry count');
  const totalEntryCount = readZipUint16(sourceBytes, endOffset + 10, 'total entry count');
  const centralDirectorySize = readZipUint32(sourceBytes, endOffset + 12, 'central-directory size');
  const centralDirectoryOffset = readZipUint32(
    sourceBytes,
    endOffset + 16,
    'central-directory offset'
  );
  const usesZip64 =
    diskEntryCount === 0xffff ||
    totalEntryCount === 0xffff ||
    centralDirectorySize === 0xffff_ffff ||
    centralDirectoryOffset === 0xffff_ffff;

  if (!usesZip64) {
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== totalEntryCount) {
      throw new Error('Backstage ZIP multi-disk archives are not supported.');
    }
    return {
      entryCount: totalEntryCount,
      offset: centralDirectoryOffset,
      size: centralDirectorySize,
    };
  }

  const locatorOffset = endOffset - 20;
  if (
    locatorOffset < 0 ||
    readZipUint32(sourceBytes, locatorOffset, 'ZIP64 locator signature') !==
      ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE
  ) {
    throw new Error('Backstage ZIP64 end-of-central-directory locator is missing.');
  }
  if (
    readZipUint32(sourceBytes, locatorOffset + 4, 'ZIP64 record disk number') !== 0 ||
    readZipUint32(sourceBytes, locatorOffset + 16, 'ZIP64 disk count') !== 1
  ) {
    throw new Error('Backstage ZIP multi-disk archives are not supported.');
  }

  const zip64EndOffset = readZipUint64(
    sourceBytes,
    locatorOffset + 8,
    'ZIP64 end-of-central-directory offset'
  );
  if (
    readZipUint32(sourceBytes, zip64EndOffset, 'ZIP64 end-of-central-directory signature') !==
    ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE
  ) {
    throw new Error('Backstage ZIP64 end-of-central-directory record is missing.');
  }
  const zip64RecordSize = readZipUint64(
    sourceBytes,
    zip64EndOffset + 4,
    'ZIP64 end-of-central-directory record size'
  );
  if (zip64RecordSize < 44 || zip64EndOffset + 12 + zip64RecordSize > locatorOffset) {
    throw new Error('Backstage ZIP64 end-of-central-directory record is malformed.');
  }
  const zip64DiskNumber = readZipUint32(sourceBytes, zip64EndOffset + 16, 'ZIP64 disk number');
  const zip64CentralDirectoryDisk = readZipUint32(
    sourceBytes,
    zip64EndOffset + 20,
    'ZIP64 central-directory disk number'
  );
  const zip64DiskEntryCount = readZipUint64(
    sourceBytes,
    zip64EndOffset + 24,
    'ZIP64 disk entry count'
  );
  const zip64TotalEntryCount = readZipUint64(
    sourceBytes,
    zip64EndOffset + 32,
    'ZIP64 total entry count'
  );
  if (
    zip64DiskNumber !== 0 ||
    zip64CentralDirectoryDisk !== 0 ||
    zip64DiskEntryCount !== zip64TotalEntryCount
  ) {
    throw new Error('Backstage ZIP multi-disk archives are not supported.');
  }

  return {
    entryCount: zip64TotalEntryCount,
    size: readZipUint64(sourceBytes, zip64EndOffset + 40, 'ZIP64 central-directory size'),
    offset: readZipUint64(sourceBytes, zip64EndOffset + 48, 'ZIP64 central-directory offset'),
  };
}

function decodeZipFileName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Backstage ZIP contains an invalid UTF-8 file name.');
    }
  }
  return Array.from(bytes, (byte) =>
    byte < 0x80 ? String.fromCharCode(byte) : (CP437_HIGH_CHARACTERS[byte - 0x80] ?? '')
  ).join('');
}

function readZipCentralDirectoryEntryUncompressedSize(input: {
  sourceBytes: Uint8Array;
  recordOffset: number;
  fileNameLength: number;
  extraFieldLength: number;
}): number {
  const uncompressedSize = readZipUint32(
    input.sourceBytes,
    input.recordOffset + 24,
    'central-directory uncompressed size'
  );
  if (uncompressedSize !== 0xffff_ffff) {
    return uncompressedSize;
  }

  const extraFieldOffset = input.recordOffset + 46 + input.fileNameLength;
  assertZipRange(
    input.sourceBytes,
    extraFieldOffset,
    input.extraFieldLength,
    'central-directory extra field'
  );
  const extraFieldEnd = extraFieldOffset + input.extraFieldLength;
  let blockOffset = extraFieldOffset;
  while (blockOffset < extraFieldEnd) {
    if (blockOffset > extraFieldEnd - 4) {
      throw new Error(ZIP64_UNCOMPRESSED_SIZE_MALFORMED_ERROR_MESSAGE);
    }
    const headerId = readZipUint16(input.sourceBytes, blockOffset, 'extra-field header ID');
    const dataSize = readZipUint16(input.sourceBytes, blockOffset + 2, 'extra-field data size');
    const blockDataOffset = blockOffset + 4;
    if (blockDataOffset > extraFieldEnd - dataSize) {
      throw new Error(ZIP64_UNCOMPRESSED_SIZE_MALFORMED_ERROR_MESSAGE);
    }
    if (headerId === ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD_ID) {
      if (dataSize < 8) {
        throw new Error(ZIP64_UNCOMPRESSED_SIZE_MALFORMED_ERROR_MESSAGE);
      }
      return readZipUint64(input.sourceBytes, blockDataOffset, 'ZIP64 uncompressed size');
    }
    blockOffset = blockDataOffset + dataSize;
  }

  throw new Error(ZIP64_UNCOMPRESSED_SIZE_MALFORMED_ERROR_MESSAGE);
}

export function collectZipArchiveEntryPaths(sourceBytes: Uint8Array): string[] {
  const centralDirectory = readZipCentralDirectoryLocation(sourceBytes);
  if (centralDirectory.entryCount > MAX_ZIP_CENTRAL_DIRECTORY_ENTRIES) {
    throw new Error(
      `Backstage ZIP central directory entry count exceeds ${MAX_ZIP_CENTRAL_DIRECTORY_ENTRIES}.`
    );
  }
  assertZipRange(sourceBytes, centralDirectory.offset, centralDirectory.size, 'central directory');
  const centralDirectoryEnd = centralDirectory.offset + centralDirectory.size;
  const managedPaths = new Set<string>();
  let declaredDecompressedBytes = 0;
  let offset = centralDirectory.offset;

  for (let index = 0; index < centralDirectory.entryCount; index += 1) {
    if (
      offset + 46 > centralDirectoryEnd ||
      readZipUint32(sourceBytes, offset, 'central-directory file header signature') !==
        ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE
    ) {
      throw new Error('Backstage ZIP central directory entry count does not match its headers.');
    }
    const flags = readZipUint16(sourceBytes, offset + 8, 'central-directory flags');
    const fileNameLength = readZipUint16(
      sourceBytes,
      offset + 28,
      'central-directory file name length'
    );
    const extraFieldLength = readZipUint16(
      sourceBytes,
      offset + 30,
      'central-directory extra field length'
    );
    const commentLength = readZipUint16(
      sourceBytes,
      offset + 32,
      'central-directory comment length'
    );
    const recordSize = 46 + fileNameLength + extraFieldLength + commentLength;
    if (offset + recordSize > centralDirectoryEnd) {
      throw new Error('Backstage ZIP central-directory file header is truncated.');
    }
    declaredDecompressedBytes += readZipCentralDirectoryEntryUncompressedSize({
      sourceBytes,
      recordOffset: offset,
      fileNameLength,
      extraFieldLength,
    });
    if (declaredDecompressedBytes > MAX_ZIP_DECOMPRESSED_BYTES) {
      throw new Error(ZIP_DECOMPRESSED_LIMIT_ERROR_MESSAGE);
    }
    const fileName = decodeZipFileName(
      sourceBytes.subarray(offset + 46, offset + 46 + fileNameLength),
      (flags & ZIP_UTF8_FILE_NAME_FLAG) !== 0
    );
    if (!fileName.endsWith('/')) {
      managedPaths.add(assertSafeArchivePath(fileName));
    }
    offset += recordSize;
  }

  if (offset < centralDirectoryEnd) {
    const isDigitalSignature =
      readZipUint32(sourceBytes, offset, 'central-directory trailing record signature') ===
      ZIP_CENTRAL_DIRECTORY_DIGITAL_SIGNATURE;
    const digitalSignatureSize = isDigitalSignature
      ? 6 + readZipUint16(sourceBytes, offset + 4, 'central-directory digital signature size')
      : 0;
    if (!isDigitalSignature || offset + digitalSignatureSize !== centralDirectoryEnd) {
      throw new Error('Backstage ZIP central directory entry count does not match its headers.');
    }
    offset += digitalSignatureSize;
  }
  if (offset !== centralDirectoryEnd) {
    throw new Error('Backstage ZIP central directory entry count does not match its size.');
  }

  return Array.from(managedPaths).sort((left, right) => left.localeCompare(right));
}

function withAliasInstallPlanFootprint(
  metadata: Record<string, unknown>,
  input: {
    managedPaths: string[];
    packageId: string;
    originalSourceKind: ArchiveSourceKind;
  }
): Record<string, unknown> {
  if (!isRecord(metadata.yucp)) {
    return metadata;
  }

  const packageJsonPath = `Packages/${input.packageId}/package.json`;
  const existingPlan = isRecord(metadata.yucp.installPlan) ? metadata.yucp.installPlan : {};
  const managedPaths = Array.from(
    new Set(
      [
        ...(input.originalSourceKind === 'unitypackage' ? [packageJsonPath] : []),
        ...input.managedPaths,
      ]
        .map((path) => assertSafeProjectImportPath(path))
        .filter(Boolean)
    )
  );

  return {
    ...metadata,
    yucp: {
      ...metadata.yucp,
      installPlan: {
        ...existingPlan,
        operation:
          typeof existingPlan.operation === 'string' && existingPlan.operation.trim()
            ? existingPlan.operation.trim()
            : 'install',
        managedPaths,
      },
    },
  };
}

async function buildImporterShimZip(input: {
  packageId: string;
  version: string;
  displayName?: string;
  managedPaths: string[];
  metadata?: Record<string, unknown>;
  originalSourceKind: ArchiveSourceKind;
}): Promise<MaterializedBackstageReleaseArtifact> {
  const sanitizedMetadata = withAliasInstallPlanFootprint(
    preserveAliasPackageDisplayName(
      sanitizePackageManifestMetadata(input.metadata),
      input.displayName
    ),
    {
      managedPaths: input.managedPaths,
      packageId: input.packageId,
      originalSourceKind: input.originalSourceKind,
    }
  );
  const displayName = input.displayName?.trim() || input.packageId;
  const packageJsonMetadata = {
    ...sanitizedMetadata,
    name: input.packageId,
    version: input.version,
    displayName: sanitizeUnityPackageDisplayName(displayName),
  };
  const packageJson = JSON.stringify(packageJsonMetadata, null, 2);
  const zippable: Zippable = {
    'package.json': [
      new TextEncoder().encode(packageJson),
      { attrs: 0o644 << 16, level: 9, mtime: FIXED_ZIP_MTIME, os: 3 },
    ],
  };
  const bytes = zipSync(zippable, { level: 9 });
  return {
    contentType: 'application/zip',
    deliverable: {
      kind: 'bytes',
      bytes,
      byteSize: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    },
    deliveryName: `vrc-get-${input.packageId}-${input.version}.zip`,
    materializationStrategy: 'normalized_repack',
    originalSourceKind: input.originalSourceKind,
    sourceKind: 'zip',
  };
}

export async function materializeBackstageReleaseArtifact(input: {
  sourceBytes?: Uint8Array;
  deliveryName: string;
  contentType?: string;
  packageId?: string;
  version?: string;
  displayName?: string;
  managedPaths?: string[];
  metadata?: Record<string, unknown>;
}): Promise<MaterializedBackstageReleaseArtifact> {
  const sourceKind =
    resolvePersistedSourceKind(input.metadata) ??
    detectBackstageVpmDeliverySourceKind({
      deliveryName: input.deliveryName,
      contentType: input.contentType,
      bytes: input.sourceBytes,
    });
  if (!input.packageId?.trim() || !input.version?.trim()) {
    throw new Error(
      `Backstage ${sourceKind} materialization requires packageId and version to build the deliverable wrapper.`
    );
  }
  let managedPaths = input.managedPaths;
  if (!managedPaths || managedPaths.length === 0) {
    if (!input.sourceBytes) {
      throw new Error(
        `Backstage ${sourceKind} materialization requires managedPaths or sourceBytes.`
      );
    }
    managedPaths =
      sourceKind === 'unitypackage'
        ? collectUnityPackageImportPaths(input.sourceBytes)
        : collectZipArchiveEntryPaths(input.sourceBytes);
  }
  return await buildImporterShimZip({
    packageId: input.packageId.trim(),
    version: input.version.trim(),
    displayName: input.displayName?.trim(),
    managedPaths,
    metadata: input.metadata,
    originalSourceKind: sourceKind,
  });
}
