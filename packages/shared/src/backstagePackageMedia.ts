import { gunzipSync, unzipSync } from 'fflate';
import type { CdngineBackstageDeliveryReference } from './cdngineBackstageDelivery';
import { sha256Hex } from './crypto';

export const BACKSTAGE_PACKAGE_MEDIA_METADATA_KEY = 'yucpPackageMedia';

export const BACKSTAGE_PACKAGE_MEDIA_KINDS = {
  banner: 'banner',
  icon: 'icon',
} as const;

export const BACKSTAGE_PACKAGE_MEDIA_EXTRACTION_MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export type BackstagePackageMediaKind =
  (typeof BACKSTAGE_PACKAGE_MEDIA_KINDS)[keyof typeof BACKSTAGE_PACKAGE_MEDIA_KINDS];

export type BackstagePackageMediaReference = {
  byteSize: number;
  cdngineDelivery?: CdngineBackstageDeliveryReference;
  contentType: string;
  deliveryName: string;
  kind: BackstagePackageMediaKind;
  sha256: string;
  sourcePath?: string;
};

export type BackstagePackageMediaMap = Partial<
  Record<BackstagePackageMediaKind, BackstagePackageMediaReference>
>;

export type ExtractedBackstagePackageMediaAsset = {
  byteSize: number;
  bytes: Uint8Array;
  contentType: string;
  deliveryName: string;
  kind: BackstagePackageMediaKind;
  sha256: string;
  sourcePath: string;
};

const PACKAGE_MEDIA_MANIFEST_KEYS = new Set(['banner', 'bannerUrl', 'icon', 'iconUrl']);
const TEXT_DECODER = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function canExtractBackstagePackageMediaFromSourceSize(byteSize: number): boolean {
  return (
    Number.isFinite(byteSize) &&
    byteSize >= 0 &&
    byteSize <= BACKSTAGE_PACKAGE_MEDIA_EXTRACTION_MAX_SOURCE_BYTES
  );
}

function normalizeArchivePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function stripMediaSourceFieldsFromRecord(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input };
  for (const key of PACKAGE_MEDIA_MANIFEST_KEYS) {
    delete next[key];
  }

  if (isRecord(next.yucp)) {
    const yucp = { ...next.yucp };
    if (isRecord(yucp.packageMetadata)) {
      yucp.packageMetadata = stripMediaSourceFieldsFromRecord(yucp.packageMetadata);
    }
    next.yucp = yucp;
  }

  return next;
}

export function stripBackstagePackageMediaSourceMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  return stripMediaSourceFieldsFromRecord(metadata);
}

export function stripBackstagePackageMediaManifestMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const next = stripMediaSourceFieldsFromRecord(metadata);
  delete next[BACKSTAGE_PACKAGE_MEDIA_METADATA_KEY];
  return next;
}

function normalizeCdngineDeliveryReference(
  value: unknown
): CdngineBackstageDeliveryReference | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const assetId = readString(value.assetId);
  const assetOwner = readString(value.assetOwner);
  const deliveryScopeId = readString(value.deliveryScopeId);
  const serviceNamespaceId = readString(value.serviceNamespaceId);
  const sha256 = readString(value.sha256);
  const variant = readString(value.variant);
  const versionId = readString(value.versionId);
  if (
    !assetId ||
    !assetOwner ||
    typeof value.byteSize !== 'number' ||
    !deliveryScopeId ||
    !serviceNamespaceId ||
    !sha256 ||
    typeof value.uploadedAt !== 'number' ||
    !variant ||
    !versionId
  ) {
    return undefined;
  }

  return {
    assetId,
    assetOwner,
    byteSize: value.byteSize,
    deliveryScopeId,
    serviceNamespaceId,
    sha256,
    ...(readString(value.tenantId) ? { tenantId: readString(value.tenantId) } : {}),
    uploadedAt: value.uploadedAt,
    variant,
    versionId,
  };
}

function normalizeMediaKind(value: unknown): BackstagePackageMediaKind | undefined {
  const normalized = readString(value);
  if (normalized === BACKSTAGE_PACKAGE_MEDIA_KINDS.icon) {
    return BACKSTAGE_PACKAGE_MEDIA_KINDS.icon;
  }
  if (normalized === BACKSTAGE_PACKAGE_MEDIA_KINDS.banner) {
    return BACKSTAGE_PACKAGE_MEDIA_KINDS.banner;
  }
  return undefined;
}

function normalizePackageMediaReference(
  value: unknown,
  fallbackKind?: BackstagePackageMediaKind
): BackstagePackageMediaReference | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = normalizeMediaKind(value.kind) ?? fallbackKind;
  const contentType = readString(value.contentType);
  const deliveryName = readString(value.deliveryName);
  const sha256 = readString(value.sha256)?.toLowerCase();
  if (
    !kind ||
    !contentType ||
    !deliveryName ||
    typeof value.byteSize !== 'number' ||
    !sha256 ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    return undefined;
  }
  const cdngineDelivery = normalizeCdngineDeliveryReference(value.cdngineDelivery);
  return {
    byteSize: value.byteSize,
    ...(cdngineDelivery ? { cdngineDelivery } : {}),
    contentType,
    deliveryName,
    kind,
    sha256,
    ...(readString(value.sourcePath) ? { sourcePath: readString(value.sourcePath) } : {}),
  };
}

