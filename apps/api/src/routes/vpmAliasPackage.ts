import { createHash } from 'node:crypto';
import { applyYucpAliasPackageManifestDefaults, mergeYucpAliasPackageMetadata } from '@yucp/shared';
import { strToU8, zipSync } from 'fflate';

const MAX_CATALOG_PRODUCT_ID_LENGTH = 512;
const MAX_ALIAS_ID_LENGTH = 512;
const MAX_CATALOG_PRODUCT_IDS = 16;
const MAX_VPM_DEPENDENCIES = 64;
const MAX_ALIAS_DESCRIPTOR_LENGTH = 12_288;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const ZIP_TIMESTAMP = new Date('1980-01-02T00:00:00.000Z');
const VPM_PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,213}$/;
const VPM_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type YucpAliasVpmManifest = {
  author: {
    email: string;
    name: string;
    url: string;
  };
  description: string;
  displayName: string;
  name: string;
  unity: string;
  url: string;
  version: string;
  vpmDependencies: Record<string, string>;
  yucp: Record<string, unknown>;
  zipSHA256: string;
};

export type BuiltYucpAliasVpmPackage = {
  bytes: Uint8Array;
  manifest: YucpAliasVpmManifest;
  packageId: string;
  zipSha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVpmBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VPM base URL must be an absolute HTTPS or loopback HTTP URL');
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname))
  ) {
    throw new Error('VPM base URL must be an absolute HTTPS or loopback HTTP URL');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('VPM base URL must not contain credentials, a query, or a fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

function normalizeCatalogProductId(value: string): string {
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!normalized || normalized.length > MAX_CATALOG_PRODUCT_ID_LENGTH || hasControlCharacter) {
    throw new Error('YUCP catalog product ID must contain 1 through 512 safe characters');
  }
  return normalized;
}

function normalizeAliasId(value: string): string {
  const normalized = normalizeCatalogProductId(value);
  if (normalized.length > MAX_ALIAS_ID_LENGTH) {
    throw new Error('YUCP alias ID must contain 1 through 512 safe characters');
  }
  return normalized;
}

function normalizeCatalogProductIds(values: ReadonlyArray<string>): string[] {
  const normalized = Array.from(new Set(values.map(normalizeCatalogProductId))).sort(
    (left, right) => left.localeCompare(right)
  );
  if (normalized.length < 1 || normalized.length > MAX_CATALOG_PRODUCT_IDS) {
    throw new Error('YUCP alias package must contain 1 through 16 catalog product IDs');
  }
  return normalized;
}

function normalizeBootstrapVersion(value: string): string {
  const normalized = value.trim();
  if (!VPM_VERSION_PATTERN.test(normalized)) {
    throw new Error('YUCP alias bootstrap version must use Semantic Versioning');
  }
  return normalized;
}

function normalizeVpmDependencies(value: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.length > MAX_VPM_DEPENDENCIES) {
    throw new Error(`YUCP alias dependencies exceed ${MAX_VPM_DEPENDENCIES} entries`);
  }
  const dependencies: Record<string, string> = {};
  for (const [rawName, rawRange] of entries.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )) {
    const name = rawName.trim();
    const range = rawRange.trim();
    if (
      !VPM_PACKAGE_ID_PATTERN.test(name) ||
      !range ||
      new TextEncoder().encode(range).byteLength > 128 ||
      Array.from(range).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      throw new Error(`YUCP alias dependency is invalid: ${rawName}`);
    }
    if (name !== 'com.yucp.importer') {
      dependencies[name] = range;
    }
  }
  return dependencies;
}

export function buildYucpAliasBootstrapVersion(createdAt: number): string {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('YUCP alias publication time must use Unix epoch milliseconds');
  }
  const day = Math.floor(createdAt / 86_400_000);
  const millisecondOfDay = createdAt % 86_400_000;
  return `1.${day}.${millisecondOfDay}`;
}

function encodeAliasIdentity(input: {
  aliasId: string;
  catalogProductIds: ReadonlyArray<string>;
}): string {
  return JSON.stringify({
    a: normalizeAliasId(input.aliasId),
    p: normalizeCatalogProductIds(input.catalogProductIds),
  });
}

function encodeAliasArtifactDescriptor(input: {
  aliasId: string;
  bootstrapVersion: string;
  catalogProductIds: ReadonlyArray<string>;
  vpmDependencies: Readonly<Record<string, string>>;
}): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      a: normalizeAliasId(input.aliasId),
      b: normalizeBootstrapVersion(input.bootstrapVersion),
      d: normalizeVpmDependencies(input.vpmDependencies),
      p: normalizeCatalogProductIds(input.catalogProductIds),
    }),
    'utf8'
  ).toString('base64url');
}

