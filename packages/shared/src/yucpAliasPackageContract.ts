const YUCP_METADATA_ALIAS_PATH = 'metadata.yucp';

export const YUCP_PACKAGE_METADATA_KEY = 'yucp';

export const YUCP_ALIAS_PACKAGE_KIND = 'alias-v1';

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
export const YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION = '0.1.0';
export const YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_VERSION = `>=${YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION}`;

export type YucpAliasPackageInstallStrategy =
  (typeof YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES)[keyof typeof YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES];

export type YucpAliasImporterPackage =
  (typeof YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES)[keyof typeof YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES];

export type YucpAliasPackageContract = {
  kind: typeof YUCP_ALIAS_PACKAGE_KIND;
  aliasId: string;
  installStrategy: YucpAliasPackageInstallStrategy;
  importerPackage: YucpAliasImporterPackage;
  minImporterVersion?: string;
  catalogProductIds?: string[];
  channel?: string;
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

function normalizeStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of non-empty strings`);
  }

  const normalized = Array.from(
    new Set(value.map((entry, index) => trimRequiredString(entry, `${fieldName}[${index}]`)))
  );

  return normalized.length > 0 ? normalized : undefined;
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

  const kind = trimRequiredString(value.kind, `${YUCP_METADATA_ALIAS_PATH}.kind`);
  if (kind !== YUCP_ALIAS_PACKAGE_KIND) {
    throw new Error(
      `${YUCP_METADATA_ALIAS_PATH}.kind must be ${JSON.stringify(YUCP_ALIAS_PACKAGE_KIND)}`
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
    kind: YUCP_ALIAS_PACKAGE_KIND,
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

  const catalogProductIds = normalizeStringArray(
    value.catalogProductIds,
    `${YUCP_METADATA_ALIAS_PATH}.catalogProductIds`
  );
  if (catalogProductIds) {
    normalized.catalogProductIds = catalogProductIds;
  }

  const channel = trimOptionalString(value.channel, `${YUCP_METADATA_ALIAS_PATH}.channel`);
  if (channel) {
    normalized.channel = channel;
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

export function mergeYucpAliasPackageMetadata(input: {
  metadata?: unknown;
  aliasId: string;
  catalogProductIds: string[];
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
      kind: YUCP_ALIAS_PACKAGE_KIND,
      aliasId: input.aliasId,
      installStrategy: YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES.serverAuthorized,
      importerPackage: YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES.importer,
      minImporterVersion:
        existingAliasContract?.minImporterVersion ??
        YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION,
      catalogProductIds: Array.from(new Set(input.catalogProductIds.map((value) => value.trim()))),
      channel: input.channel.trim(),
    },
  };
}

function resolveImporterDependencyRequirement(aliasContract: YucpAliasPackageContract): string {
  const minimumVersion = aliasContract.minImporterVersion?.trim();
  if (!minimumVersion) {
    return YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_VERSION;
  }
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
  const existingImporterDependency = vpmDependencies[aliasContract.importerPackage];
  if (typeof existingImporterDependency !== 'string' || !existingImporterDependency.trim()) {
    vpmDependencies[aliasContract.importerPackage] =
      resolveImporterDependencyRequirement(aliasContract);
  }

  const { dependencies: _legacyDependencies, ...restMetadata } = metadata;
  return {
    ...restMetadata,
    vpmDependencies,
  };
}
