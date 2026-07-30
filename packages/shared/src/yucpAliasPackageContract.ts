import { normalizeStrictSemanticVersion } from './semanticVersion';

const YUCP_METADATA_ALIAS_PATH = 'metadata.yucp';
export const YUCP_PACKAGE_METADATA_KEY = 'yucp';

export const YUCP_ALIAS_PACKAGE_KIND = 'alias-v1';
export const YUCP_ALIAS_PACKAGE_VERSIONED_KIND = 'alias-v2';

export const YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES = {
  serverAuthorized: 'server-authorized',
} as const;

export const YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES = {
  importer: 'com.yucp.importer',
} as const;

export const YUCP_MOTION_TOOLKIT_PACKAGE_ID = 'com.yucp.motion';
export const YUCP_FORWARDED_TOOLCHAIN_PACKAGE_IDS = [
  YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES.importer,
  YUCP_MOTION_TOOLKIT_PACKAGE_ID,
] as const;
export const YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION = '0.1.71';
export const YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_VERSION = `>=${YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION}`;

export type YucpAliasPackageInstallStrategy =
  (typeof YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES)[keyof typeof YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES];

export type YucpAliasImporterPackage =
  (typeof YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES)[keyof typeof YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES];

export type YucpAliasPackageContract = {
  kind: typeof YUCP_ALIAS_PACKAGE_KIND | typeof YUCP_ALIAS_PACKAGE_VERSIONED_KIND;
  aliasId: string;
  packageName?: string;
  packageDisplayName?: string;
  packageVersion?: string;
  installStrategy: YucpAliasPackageInstallStrategy;
  importerPackage: YucpAliasImporterPackage;
  minImporterVersion?: string;
  channel?: string;
  packageMetadata?: YucpAliasPackageMetadata;
  media?: YucpAliasPackageMedia[];
  bootstrapIntent?: YucpBootstrapIntent;
};

export type YucpBootstrapIntent = {
  schemaVersion: 1;
  intentId: string;
  mode: 'latest' | 'specific';
  issuedAt: number;
  keyId: string;
  editionId: string;
  version?: string;
  versionId?: string;
  releaseRoot?: string;
  signature: string;
};

export type UnsignedYucpBootstrapIntent = Omit<YucpBootstrapIntent, 'signature'>;

export function yucpBootstrapIntentSigningPayload(input: {
  aliasId: string;
  intent: UnsignedYucpBootstrapIntent;
}): Uint8Array {
  const normalizedAliasId = trimRequiredString(input.aliasId, 'bootstrapIntent.aliasId');
  const normalizedIntent = normalizeBootstrapIntent({
    ...input.intent,
    signature: 'unsigned',
  });
  return new TextEncoder().encode(
    JSON.stringify({
      purpose: 'yucp-bootstrap-intent-v1',
      aliasId: normalizedAliasId,
      schemaVersion: normalizedIntent.schemaVersion,
      intentId: normalizedIntent.intentId,
      mode: normalizedIntent.mode,
      issuedAt: normalizedIntent.issuedAt,
      keyId: normalizedIntent.keyId,
      editionId: normalizedIntent.editionId,
      ...(normalizedIntent.version ? { version: normalizedIntent.version } : {}),
      ...(normalizedIntent.versionId ? { versionId: normalizedIntent.versionId } : {}),
      ...(normalizedIntent.releaseRoot ? { releaseRoot: normalizedIntent.releaseRoot } : {}),
    })
  );
}

export type YucpAliasPackageMetadata = {
  packageName: string;
  author: string;
  description?: string;
  tagline?: string;
};

export type YucpAliasPackageMedia = {
  kind: 'banner' | 'gallery' | 'icon' | 'product-link';
  label?: string;
  // Payload fields are absent for product links that ship no image.
  localPath?: string;
  ordinal?: number;
  contentType?: 'image/jpeg' | 'image/png';
  byteSize?: number;
  sha256?: string;
  url?: string;
};

