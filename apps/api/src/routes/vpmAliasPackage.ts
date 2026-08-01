import { createHash } from 'node:crypto';
import {
  applyYucpAliasPackageManifestDefaults,
  mergeYucpAliasPackageMetadata,
  normalizeYucpRequirementMap,
  type YucpBootstrapIntent,
} from '@yucp/shared';
import { strToU8, type Zippable, zipSync } from 'fflate';

const MAX_ALIAS_ID_LENGTH = 512;
const MAX_VPM_DEPENDENCIES = 64;
const MAX_VPM_REPOSITORIES = 16;
const MAX_PACKAGE_AUTHOR_LENGTH = 120;
const MAX_PACKAGE_DESCRIPTION_LENGTH = 500;
const MAX_PACKAGE_NAME_LENGTH = 120;
const MAX_PACKAGE_TAGLINE_LENGTH = 160;
const MAX_BOOTSTRAP_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_BOOTSTRAP_MEDIA_ITEMS = 42;
const MAX_GALLERY_MEDIA_ITEMS = 8;
const MAX_PRODUCT_LINK_MEDIA_ITEMS = 32;
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Uint8Array.from([0xff, 0xd8, 0xff]);
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
  vpmRepositories?: Record<string, string>;
  yucp: Record<string, unknown>;
  zipSHA256: string;
};

export type BuiltYucpAliasVpmPackage = {
  bytes: Uint8Array;
  manifest: YucpAliasVpmManifest;
  packageId: string;
  zipSha256: string;
};

export type YucpAliasPackageMetadataInput = {
  packageName: string;
  author: string;
  description?: string;
  tagline?: string;
};

export type YucpAliasPackageMediaInput = {
  // Storage/payload fields are absent for product links that ship no image.
  bucketName?: string;
  kind: 'banner' | 'gallery' | 'icon' | 'product-link';
  label?: string;
  localPath?: string;
  objectKey?: string;
  ordinal?: number;
  providerVersion?: string;
  contentType?: 'image/jpeg' | 'image/png';
  bytes?: Uint8Array;
  sha256?: string;
  url?: string;
};

export type YucpAliasPackageMediaReference = Omit<YucpAliasPackageMediaInput, 'bytes'> & {
  byteSize?: number;
};

function normalizeArtifactUrl(value: string, bootstrapVersion: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VPM alias artifact URL must be an absolute HTTPS or loopback HTTP URL');
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname))
  ) {
    throw new Error('VPM alias artifact URL must be an absolute HTTPS or loopback HTTP URL');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('VPM alias artifact URL must not contain credentials, a query, or a fragment');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (
    segments.length !== 5 ||
    segments[0] !== 'api' ||
    segments[1] !== 'vpm' ||
    segments[2] !== 'alias-publications' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      segments[3] ?? ''
    ) ||
    segments[4] !== `${bootstrapVersion}.zip`
  ) {
    throw new Error('VPM alias artifact URL does not match its immutable publication');
  }
  return url.toString();
}

