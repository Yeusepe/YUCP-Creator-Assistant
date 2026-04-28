import { BACKSTAGE_VPM_RESERVED_METADATA_KEYS } from './backstageVpmDelivery';
import { sha256Hex } from './crypto';

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
  sourceFileName: string;
};

export type PreparedBackstageArtifact = {
  bytes: Uint8Array;
  contentType: 'application/zip' | 'application/octet-stream';
  deliveryName: string;
  metadata: Record<string, unknown>;
  sourceKind: 'unitypackage' | 'zip';
  zipSha256: string;
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

  const normalizedDependencies = isRecord(metadata.dependencies)
    ? Object.fromEntries(
        Object.entries(metadata.dependencies)
          .map(([key, value]) => [key.trim(), typeof value === 'string' ? value.trim() : value])
          .filter(
            (entry): entry is [string, string] =>
              Boolean(entry[0]) && typeof entry[1] === 'string' && Boolean(entry[1])
          )
      )
    : undefined;
  if (normalizedDependencies && Object.keys(normalizedDependencies).length > 0) {
    metadata.dependencies = normalizedDependencies;
  } else {
    delete metadata.dependencies;
  }

  const description = trimOptional(input.description);
  if (description) {
    metadata.description = description;
  }
  const unityVersion = trimOptional(input.unityVersion);
  if (unityVersion) {
    metadata.unity = unityVersion;
  }

  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function inferSourceKind(sourceFileName: string): PreparedBackstageArtifact['sourceKind'] {
  const lowerFileName = sourceFileName.toLowerCase();
  if (lowerFileName.endsWith(UNITYPACKAGE_EXTENSION)) {
    return 'unitypackage';
  }
  if (lowerFileName.endsWith(ZIP_EXTENSION)) {
    return 'zip';
  }
  throw new Error('Backstage artifacts must be .unitypackage files or .zip files.');
}

function resolveDeliveryName(input: {
  deliveryName?: string;
  sourceFileName: string;
  sourceKind: PreparedBackstageArtifact['sourceKind'];
}): string {
  const explicitDeliveryName = trimOptional(input.deliveryName);
  if (explicitDeliveryName) {
    return explicitDeliveryName;
  }
  return input.sourceKind === 'unitypackage' ? input.sourceFileName : input.sourceFileName;
}

function inferContentType(
  sourceKind: PreparedBackstageArtifact['sourceKind']
): PreparedBackstageArtifact['contentType'] {
  return sourceKind === 'unitypackage' ? 'application/octet-stream' : 'application/zip';
}

export async function prepareBackstageArtifactForPublish(
  input: PrepareBackstageArtifactInput
): Promise<PreparedBackstageArtifact> {
  const sourceFileName = trimOptional(input.sourceFileName);
  if (!sourceFileName) {
    throw new Error('sourceFileName is required');
  }

  const sourceKind = inferSourceKind(sourceFileName);
  const metadata = normalizeManifestMetadata({
    description: input.description,
    metadata: input.metadata,
    unityVersion: input.unityVersion,
  });

  return {
    bytes: input.sourceBytes,
    contentType: inferContentType(sourceKind),
    deliveryName: resolveDeliveryName({
      deliveryName: input.deliveryName,
      sourceFileName,
      sourceKind,
    }),
    metadata,
    sourceKind,
    zipSha256: await sha256Hex(input.sourceBytes),
  };
}