export type YucpAliasCatalogProductRef = {
  aliases?: ReadonlyArray<string | null | undefined> | null;
  canonicalSlug?: string | null;
  displayName?: string | null;
  providerProductRef?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return normalized;
}

function trimOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return trimRequiredString(value, fieldName);
}

function normalizeBootstrapIntent(value: unknown): YucpBootstrapIntent {
  const fieldName = `${YUCP_METADATA_ALIAS_PATH}.bootstrapIntent`;
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${fieldName}.schemaVersion must be 1`);
  }
  const intentId = trimRequiredString(value.intentId, `${fieldName}.intentId`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId)) {
    throw new Error(`${fieldName}.intentId must be a UUID v4`);
  }
  const mode = trimRequiredString(value.mode, `${fieldName}.mode`);
  if (mode !== 'latest' && mode !== 'specific') {
    throw new Error(`${fieldName}.mode must be "latest" or "specific"`);
  }
  if (!Number.isSafeInteger(value.issuedAt) || (value.issuedAt as number) <= 0) {
    throw new Error(`${fieldName}.issuedAt must be a positive Unix timestamp`);
  }
  const keyId = trimRequiredString(value.keyId, `${fieldName}.keyId`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId)) {
    throw new Error(`${fieldName}.keyId is invalid`);
  }
  const editionId = trimRequiredString(value.editionId, `${fieldName}.editionId`);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(editionId)) {
    throw new Error(`${fieldName}.editionId is invalid`);
  }
  const signature = trimRequiredString(value.signature, `${fieldName}.signature`);
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) {
    throw new Error(`${fieldName}.signature must be base64url`);
  }
  const normalized: YucpBootstrapIntent = {
    schemaVersion: 1,
    intentId: intentId.toLowerCase(),
    mode,
    issuedAt: value.issuedAt as number,
    keyId,
    editionId,
    signature,
  };
  if (mode === 'latest') {
    if (
      value.version !== undefined ||
      value.versionId !== undefined ||
      value.releaseRoot !== undefined
    ) {
      throw new Error(`${fieldName} latest mode must not contain an exact release target`);
    }
    return normalized;
  }
  normalized.version = normalizeStrictSemanticVersion(
    trimRequiredString(value.version, `${fieldName}.version`),
    `${fieldName}.version`
  );
  normalized.versionId = trimRequiredString(value.versionId, `${fieldName}.versionId`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized.versionId)) {
    throw new Error(`${fieldName}.versionId is invalid`);
  }
  normalized.releaseRoot = trimRequiredString(value.releaseRoot, `${fieldName}.releaseRoot`);
  if (!/^[0-9a-f]{64}$/.test(normalized.releaseRoot)) {
    throw new Error(`${fieldName}.releaseRoot must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

export function normalizeYucpBootstrapIntent(value: unknown): YucpBootstrapIntent {
  return normalizeBootstrapIntent(value);
}

function normalizeBoundedString(value: unknown, fieldName: string, maximumLength: number): string {
  const normalized = trimRequiredString(value, fieldName);
  if (normalized.length > maximumLength) {
    throw new Error(`${fieldName} must be ${maximumLength} characters or fewer`);
  }
  return normalized;
}

function normalizePackageMetadata(value: unknown): YucpAliasPackageMetadata | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${YUCP_METADATA_ALIAS_PATH}.packageMetadata must be an object`);
  }
  const normalized: YucpAliasPackageMetadata = {
    packageName: normalizeBoundedString(
      value.packageName,
      `${YUCP_METADATA_ALIAS_PATH}.packageMetadata.packageName`,
      120
    ),
    author: normalizeBoundedString(
      value.author,
      `${YUCP_METADATA_ALIAS_PATH}.packageMetadata.author`,
      120
    ),
  };
  if (value.description !== undefined) {
    normalized.description = normalizeBoundedString(
      value.description,
      `${YUCP_METADATA_ALIAS_PATH}.packageMetadata.description`,
      500
    );
  }
  if (value.tagline !== undefined) {
    normalized.tagline = normalizeBoundedString(
      value.tagline,
      `${YUCP_METADATA_ALIAS_PATH}.packageMetadata.tagline`,
      160
    );
  }
  return normalized;
}

function normalizeProductLinkMetadata(
  entry: Record<string, unknown>,
  fieldName: string
): Pick<YucpAliasPackageMedia, 'label' | 'url'> {
  const label = normalizeBoundedString(entry.label, `${fieldName}.label`, 120);
  let url: URL;
  try {
    url = new URL(trimRequiredString(entry.url, `${fieldName}.url`));
  } catch {
    throw new Error(`${fieldName}.url must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${fieldName}.url must be an absolute HTTPS URL`);
  }
  return { label, url: url.toString() };
}

function normalizeMedia(value: unknown): YucpAliasPackageMedia[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 42) {
    throw new Error(`${YUCP_METADATA_ALIAS_PATH}.media must contain at most 42 entries`);
  }
  const roles = new Set<string>();
  const media = value.map((entry, index): YucpAliasPackageMedia => {
    const fieldName = `${YUCP_METADATA_ALIAS_PATH}.media[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${fieldName} must be an object`);
    }
    const kind = trimRequiredString(entry.kind, `${fieldName}.kind`);
    if (kind !== 'icon' && kind !== 'banner' && kind !== 'gallery' && kind !== 'product-link') {
      throw new Error(`${fieldName}.kind is not supported`);
    }
    const requiresOrdinal = kind === 'gallery' || kind === 'product-link';
    const ordinal = requiresOrdinal ? entry.ordinal : undefined;
    const maximumOrdinal = kind === 'gallery' ? 8 : 32;
    if (
      requiresOrdinal &&
      (!Number.isSafeInteger(ordinal) ||
        (ordinal as number) < 0 ||
        (ordinal as number) >= maximumOrdinal)
    ) {
      throw new Error(`${fieldName}.ordinal is invalid`);
    }
    if (!requiresOrdinal && entry.ordinal !== undefined) {
      throw new Error(`${fieldName}.ordinal is invalid`);
    }
    const hasPayload =
      entry.localPath !== undefined ||
      entry.contentType !== undefined ||
      entry.byteSize !== undefined ||
      entry.sha256 !== undefined;
    if (!hasPayload) {
      if (kind !== 'product-link') {
        throw new Error(`${fieldName} requires an image payload`);
      }
      const role = `${kind}:${ordinal ?? 0}`;
      if (roles.has(role)) {
        throw new Error(`${YUCP_METADATA_ALIAS_PATH}.media contains a duplicate role`);
      }
      roles.add(role);
      return {
        kind,
        ordinal: ordinal as number,
        ...normalizeProductLinkMetadata(entry, fieldName),
      };
    }
    if (entry.contentType !== 'image/png' && entry.contentType !== 'image/jpeg') {
      throw new Error(`${fieldName}.contentType is not supported`);
    }
    const contentType = entry.contentType;
    const extension = contentType === 'image/png' ? 'png' : 'jpg';
    const expectedPath =
      kind === 'icon' || kind === 'banner'
        ? `Documentation~/YUCP/${kind}.${extension}`
        : `Documentation~/YUCP/${
            kind === 'gallery' ? 'gallery' : 'product-links'
          }/${String(ordinal).padStart(3, '0')}.${extension}`;
    const localPath = trimRequiredString(entry.localPath, `${fieldName}.localPath`);
    if (localPath !== expectedPath) {
      throw new Error(`${fieldName}.localPath must be ${expectedPath}`);
    }
    if (
      typeof entry.byteSize !== 'number' ||
      !Number.isSafeInteger(entry.byteSize) ||
      entry.byteSize < 8 ||
      entry.byteSize > 16 * 1024 * 1024
    ) {
      throw new Error(`${fieldName}.byteSize is invalid`);
    }
    const sha256 = trimRequiredString(entry.sha256, `${fieldName}.sha256`);
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`${fieldName}.sha256 must be a lowercase SHA-256 digest`);
    }
    const role = `${kind}:${ordinal ?? 0}`;
    if (roles.has(role)) {
      throw new Error(`${YUCP_METADATA_ALIAS_PATH}.media contains a duplicate role`);
    }
    roles.add(role);
    let productLinkMetadata: Pick<YucpAliasPackageMedia, 'label' | 'url'> = {};
    if (kind === 'product-link') {
      productLinkMetadata = normalizeProductLinkMetadata(entry, fieldName);
    } else if (entry.label !== undefined || entry.url !== undefined) {
      throw new Error(`${fieldName} has unexpected product link metadata`);
    }
    return {
      kind,
      localPath,
      ...(ordinal === undefined ? {} : { ordinal: ordinal as number }),
      contentType,
      byteSize: entry.byteSize,
      sha256,
      ...productLinkMetadata,
    };
  });
  return media.length > 0 ? media : undefined;
}

export function normalizeYucpAliasPackageContract(
  value: unknown
): YucpAliasPackageContract | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${YUCP_METADATA_ALIAS_PATH} must be an object`);
  }
  if ('installPlan' in value) {
    throw new Error(`${YUCP_METADATA_ALIAS_PATH}.installPlan is not supported`);
  }
  if ('resolvedArtifact' in value) {
    throw new Error(`${YUCP_METADATA_ALIAS_PATH}.resolvedArtifact is not supported`);
  }
  if ('resolvedRelease' in value) {
    throw new Error(`${YUCP_METADATA_ALIAS_PATH}.resolvedRelease is not supported`);
  }

  const kind = trimRequiredString(value.kind, `${YUCP_METADATA_ALIAS_PATH}.kind`);
  if (kind !== YUCP_ALIAS_PACKAGE_KIND && kind !== YUCP_ALIAS_PACKAGE_VERSIONED_KIND) {
    throw new Error(
      `${YUCP_METADATA_ALIAS_PATH}.kind must be ${JSON.stringify(YUCP_ALIAS_PACKAGE_KIND)} or ${JSON.stringify(YUCP_ALIAS_PACKAGE_VERSIONED_KIND)}`
    );
  }

  const installStrategy = trimRequiredString(
    value.installStrategy,
    `${YUCP_METADATA_ALIAS_PATH}.installStrategy`
  );
  if (installStrategy !== YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES.serverAuthorized) {
    throw new Error(
      `${YUCP_METADATA_ALIAS_PATH}.installStrategy must be ${JSON.stringify(YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES.serverAuthorized)}`
    );
  }

  const importerPackage = trimRequiredString(
    value.importerPackage,
    `${YUCP_METADATA_ALIAS_PATH}.importerPackage`
  );
  if (importerPackage !== YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES.importer) {
    throw new Error(
      `${YUCP_METADATA_ALIAS_PATH}.importerPackage must be ${JSON.stringify(YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES.importer)}`
    );
  }

  const normalized: YucpAliasPackageContract = {
    kind,
    aliasId: trimRequiredString(value.aliasId, `${YUCP_METADATA_ALIAS_PATH}.aliasId`),
    installStrategy: YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES.serverAuthorized,
    importerPackage: YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES.importer,
  };

  const minImporterVersion = trimOptionalString(
    value.minImporterVersion,
    `${YUCP_METADATA_ALIAS_PATH}.minImporterVersion`
  );
  if (minImporterVersion) {
    normalized.minImporterVersion = minImporterVersion;
  }

  const packageName = trimOptionalString(
    value.packageName,
    `${YUCP_METADATA_ALIAS_PATH}.packageName`
  );
  if (packageName) {
    normalized.packageName = packageName;
  }

  const packageDisplayName = trimOptionalString(
    value.packageDisplayName,
    `${YUCP_METADATA_ALIAS_PATH}.packageDisplayName`
  );
  if (packageDisplayName) {
    normalized.packageDisplayName = packageDisplayName;
  }

  const packageVersion = trimOptionalString(
    value.packageVersion,
    `${YUCP_METADATA_ALIAS_PATH}.packageVersion`
  );
  if (packageVersion) {
    normalized.packageVersion = packageVersion;
  }

  const channel = trimOptionalString(value.channel, `${YUCP_METADATA_ALIAS_PATH}.channel`);
  if (channel) {
    normalized.channel = channel;
  }

  const packageMetadata = normalizePackageMetadata(value.packageMetadata);
  if (packageMetadata) {
    normalized.packageMetadata = packageMetadata;
  }

  const media = normalizeMedia(value.media);
  if (media) {
    normalized.media = media;
  }

  if (kind === YUCP_ALIAS_PACKAGE_VERSIONED_KIND) {
    normalized.bootstrapIntent = normalizeBootstrapIntent(value.bootstrapIntent);
  } else if (value.bootstrapIntent !== undefined) {
    throw new Error(
      `${YUCP_METADATA_ALIAS_PATH}.bootstrapIntent requires ${YUCP_ALIAS_PACKAGE_VERSIONED_KIND}`
    );
  }

  return normalized;
}

