import { createHash } from 'node:crypto';
import { applyYucpAliasPackageManifestDefaults, mergeYucpAliasPackageMetadata } from '@yucp/shared';
import { strToU8, zipSync } from 'fflate';

export const YUCP_ALIAS_BOOTSTRAP_VERSION = '1.0.0';

const MAX_CATALOG_PRODUCT_ID_LENGTH = 512;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const ZIP_TIMESTAMP = new Date('1980-01-01T00:00:00.000Z');

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

export function buildYucpAliasVpmPackageId(catalogProductId: string): string {
  const normalizedCatalogProductId = normalizeCatalogProductId(catalogProductId);
  const identity = createHash('sha256').update(normalizedCatalogProductId, 'utf8').digest('hex');
  return `com.yucp.alias.${identity.slice(0, 32)}`;
}

export function buildYucpAliasVpmPackage(input: {
  catalogProductId: string;
  vpmBaseUrl: string;
}): BuiltYucpAliasVpmPackage {
  const catalogProductId = normalizeCatalogProductId(input.catalogProductId);
  const vpmBaseUrl = normalizeVpmBaseUrl(input.vpmBaseUrl);
  const packageId = buildYucpAliasVpmPackageId(catalogProductId);
  const displayName = `YUCP Product Bootstrap ${packageId.slice(-8).toUpperCase()}`;
  const packageJson = applyYucpAliasPackageManifestDefaults(
    mergeYucpAliasPackageMetadata({
      metadata: {
        name: packageId,
        displayName,
        version: YUCP_ALIAS_BOOTSTRAP_VERSION,
        unity: '2022.3',
        description:
          'Public YUCP bootstrap. Sign in through the importer to resolve licensed product content.',
        author: {
          name: 'YUCP Club',
          email: 'contact@yucp.club',
          url: 'https://yucp.club/',
        },
      },
      aliasId: catalogProductId,
      catalogProductIds: [catalogProductId],
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
  const artifactUrl = `${vpmBaseUrl}/api/vpm/aliases/${encodeURIComponent(
    catalogProductId
  )}/${YUCP_ALIAS_BOOTSTRAP_VERSION}.zip`;

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
