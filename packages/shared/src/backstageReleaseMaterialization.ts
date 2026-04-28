import { gunzipSync, gzipSync, unzipSync, type Zippable, zipSync } from 'fflate';
import { inferBackstageVpmDeliverySourceKind } from './backstageVpmDelivery';
import { sha256Hex } from './crypto';

const FIXED_ZIP_MTIME = new Date(315619200000);
const FIXED_GZIP_MTIME_SECONDS = 315619200;
const FIXED_TAR_MTIME_SECONDS = 315619200;

type ArchiveSourceKind = 'unitypackage' | 'zip';

export type MaterializedBackstageReleaseArtifact = {
  bytes: Uint8Array;
  byteSize: number;
  contentType: 'application/octet-stream' | 'application/zip';
  deliveryName: string;
  materializationStrategy: 'normalized_repack';
  sha256: string;
  sourceKind: ArchiveSourceKind;
};

type TarFileEntry = {
  path: string;
  data: Uint8Array;
};

function normalizeRelativeArchivePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
}

function assertSafeArchivePath(input: string): string {
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

function readAscii(input: Uint8Array, start: number, length: number): string {
  return new TextDecoder()
    .decode(input.subarray(start, start + length))
    .replace(/\0.*$/, '')
    .trim();
}

function readTarOctal(input: Uint8Array, start: number, length: number): number {
  const raw = readAscii(input, start, length).replace(/\s+$/g, '');
  if (!raw) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid tar header field: ${raw}`);
  }
  return parsed;
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = new TextEncoder().encode(value);
  target.set(encoded.subarray(0, length), offset);
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeAscii(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function writeTarChecksum(target: Uint8Array, value: number): void {
  const encoded = value.toString(8).padStart(6, '0');
  writeAscii(target, 148, 6, encoded);
  target[154] = 0;
  target[155] = 0x20;
}

function splitTarPath(input: string): { name: string; prefix?: string } {
  if (input.length <= 100) {
    return { name: input };
  }

  const lastSlash = input.lastIndexOf('/');
  if (lastSlash <= 0) {
    throw new Error(`Tar entry path exceeds header limit: ${input}`);
  }
  const prefix = input.slice(0, lastSlash);
  const name = input.slice(lastSlash + 1);
  if (!name || name.length > 100 || prefix.length > 155) {
    throw new Error(`Tar entry path exceeds header limit: ${input}`);
  }
  return { name, prefix };
}

function buildTarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const { name, prefix } = splitTarPath(path);
  writeAscii(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, FIXED_TAR_MTIME_SECONDS);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(header, 257, 5, 'ustar');
  header[262] = 0;
  writeAscii(header, 263, 2, '00');
  if (prefix) {
    writeAscii(header, 345, 155, prefix);
  }
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeTarChecksum(header, checksum);
  return header;
}

function parseTarFileEntries(input: Uint8Array): TarFileEntry[] {
  const entries: TarFileEntry[] = [];
  let offset = 0;
  let pendingLongPath: string | null = null;

  while (offset + 512 <= input.byteLength) {
    const header = input.subarray(offset, offset + 512);
    offset += 512;

    if (header.every((value) => value === 0)) {
      break;
    }

    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = readTarOctal(header, 124, 12);
    const rawName = readAscii(header, 0, 100);
    const rawPrefix = readAscii(header, 345, 155);
    const combinedPath = pendingLongPath ?? [rawPrefix, rawName].filter(Boolean).join('/');
    pendingLongPath = null;
    if (!combinedPath) {
      throw new Error('Tar entry is missing its path.');
    }

    const dataEnd = offset + size;
    if (dataEnd > input.byteLength) {
      throw new Error(`Tar entry overruns archive payload: ${combinedPath}`);
    }
    const entryData = input.slice(offset, dataEnd);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === 'L') {
      pendingLongPath = assertSafeArchivePath(
        new TextDecoder().decode(entryData).replace(/\0.*$/, '').trim()
      );
      continue;
    }

    if (typeFlag !== '0' && typeFlag !== '7') {
      continue;
    }

    entries.push({
      path: assertSafeArchivePath(combinedPath),
      data: entryData,
    });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function buildCanonicalTar(entries: TarFileEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = buildTarHeader(entry.path, entry.data.byteLength);
    blocks.push(header);
    blocks.push(entry.data);
    const remainder = entry.data.byteLength % 512;
    if (remainder !== 0) {
      blocks.push(new Uint8Array(512 - remainder));
    }
  }
  blocks.push(new Uint8Array(1024));

  const totalSize = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const output = new Uint8Array(totalSize);
  let offset = 0;
  for (const block of blocks) {
    output.set(block, offset);
    offset += block.byteLength;
  }
  return output;
}

function materializeZip(sourceBytes: Uint8Array): Uint8Array {
  const archive = unzipSync(sourceBytes);
  const canonicalEntries = Object.entries(archive)
    .map(([rawPath, bytes]) => [assertSafeArchivePath(rawPath), bytes] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  const zippable: Zippable = {};
  for (const [entryPath, entryBytes] of canonicalEntries) {
    zippable[entryPath] = [
      entryBytes,
      {
        attrs: 0o644 << 16,
        level: 9,
        mtime: FIXED_ZIP_MTIME,
        os: 3,
      },
    ];
  }
  return zipSync(zippable, { level: 9 });
}

function materializeUnitypackage(sourceBytes: Uint8Array): Uint8Array {
  const tarBytes = gunzipSync(sourceBytes);
  const entries = parseTarFileEntries(tarBytes);
  const canonicalTar = buildCanonicalTar(entries);
  return gzipSync(canonicalTar, {
    level: 9,
    mtime: FIXED_GZIP_MTIME_SECONDS,
  });
}

export async function materializeBackstageReleaseArtifact(input: {
  sourceBytes: Uint8Array;
  deliveryName: string;
  contentType?: string;
}): Promise<MaterializedBackstageReleaseArtifact> {
  const sourceKind = inferBackstageVpmDeliverySourceKind({
    deliveryName: input.deliveryName,
    contentType: input.contentType,
  });
  const bytes =
    sourceKind === 'unitypackage'
      ? materializeUnitypackage(input.sourceBytes)
      : materializeZip(input.sourceBytes);

  return {
    bytes,
    byteSize: bytes.byteLength,
    contentType: sourceKind === 'unitypackage' ? 'application/octet-stream' : 'application/zip',
    deliveryName: input.deliveryName,
    materializationStrategy: 'normalized_repack',
    sha256: await sha256Hex(bytes),
    sourceKind,
  };
}