export function getYucpAliasPackageContract(
  metadata: unknown
): YucpAliasPackageContract | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  return normalizeYucpAliasPackageContract(metadata[YUCP_PACKAGE_METADATA_KEY]);
}

export function resolveYucpAliasIdFromCatalogProduct(
  input: YucpAliasCatalogProductRef
): string | undefined {
  const canonicalSlug = input.canonicalSlug?.trim();
  if (canonicalSlug) {
    return canonicalSlug;
  }

  const providerProductRef = input.providerProductRef?.trim();
  return providerProductRef || undefined;
}

function normalizeComparableAliasIdSeed(value?: string | null): string | undefined {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || undefined;
}

export function resolveComparableYucpAliasIdsFromCatalogProduct(
  input: YucpAliasCatalogProductRef
): string[] {
  const displayAliasId = normalizeComparableAliasIdSeed(input.displayName);
  if (displayAliasId) {
    return [displayAliasId];
  }

  const aliasIds = (input.aliases ?? [])
    .map((alias) => normalizeComparableAliasIdSeed(alias))
    .filter((aliasId): aliasId is string => Boolean(aliasId));
  return Array.from(new Set(aliasIds));
}

export function resolveSharedYucpAliasIdFromCatalogProducts(
  products: ReadonlyArray<YucpAliasCatalogProductRef>
): string | undefined {
  const directAliasIds = Array.from(
    new Set(
      products
        .map((product) => resolveYucpAliasIdFromCatalogProduct(product))
        .filter((aliasId): aliasId is string => Boolean(aliasId))
    )
  );
  if (directAliasIds.length === 1) {
    return directAliasIds[0];
  }

  let comparableAliasIds: Set<string> | undefined;
  for (const product of products) {
    const productComparableAliasIds = new Set(
      resolveComparableYucpAliasIdsFromCatalogProduct(product)
    );
    if (productComparableAliasIds.size === 0) {
      return undefined;
    }
    if (!comparableAliasIds) {
      comparableAliasIds = productComparableAliasIds;
      continue;
    }
    comparableAliasIds = new Set(
      Array.from(comparableAliasIds).filter((aliasId) => productComparableAliasIds.has(aliasId))
    );
    if (comparableAliasIds.size === 0) {
      return undefined;
    }
  }

  if (!comparableAliasIds || comparableAliasIds.size !== 1) {
    return undefined;
  }

  return Array.from(comparableAliasIds)[0];
}