function normalizeAliasId(value: string): string {
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!normalized || normalized.length > MAX_ALIAS_ID_LENGTH || hasControlCharacter) {
    throw new Error('YUCP alias ID must contain 1 through 512 safe characters');
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

function normalizePackageMetadata(
  value: YucpAliasPackageMetadataInput | undefined
): YucpAliasPackageMetadataInput | undefined {
  if (!value) {
    return undefined;
  }
  const normalizeField = (field: string, maximumLength: number, name: string): string => {
    const normalized = field.trim();
    if (!normalized || normalized.length > maximumLength) {
      throw new Error(`YUCP alias ${name} must contain 1 through ${maximumLength} characters`);
    }
    return normalized;
  };
  return {
    packageName: normalizeField(value.packageName, MAX_PACKAGE_NAME_LENGTH, 'package name'),
    author: normalizeField(value.author, MAX_PACKAGE_AUTHOR_LENGTH, 'package author'),
    ...(value.description
      ? {
          description: normalizeField(
            value.description,
            MAX_PACKAGE_DESCRIPTION_LENGTH,
            'package description'
          ),
        }
      : {}),
    ...(value.tagline
      ? {
          tagline: normalizeField(value.tagline, MAX_PACKAGE_TAGLINE_LENGTH, 'package tagline'),
        }
      : {}),
  };
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

/**
 * A dependency VCC cannot locate is not installable, so the repositories the
 * package was built against travel with it.
 */
function normalizeVpmRepositories(
  value: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const entries = Object.entries(value ?? {});
  if (entries.length > MAX_VPM_REPOSITORIES) {
    throw new Error(`YUCP alias repositories exceed ${MAX_VPM_REPOSITORIES} entries`);
  }
  const repositories: Record<string, string> = {};
  for (const [rawName, rawUrl] of entries.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )) {
    const name = rawName.trim();
    if (!name || new TextEncoder().encode(name).byteLength > 120) {
      throw new Error(`YUCP alias repository name is invalid: ${rawName}`);
    }
    let url: URL;
    try {
      url = new URL(rawUrl?.trim() ?? '');
    } catch {
      throw new Error(`YUCP alias repository URL is invalid: ${rawName}`);
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error(`YUCP alias repository URL is invalid: ${rawName}`);
    }
    repositories[name] = url.toString();
  }
  return repositories;
}

function normalizeProductLinkMetadata(
  media: Pick<YucpAliasPackageMediaInput, 'label' | 'url'>
): Pick<YucpAliasPackageMediaInput, 'label' | 'url'> {
  const label = media.label?.trim() ?? '';
  if (!label || new TextEncoder().encode(label).byteLength > 120) {
    throw new Error('YUCP alias product link label is invalid');
  }
  let url: URL;
  try {
    url = new URL(media.url ?? '');
  } catch {
    throw new Error('YUCP alias product link URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('YUCP alias product link URL is invalid');
  }
  return { label, url: url.toString() };
}

function normalizeMedia(
  value: ReadonlyArray<YucpAliasPackageMediaInput> | undefined
): YucpAliasPackageMediaInput[] {
  if (!value) {
    return [];
  }
  if (value.length > MAX_BOOTSTRAP_MEDIA_ITEMS) {
    throw new Error(`YUCP alias media exceeds ${MAX_BOOTSTRAP_MEDIA_ITEMS} items`);
  }
  const seen = new Set<string>();
  return [...value]
    .map((media): YucpAliasPackageMediaInput => {
      if (
        media.kind !== 'icon' &&
        media.kind !== 'banner' &&
        media.kind !== 'gallery' &&
        media.kind !== 'product-link'
      ) {
        throw new Error('YUCP alias media kind is not supported');
      }
      const requiresOrdinal = media.kind === 'gallery' || media.kind === 'product-link';
      const maximumOrdinal =
        media.kind === 'gallery' ? MAX_GALLERY_MEDIA_ITEMS : MAX_PRODUCT_LINK_MEDIA_ITEMS;
      if (
        requiresOrdinal &&
        (!Number.isSafeInteger(media.ordinal) ||
          (media.ordinal as number) < 0 ||
          (media.ordinal as number) >= maximumOrdinal)
      ) {
        throw new Error('YUCP alias media ordinal is invalid');
      }
      if (!requiresOrdinal && media.ordinal !== undefined) {
        throw new Error('YUCP alias media ordinal is invalid');
      }
      const hasPayload =
        media.bytes !== undefined ||
        media.sha256 !== undefined ||
        media.contentType !== undefined ||
        media.localPath !== undefined ||
        media.bucketName !== undefined ||
        media.objectKey !== undefined ||
        media.providerVersion !== undefined;
      if (!hasPayload) {
        if (media.kind !== 'product-link') {
          throw new Error('YUCP alias media requires an image payload');
        }
        const role = `product-link:${media.ordinal ?? 0}`;
        if (seen.has(role)) {
          throw new Error('YUCP alias media contains a duplicate product-link role');
        }
        seen.add(role);
        return {
          kind: media.kind,
          ordinal: media.ordinal as number,
          ...normalizeProductLinkMetadata(media),
        };
      }
      if (media.contentType !== 'image/png' && media.contentType !== 'image/jpeg') {
        throw new Error('YUCP alias media content type is not supported');
      }
      const extension = media.contentType === 'image/png' ? 'png' : 'jpg';
      const expectedPath =
        media.kind === 'icon' || media.kind === 'banner'
          ? `Documentation~/YUCP/${media.kind}.${extension}`
          : `Documentation~/YUCP/${
              media.kind === 'gallery' ? 'gallery' : 'product-links'
            }/${String(media.ordinal).padStart(3, '0')}.${extension}`;
      if (media.localPath !== expectedPath) {
        throw new Error('YUCP alias media local path is invalid');
      }
      if (media.bytes === undefined) {
        throw new Error('YUCP alias media requires an image payload');
      }
      const bytes = Uint8Array.from(media.bytes);
      if (bytes.byteLength < 8 || bytes.byteLength > MAX_BOOTSTRAP_MEDIA_BYTES) {
        throw new Error('YUCP alias media exceeds its byte limit');
      }
      const signature = media.contentType === 'image/png' ? PNG_SIGNATURE : JPEG_SIGNATURE;
      if (signature.some((signatureByte, index) => bytes[index] !== signatureByte)) {
        throw new Error('YUCP alias media content type does not match its bytes');
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== media.sha256) {
        throw new Error('YUCP alias media digest does not match its bytes');
      }
      const role = `${media.kind}:${media.ordinal ?? 0}`;
      if (seen.has(role)) {
        throw new Error(`YUCP alias media contains a duplicate ${media.kind} role`);
      }
      const storageFields = [media.bucketName, media.objectKey, media.providerVersion];
      if (
        storageFields.some((field) => field !== undefined) &&
        !storageFields.every(
          (field) =>
            typeof field === 'string' &&
            field.trim().length > 0 &&
            new TextEncoder().encode(field).byteLength <= 1_024
        )
      ) {
        throw new Error('YUCP alias media exact storage reference is incomplete');
      }
      let productLinkMetadata: Pick<YucpAliasPackageMediaInput, 'label' | 'url'> = {};
      if (media.kind === 'product-link') {
        productLinkMetadata = normalizeProductLinkMetadata(media);
      } else if (media.label !== undefined || media.url !== undefined) {
        throw new Error('YUCP alias product link metadata is invalid');
      }
      seen.add(role);
      return { ...media, ...productLinkMetadata, bytes, sha256 };
    })
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        (left.ordinal ?? 0) - (right.ordinal ?? 0) ||
        (left.localPath ?? '').localeCompare(right.localPath ?? '')
    );
}

export function buildYucpAliasVpmPackageId(input: { aliasId: string }): string {
  const packageId = normalizeAliasId(input.aliasId);
  if (!VPM_PACKAGE_ID_PATTERN.test(packageId)) {
    throw new Error('YUCP alias ID must be a valid VPM package ID');
  }
  return packageId;
}

export function normalizeYucpPackageVersion(value: string): string {
  const normalized = value.trim();
  if (VPM_VERSION_PATTERN.test(normalized)) {
    return normalized;
  }
  const abbreviated = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(normalized);
  if (!abbreviated) {
    throw new Error('YUCP package version must use Semantic Versioning');
  }
  return `${abbreviated[1]}.${abbreviated[2] ?? '0'}.0`;
}

export function buildYucpAliasVpmPackage(input: {
  aliasId: string;
  artifactUrl: string;
  bootstrapVersion: string;
  bootstrapIntent?: YucpBootstrapIntent;
  packageVersion?: string;
  vpmDependencies: Readonly<Record<string, string>>;
  vpmRepositories?: Readonly<Record<string, string>>;
  releaseVpmDependencies?: Readonly<Record<string, string>>;
  releaseVpmRepositories?: Readonly<Record<string, string>>;
  packageMetadata?: YucpAliasPackageMetadataInput;
  media?: ReadonlyArray<YucpAliasPackageMediaInput>;
}): BuiltYucpAliasVpmPackage {
  const aliasId = normalizeAliasId(input.aliasId);
  const bootstrapVersion = normalizeBootstrapVersion(input.bootstrapVersion);
  const packageVersion = input.packageVersion
    ? normalizeYucpPackageVersion(input.packageVersion)
    : bootstrapVersion;
  const vpmDependencies = normalizeVpmDependencies(input.vpmDependencies);
  const vpmRepositories = normalizeVpmRepositories(input.vpmRepositories);
  // Display only. These never reach the manifest's vpmDependencies, so the
  // Creator Companion still installs the importer and nothing else.
  const releaseVpmDependencies = normalizeYucpRequirementMap(input.releaseVpmDependencies);
  const releaseVpmRepositories = normalizeYucpRequirementMap(input.releaseVpmRepositories);
  const packageMetadata = normalizePackageMetadata(input.packageMetadata);
  const media = normalizeMedia(input.media);
  const artifactUrl = normalizeArtifactUrl(input.artifactUrl, bootstrapVersion);
  const packageId = buildYucpAliasVpmPackageId({ aliasId });
  const defaultDescription = 'Adds this licensed product to your Unity project with YUCP.';
  const displayName = packageMetadata?.packageName || 'YUCP Licensed Product';
  const description = packageMetadata?.description || defaultDescription;
  const authorName = packageMetadata?.author || 'YUCP Club';
  const packageJson = applyYucpAliasPackageManifestDefaults(
    mergeYucpAliasPackageMetadata({
      metadata: {
        name: packageId,
        displayName,
        version: packageVersion,
        vpmDependencies,
        ...(Object.keys(vpmRepositories).length > 0 ? { vpmRepositories } : {}),
        unity: '2022.3',
        description,
        author: {
          name: authorName,
          email: 'contact@yucp.club',
          url: 'https://yucp.club/',
        },
        yucp: {
          kind: input.bootstrapIntent ? 'alias-v2' : 'alias-v1',
          aliasId,
          packageVersion,
          packageDisplayName: displayName,
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          ...(input.bootstrapIntent ? { bootstrapIntent: input.bootstrapIntent } : {}),
          ...(Object.keys(releaseVpmDependencies).length > 0
            ? { releaseVpmDependencies }
            : {}),
          ...(Object.keys(releaseVpmRepositories).length > 0
            ? { releaseVpmRepositories }
            : {}),
          ...(packageMetadata
            ? {
                packageMetadata: {
                  packageName: displayName,
                  author: authorName,
                  ...(packageMetadata.description
                    ? { description: packageMetadata.description }
                    : {}),
                  ...(packageMetadata.tagline ? { tagline: packageMetadata.tagline } : {}),
                },
              }
            : {}),
          ...(media.length > 0
            ? {
                media: media.map((item) => ({
                  kind: item.kind,
                  ...(item.bytes
                    ? {
                        byteSize: item.bytes.byteLength,
                        contentType: item.contentType,
                        localPath: item.localPath,
                        sha256: item.sha256,
                      }
                    : {}),
                  ...(item.ordinal === undefined ? {} : { ordinal: item.ordinal }),
                  ...(item.label ? { label: item.label } : {}),
                  ...(item.url ? { url: item.url } : {}),
                })),
              }
            : {}),
        },
      },
      aliasId,
      channel: 'stable',
    })
  ) as Omit<YucpAliasVpmManifest, 'url' | 'zipSHA256'>;
  const archiveEntries: Zippable = {
    'package.json': [
      strToU8(`${JSON.stringify(packageJson, null, 2)}\n`),
      { level: 9, mtime: ZIP_TIMESTAMP },
    ],
  };
  for (const item of media) {
    if (item.bytes && item.localPath) {
      archiveEntries[item.localPath] = [item.bytes, { level: 9, mtime: ZIP_TIMESTAMP }];
    }
  }
  const bytes = zipSync(archiveEntries, { level: 9 });
  const zipSha256 = createHash('sha256').update(bytes).digest('hex');
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
