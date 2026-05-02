import { unzipSync, type Zippable, zipSync } from 'fflate';
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

type ArchiveSourceKind = 'unitypackage' | 'zip';

export type MaterializedBackstageReleaseArtifact = {
  bytes: Uint8Array;
  byteSize: number;
  contentType: 'application/octet-stream' | 'application/zip';
  deliveryName: string;
  materializationStrategy: 'normalized_repack';
  originalSourceKind: ArchiveSourceKind;
  sha256: string;
  sourceKind: ArchiveSourceKind;
};

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
    normalizeVpmDependencies(metadata ? stripBackstageVpmReservedMetadata(metadata) : {})
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

function resolveZipPackageJsonPath(input: {
  archivePaths: string[];
  packageId?: string;
}): string | undefined {
  const expectedPath = input.packageId?.trim()
    ? `Packages/${input.packageId.trim()}/package.json`
    : undefined;
  if (expectedPath && input.archivePaths.includes(expectedPath)) {
    return expectedPath;
  }
  if (input.archivePaths.includes('package.json')) {
    return 'package.json';
  }
  return input.archivePaths.find((entryPath) => entryPath.endsWith('/package.json'));
}

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

function materializeZip(input: {
  sourceBytes: Uint8Array;
  packageId?: string;
  version?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}): Uint8Array {
  const archive = unzipSync(input.sourceBytes);
  const sanitizedMetadata = sanitizePackageManifestMetadata(input.metadata);
  const normalizedEntries = Object.fromEntries(
    Object.entries(archive).map(
      ([rawPath, bytes]) => [assertSafeArchivePath(rawPath), bytes] as const
    )
  );
  const packageJsonPath = resolveZipPackageJsonPath({
    archivePaths: Object.keys(normalizedEntries),
    packageId: input.packageId,
  });
  if (
    packageJsonPath &&
    (input.metadata || input.packageId || input.version || input.displayName)
  ) {
    const existingManifestBytes = normalizedEntries[packageJsonPath];
    const parsedManifest = JSON.parse(new TextDecoder().decode(existingManifestBytes));
    if (!isRecord(parsedManifest)) {
      throw new Error(`Backstage ZIP package manifest must be an object: ${packageJsonPath}`);
    }
    const sanitizedManifest = stripBackstageVpmReservedMetadata(parsedManifest);
    normalizedEntries[packageJsonPath] = new TextEncoder().encode(
      JSON.stringify(
        {
          ...sanitizedManifest,
          ...sanitizedMetadata,
          ...(input.packageId?.trim() ? { name: input.packageId.trim() } : {}),
          ...(input.version?.trim() ? { version: input.version.trim() } : {}),
          ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
        },
        null,
        2
      )
    );
  }
  const canonicalEntries = Object.entries(normalizedEntries)
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

async function buildImporterShimZip(input: {
  packageId: string;
  version: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}): Promise<MaterializedBackstageReleaseArtifact> {
  const sanitizedMetadata = preserveAliasPackageDisplayName(
    sanitizePackageManifestMetadata(input.metadata),
    input.displayName
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
    bytes,
    byteSize: bytes.byteLength,
    contentType: 'application/zip',
    deliveryName: `vrc-get-${input.packageId}-${input.version}.zip`,
    materializationStrategy: 'normalized_repack',
    originalSourceKind: 'unitypackage',
    sha256: await sha256Hex(bytes),
    sourceKind: 'zip',
  };
}

export async function materializeBackstageReleaseArtifact(input: {
  sourceBytes: Uint8Array;
  deliveryName: string;
  contentType?: string;
  packageId?: string;
  version?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}): Promise<MaterializedBackstageReleaseArtifact> {
  const sourceKind =
    resolvePersistedSourceKind(input.metadata) ??
    detectBackstageVpmDeliverySourceKind({
      deliveryName: input.deliveryName,
      contentType: input.contentType,
      bytes: input.sourceBytes,
    });
  if (sourceKind === 'unitypackage') {
    if (!input.packageId?.trim() || !input.version?.trim()) {
      throw new Error(
        'Backstage unitypackage materialization requires packageId and version to build the deliverable wrapper.'
      );
    }
    return await buildImporterShimZip({
      packageId: input.packageId.trim(),
      version: input.version.trim(),
      displayName: input.displayName?.trim(),
      metadata: input.metadata,
    });
  }

  const bytes = materializeZip({
    sourceBytes: input.sourceBytes,
    packageId: input.packageId,
    version: input.version,
    displayName: input.displayName,
    metadata: input.metadata,
  });

  return {
    bytes,
    byteSize: bytes.byteLength,
    contentType: 'application/zip',
    deliveryName: input.deliveryName,
    materializationStrategy: 'normalized_repack',
    originalSourceKind: 'zip',
    sha256: await sha256Hex(bytes),
    sourceKind: 'zip',
  };
}