function parseVersionFloorCandidate(value: string): number[] | undefined {
  const normalized = value.trim().replace(/^>=\s*/, '');
  if (!/^\d+(?:\.\d+){0,2}$/.test(normalized)) {
    return undefined;
  }

  return normalized.split('.').map((segment) => Number.parseInt(segment, 10));
}

function compareVersionParts(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }
  return 0;
}

function resolveAliasImporterMinimumVersion(existingMinimum?: string): string {
  const defaultMinimum = YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION;
  const normalizedExisting = existingMinimum?.trim();
  if (!normalizedExisting) {
    return defaultMinimum;
  }

  const existingParts = parseVersionFloorCandidate(normalizedExisting);
  const defaultParts = parseVersionFloorCandidate(defaultMinimum);
  if (!defaultParts) {
    return normalizedExisting;
  }
  if (!existingParts) {
    return defaultMinimum;
  }

  return compareVersionParts(existingParts, defaultParts) < 0 ? defaultMinimum : normalizedExisting;
}

export function mergeYucpAliasPackageMetadata(input: {
  metadata?: unknown;
  aliasId: string;
  channel: string;
}): Record<string, unknown> {
  if (input.metadata != null && !isRecord(input.metadata)) {
    throw new Error('metadata must be an object when provided');
  }

  const baseMetadata: Record<string, unknown> = input.metadata ? { ...input.metadata } : {};
  const existingAliasContract = normalizeYucpAliasPackageContract(baseMetadata.yucp);

  return {
    ...baseMetadata,
    yucp: {
      kind: existingAliasContract?.kind ?? YUCP_ALIAS_PACKAGE_KIND,
      aliasId: input.aliasId,
      ...(existingAliasContract?.packageName
        ? { packageName: existingAliasContract.packageName }
        : {}),
      ...(existingAliasContract?.packageDisplayName
        ? { packageDisplayName: existingAliasContract.packageDisplayName }
        : {}),
      ...(existingAliasContract?.packageVersion
        ? { packageVersion: existingAliasContract.packageVersion }
        : {}),
      ...(existingAliasContract?.packageMetadata
        ? { packageMetadata: existingAliasContract.packageMetadata }
        : {}),
      ...(existingAliasContract?.media ? { media: existingAliasContract.media } : {}),
      ...(existingAliasContract?.bootstrapIntent
        ? { bootstrapIntent: existingAliasContract.bootstrapIntent }
        : {}),
      installStrategy: YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES.serverAuthorized,
      importerPackage: YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES.importer,
      minImporterVersion: resolveAliasImporterMinimumVersion(
        existingAliasContract?.minImporterVersion
      ),
      channel: input.channel.trim(),
    },
  };
}

function resolveImporterDependencyRequirement(minimumVersion: string): string {
  return /^[<>=^~]/.test(minimumVersion) ? minimumVersion : `>=${minimumVersion}`;
}

export function applyYucpAliasPackageManifestDefaults(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const aliasContract = getYucpAliasPackageContract(metadata);
  if (!aliasContract) {
    return metadata;
  }

  const vpmDependencies = isRecord(metadata.vpmDependencies)
    ? { ...metadata.vpmDependencies }
    : isRecord(metadata.dependencies)
      ? { ...metadata.dependencies }
      : {};
  const minimumVersion = resolveAliasImporterMinimumVersion(aliasContract.minImporterVersion);
  vpmDependencies[aliasContract.importerPackage] =
    resolveImporterDependencyRequirement(minimumVersion);

  const { dependencies: _legacyDependencies, ...restMetadata } = metadata;
  return {
    ...restMetadata,
    vpmDependencies,
    yucp: {
      ...(isRecord(metadata.yucp) ? metadata.yucp : {}),
      minImporterVersion: minimumVersion,
    },
  };
}