export function getBackstagePackageMediaReferencesFromMetadata(
  metadata: unknown
): BackstagePackageMediaMap {
  if (!isRecord(metadata)) {
    return {};
  }
  const rawMedia = metadata[BACKSTAGE_PACKAGE_MEDIA_METADATA_KEY];
  const entries: BackstagePackageMediaReference[] = [];
  if (Array.isArray(rawMedia)) {
    for (const value of rawMedia) {
      const reference = normalizePackageMediaReference(value);
      if (reference) {
        entries.push(reference);
      }
    }
  } else if (isRecord(rawMedia)) {
    for (const kind of Object.values(BACKSTAGE_PACKAGE_MEDIA_KINDS)) {
      const reference = normalizePackageMediaReference(rawMedia[kind], kind);
      if (reference) {
        entries.push(reference);
      }
    }
  }

  return Object.fromEntries(
    entries.map((entry) => [entry.kind, entry])
  ) as BackstagePackageMediaMap;
}

export function attachBackstagePackageMediaMetadata(
  metadata: Record<string, unknown>,
  media: ReadonlyArray<BackstagePackageMediaReference>
): Record<string, unknown> {
  const stripped = stripBackstagePackageMediaSourceMetadata(metadata);
  if (media.length === 0) {
    return stripped;
  }
  return {
    ...stripped,
    [BACKSTAGE_PACKAGE_MEDIA_METADATA_KEY]: Object.fromEntries(
      media.map((entry) => [entry.kind, entry])
    ),
  };
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(TEXT_DECODER.decode(bytes)) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readMediaPath(metadata: Record<string, unknown>, kind: BackstagePackageMediaKind) {
  return readString(metadata[kind]);
}

function getPackageMetadataCandidates(
  packageJson: Record<string, unknown>
): Record<string, unknown>[] {
  const candidates = [packageJson];
  if (isRecord(packageJson.yucp) && isRecord(packageJson.yucp.packageMetadata)) {
    candidates.unshift(packageJson.yucp.packageMetadata);
  }
  return candidates;
}

function inferContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.gif')) {
    return 'image/gif';
  }
  return 'application/octet-stream';
}

function sanitizeDeliveryName(kind: BackstagePackageMediaKind, path: string): string {
  const fileName = normalizeArchivePath(path).split('/').pop()?.trim() || `${kind}.bin`;
  const reservedCharacters = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
  return Array.from(fileName, (character) =>
    reservedCharacters.has(character) || character.charCodeAt(0) < 32 ? '-' : character
  ).join('');
}

async function buildExtractedMediaAsset(
  kind: BackstagePackageMediaKind,
  sourcePath: string,
  bytes: Uint8Array
): Promise<ExtractedBackstagePackageMediaAsset> {
  return {
    byteSize: bytes.byteLength,
    bytes,
    contentType: inferContentType(sourcePath),
    deliveryName: sanitizeDeliveryName(kind, sourcePath),
    kind,
    sha256: await sha256Hex(bytes),
    sourcePath,
  };
}

function resolveArchiveEntry(
  entries: Record<string, Uint8Array>,
  sourcePath: string,
  packageJsonPath?: string
): Uint8Array | undefined {
  const normalizedSourcePath = normalizeArchivePath(sourcePath);
  const direct = entries[normalizedSourcePath];
  if (direct) {
    return direct;
  }
  if (packageJsonPath?.includes('/')) {
    const packageRoot = packageJsonPath.slice(0, packageJsonPath.lastIndexOf('/') + 1);
    const packageRelative = entries[`${packageRoot}${normalizedSourcePath}`];
    if (packageRelative) {
      return packageRelative;
    }
  }
  return Object.entries(entries).find(([entryPath]) =>
    entryPath.toLowerCase().endsWith(`/${normalizedSourcePath.toLowerCase()}`)
  )?.[1];
}

function resolveZipPackageJsonPath(
  entries: Record<string, Uint8Array>,
  packageId?: string
): string | undefined {
  const paths = Object.keys(entries);
  const expectedPath = packageId?.trim() ? `Packages/${packageId.trim()}/package.json` : undefined;
  if (expectedPath && entries[expectedPath]) {
    return expectedPath;
  }
  return paths.includes('package.json')
    ? 'package.json'
    : paths.find((entryPath) => entryPath.endsWith('/package.json'));
}