export function decodeYucpAliasArtifactDescriptor(value: string): {
  aliasId: string;
  bootstrapVersion: string;
  catalogProductIds: string[];
  vpmDependencies: Record<string, string>;
} {
  if (!value || value.length > MAX_ALIAS_DESCRIPTOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('YUCP alias artifact descriptor is invalid');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('YUCP alias artifact descriptor is invalid');
  }
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    (decoded as { v?: unknown }).v !== 2 ||
    typeof (decoded as { a?: unknown }).a !== 'string' ||
    typeof (decoded as { b?: unknown }).b !== 'string' ||
    !isRecord((decoded as { d?: unknown }).d) ||
    !Object.values((decoded as { d: Record<string, unknown> }).d).every(
      (entry) => typeof entry === 'string'
    ) ||
    !Array.isArray((decoded as { p?: unknown }).p) ||
    !(decoded as { p: unknown[] }).p.every((entry) => typeof entry === 'string')
  ) {
    throw new Error('YUCP alias artifact descriptor is invalid');
  }
  const aliasId = normalizeAliasId((decoded as { a: string }).a);
  const bootstrapVersion = normalizeBootstrapVersion((decoded as { b: string }).b);
  const catalogProductIds = normalizeCatalogProductIds((decoded as { p: string[] }).p);
  const vpmDependencies = normalizeVpmDependencies((decoded as { d: Record<string, string> }).d);
  const canonicalDescriptor = encodeAliasArtifactDescriptor({
    aliasId,
    bootstrapVersion,
    catalogProductIds,
    vpmDependencies,
  });
  if (canonicalDescriptor !== value) {
    throw new Error('YUCP alias artifact descriptor is not canonical');
  }
  return { aliasId, bootstrapVersion, catalogProductIds, vpmDependencies };
}

export function buildYucpAliasVpmPackageId(input: {
  aliasId: string;
  catalogProductIds: ReadonlyArray<string>;
}): string {
  const descriptor = encodeAliasIdentity(input);
  const identity = createHash('sha256').update(descriptor, 'utf8').digest('hex');
  return `com.yucp.alias.${identity.slice(0, 32)}`;
}

export function buildYucpAliasVpmPackage(input: {
  aliasId: string;
  bootstrapVersion: string;
  catalogProductIds: ReadonlyArray<string>;
  vpmDependencies: Readonly<Record<string, string>>;
  vpmBaseUrl: string;
}): BuiltYucpAliasVpmPackage {
  const aliasId = normalizeAliasId(input.aliasId);
  const bootstrapVersion = normalizeBootstrapVersion(input.bootstrapVersion);
  const catalogProductIds = normalizeCatalogProductIds(input.catalogProductIds);
  const vpmDependencies = normalizeVpmDependencies(input.vpmDependencies);
  const vpmBaseUrl = normalizeVpmBaseUrl(input.vpmBaseUrl);
  const packageId = buildYucpAliasVpmPackageId({ aliasId, catalogProductIds });
  const displayName = `YUCP Product Bootstrap ${packageId.slice(-8).toUpperCase()}`;
  const packageJson = applyYucpAliasPackageManifestDefaults(
    mergeYucpAliasPackageMetadata({
      metadata: {
        name: packageId,
        displayName,
        version: bootstrapVersion,
        vpmDependencies,
        unity: '2022.3',
        description:
          'Public YUCP bootstrap. Sign in through the importer to resolve licensed product content.',
        author: {
          name: 'YUCP Club',
          email: 'contact@yucp.club',
          url: 'https://yucp.club/',
        },
      },
      aliasId,
      catalogProductIds,
      channel: 'stable',
    })
  ) as Omit<YucpAliasVpmManifest, 'url' | 'zipSHA256'>;
  const bytes = zipSync(
    {
      'package.json': [
        strToU8(`${JSON.stringify(packageJson, null, 2)}\n`),
        { level: 9, mtime: ZIP_TIMESTAMP },
      ],
    },
    { level: 9 }
  );
  const zipSha256 = createHash('sha256').update(bytes).digest('hex');
  const descriptor = encodeAliasArtifactDescriptor({
    aliasId,
    bootstrapVersion,
    catalogProductIds,
    vpmDependencies,
  });
  const artifactUrl = `${vpmBaseUrl}/api/vpm/aliases/${encodeURIComponent(
    descriptor
  )}/${bootstrapVersion}.zip`;

  return {
    bytes,
    packageId,
    zipSha256,
    manifest: {
      ...packageJson,
      url: artifactUrl,
      zipSHA256: zipSha256,
    },
  };
}
