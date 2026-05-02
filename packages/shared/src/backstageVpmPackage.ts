import {
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY,
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY,
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_MARKERS,
  BACKSTAGE_VPM_RESERVED_METADATA_KEYS,
  detectBackstageVpmDeliverySourceKind,
} from './backstageVpmDelivery';
import { sha256Hex } from './crypto';
import {
  applyYucpAliasPackageManifestDefaults,
  normalizeYucpAliasPackageContract,
  YUCP_PACKAGE_METADATA_KEY,
} from './yucpAliasPackageContract';

const UNITYPACKAGE_EXTENSION = '.unitypackage';
const ZIP_EXTENSION = '.zip';

export type PrepareBackstageArtifactInput = {
  packageId: string;
  version: string;
  displayName?: string;
  description?: string;
  unityVersion?: string;
  metadata?: unknown;
  deliveryName?: string;
  sourceBytes: Uint8Array;
  sourceContentType?: string;
  sourceFileName?: string;
};

export type PrepareBackstageArtifactDescriptorInput = Omit<
  PrepareBackstageArtifactInput,
  'sourceBytes'
> & {
  sourceBytes?: Uint8Array;
  sourceSha256: string;
};

export type PreparedBackstageArtifactDescriptor = {
  contentType: 'application/zip' | 'application/octet-stream';
  deliveryName: string;
  metadata: Record<string, unknown>;
  sourceKind: 'unitypackage' | 'zip';
  zipSha256: string;
};

export type PreparedBackstageArtifact = PreparedBackstageArtifactDescriptor & {
  bytes: Uint8Array;
};

function trimOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeManifestMetadata(input: {
  description?: string;
  metadata?: unknown;
  unityVersion?: string;
}): Record<string, unknown> {
  const metadata = isRecord(input.metadata) ? { ...input.metadata } : {};
  for (const reservedKey of BACKSTAGE_VPM_RESERVED_METADATA_KEYS) {
    delete metadata[reservedKey];
  }

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
  delete metadata.dependencies;
  if (normalizedVpmDependencies && Object.keys(normalizedVpmDependencies).length > 0) {
    metadata.vpmDependencies = normalizedVpmDependencies;
  } else {
    delete metadata.vpmDependencies;
  }

  const normalizedYucpMetadata = normalizeYucpAliasPackageContract(
    metadata[YUCP_PACKAGE_METADATA_KEY]
  );
  if (normalizedYucpMetadata) {
    metadata[YUCP_PACKAGE_METADATA_KEY] = normalizedYucpMetadata;
  } else {
    delete metadata[YUCP_PACKAGE_METADATA_KEY];
  }

  const description = trimOptional(input.description);
  if (description) {
    metadata.description = description;
  }

  const unityVersion = trimOptional(input.unityVersion);
  if (unityVersion) {
    metadata.unity = unityVersion;
  }

  return applyYucpAliasPackageManifestDefaults(
    Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined))
  );
}

function buildDefaultSourceFileName(input: {
  packageId: string;
  version: string;
  sourceKind: PreparedBackstageArtifact['sourceKind'];
}): string {
  const packageToken = input.packageId.split('.').at(-1)?.trim() || 'package';
  return `${packageToken}-${input.version}${input.sourceKind === 'unitypackage' ? UNITYPACKAGE_EXTENSION : ZIP_EXTENSION}`;
}

function resolveDeliveryName(input: {
  deliveryName?: string;
  packageId: string;
  version: string;
  sourceFileName?: string;
  sourceKind: PreparedBackstageArtifact['sourceKind'];
}): string {
  const explicitDeliveryName = trimOptional(input.deliveryName);
  if (explicitDeliveryName) {
    return explicitDeliveryName;
  }

  return trimOptional(input.sourceFileName) ?? buildDefaultSourceFileName(input);
}

function inferContentType(
  sourceKind: PreparedBackstageArtifact['sourceKind']
): PreparedBackstageArtifact['contentType'] {
  return sourceKind === 'unitypackage' ? 'application/octet-stream' : 'application/zip';
}

export async function prepareBackstageArtifactForPublish(
  input: PrepareBackstageArtifactInput
): Promise<PreparedBackstageArtifact> {
  const descriptor = prepareBackstageArtifactDescriptorForPublish({
    ...input,
    sourceSha256: await sha256Hex(input.sourceBytes),
  });

  return {
    ...descriptor,
    bytes: input.sourceBytes,
  };
}

export function prepareBackstageArtifactDescriptorForPublish(
  input: PrepareBackstageArtifactDescriptorInput
): PreparedBackstageArtifactDescriptor {
  const sourceFileName = trimOptional(input.sourceFileName);
  const sourceKind = detectBackstageVpmDeliverySourceKind({
    deliveryName: sourceFileName ?? input.deliveryName,
    contentType: input.sourceContentType,
    bytes: input.sourceBytes,
  });
  const metadata = normalizeManifestMetadata({
    description: input.description,
    metadata: input.metadata,
    unityVersion: input.unityVersion,
  });

  return {
    contentType: inferContentType(sourceKind),
    deliveryName: resolveDeliveryName({
      deliveryName: input.deliveryName,
      packageId: input.packageId,
      version: input.version,
      sourceFileName,
      sourceKind,
    }),
    metadata: {
      ...metadata,
      [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]: sourceKind,
      [BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY]:
        BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_MARKERS.serverDerived,
    },
    sourceKind,
    zipSha256: input.sourceSha256,
  };
}