async function extractMediaFromPackageJson(
  entries: Record<string, Uint8Array>,
  packageJsonPath: string
): Promise<ExtractedBackstagePackageMediaAsset[]> {
  const packageJson = parseJsonObject(entries[packageJsonPath]);
  if (!packageJson) {
    return [];
  }
  const media: ExtractedBackstagePackageMediaAsset[] = [];
  for (const metadata of getPackageMetadataCandidates(packageJson)) {
    for (const kind of Object.values(BACKSTAGE_PACKAGE_MEDIA_KINDS)) {
      if (media.some((entry) => entry.kind === kind)) {
        continue;
      }
      const mediaPath = readMediaPath(metadata, kind);
      if (!mediaPath || /^https?:\/\//i.test(mediaPath)) {
        continue;
      }
      const bytes = resolveArchiveEntry(entries, mediaPath, packageJsonPath);
      if (bytes) {
        media.push(await buildExtractedMediaAsset(kind, mediaPath, bytes));
      }
    }
  }
  return media;
}

function readTarString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return TEXT_DECODER.decode(end >= 0 ? slice.subarray(0, end) : slice).trim();
}

function parseTarEntries(tarBytes: Uint8Array): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (let offset = 0; offset + 512 <= tarBytes.byteLength; ) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      break;
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = normalizeArchivePath(prefix ? `${prefix}/${name}` : name);
    const size = Number.parseInt(readTarString(header, 124, 12) || '0', 8);
    offset += 512;
    if (path && Number.isFinite(size) && size >= 0) {
      entries[path] = tarBytes.slice(offset, offset + size);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function extractUnityPackageMedia(
  sourceBytes: Uint8Array
): Promise<ExtractedBackstagePackageMediaAsset[]> {
  const tarEntries = parseTarEntries(gunzipSync(sourceBytes));
  const assetsByPath: Record<string, Uint8Array> = {};
  for (const entryPath of Object.keys(tarEntries)) {
    if (!entryPath.endsWith('/pathname')) {
      continue;
    }
    const folder = entryPath.slice(0, -'/pathname'.length);
    const sourcePath = normalizeArchivePath(TEXT_DECODER.decode(tarEntries[entryPath]));
    const assetBytes = tarEntries[`${folder}/asset`];
    if (sourcePath && assetBytes) {
      assetsByPath[sourcePath] = assetBytes;
    }
  }

  const metadataEntry = Object.entries(assetsByPath).find(([assetPath]) =>
    assetPath.toLowerCase().endsWith('/yucp_packageinfo.json')
  );
  const packageJsonEntry = Object.entries(assetsByPath).find(([assetPath]) =>
    assetPath.toLowerCase().endsWith('/package.json')
  );
  const metadata = metadataEntry
    ? parseJsonObject(metadataEntry[1])
    : packageJsonEntry
      ? parseJsonObject(packageJsonEntry[1])
      : undefined;
  if (!metadata) {
    return [];
  }

  const candidates = packageJsonEntry ? getPackageMetadataCandidates(metadata) : [metadata];
  const media: ExtractedBackstagePackageMediaAsset[] = [];
  for (const candidate of candidates) {
    for (const kind of Object.values(BACKSTAGE_PACKAGE_MEDIA_KINDS)) {
      if (media.some((entry) => entry.kind === kind)) {
        continue;
      }
      const mediaPath = readMediaPath(candidate, kind);
      if (!mediaPath || /^https?:\/\//i.test(mediaPath)) {
        continue;
      }
      const normalizedMediaPath = normalizeArchivePath(mediaPath);
      const bytes =
        assetsByPath[normalizedMediaPath] ??
        Object.entries(assetsByPath).find(([assetPath]) =>
          assetPath.toLowerCase().endsWith(`/${normalizedMediaPath.toLowerCase()}`)
        )?.[1];
      if (bytes) {
        media.push(await buildExtractedMediaAsset(kind, mediaPath, bytes));
      }
    }
  }
  return media;
}

export async function extractBackstagePackageMediaAssetsFromSource(input: {
  contentType?: string;
  deliveryName: string;
  packageId?: string;
  sourceBytes: Uint8Array;
}): Promise<ExtractedBackstagePackageMediaAsset[]> {
  const deliveryName = input.deliveryName.toLowerCase();
  const contentType = input.contentType?.toLowerCase() ?? '';
  if (deliveryName.endsWith('.unitypackage')) {
    return await extractUnityPackageMedia(input.sourceBytes);
  }

  const isZip =
    deliveryName.endsWith('.zip') ||
    contentType === 'application/zip' ||
    contentType === 'application/x-zip-compressed';
  if (!isZip && contentType !== 'application/octet-stream') {
    return [];
  }

  const rawZipEntries = unzipSync(input.sourceBytes);
  const entries = Object.fromEntries(
    Object.entries(rawZipEntries).map(([path, bytes]) => [normalizeArchivePath(path), bytes])
  );
  const packageJsonPath = resolveZipPackageJsonPath(entries, input.packageId);
  return packageJsonPath ? await extractMediaFromPackageJson(entries, packageJsonPath) : [];
}
