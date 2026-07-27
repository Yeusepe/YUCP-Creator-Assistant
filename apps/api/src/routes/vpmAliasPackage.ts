import { createHash } from 'node:crypto';
import { applyYucpAliasPackageManifestDefaults, mergeYucpAliasPackageMetadata } from '@yucp/shared';
import { strToU8, type Zippable, zipSync } from 'fflate';

const MAX_ALIAS_ID_LENGTH = 512;
const MAX_VPM_DEPENDENCIES = 64;
const MAX_PACKAGE_AUTHOR_LENGTH = 120;
const MAX_PACKAGE_DESCRIPTION_LENGTH = 500;
const MAX_PACKAGE_NAME_LENGTH = 120;
const MAX_PACKAGE_TAGLINE_LENGTH = 160;
const MAX_BOOTSTRAP_MEDIA_BYTES = 2 * 1024 * 1024;
const MAX_BOOTSTRAP_MEDIA_ITEMS = 2;
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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

export type YucpAliasPackageMetadataInput = {
  packageName: string;
  author: string;
  description?: string;
  tagline?: string;
};

export type YucpAliasPackageMediaInput = {
  bucketName?: string;
  kind: 'icon' | 'banner';
  localPath: string;
  objectKey?: string;
  providerVersion?: string;
  contentType: 'image/png';
  bytes: Uint8Array;
  sha256: string;
};

export type YucpAliasPackageMediaReference = Omit<YucpAliasPackageMediaInput, 'bytes'> & {
  byteSize: number;
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
    .map((media) => {
      if (media.kind !== 'icon' && media.kind !== 'banner') {
        throw new Error('YUCP alias media kind is not supported');
      }
      const expectedPath =
        media.kind === 'icon' ? 'Documentation~/YUCP/icon.png' : 'Documentation~/YUCP/banner.png';
      if (media.localPath !== expectedPath) {
        throw new Error('YUCP alias media local path is invalid');
      }
      if (media.contentType !== 'image/png') {
        throw new Error('YUCP alias media content type is not supported');
      }
      const bytes = Uint8Array.from(media.bytes);
      if (
        bytes.byteLength < PNG_SIGNATURE.byteLength ||
        bytes.byteLength > MAX_BOOTSTRAP_MEDIA_BYTES
      ) {
        throw new Error('YUCP alias media exceeds its byte limit');
      }
      if (PNG_SIGNATURE.some((signatureByte, index) => bytes[index] !== signatureByte)) {
        throw new Error('YUCP alias media content type does not match its bytes');
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== media.sha256) {
        throw new Error('YUCP alias media digest does not match its bytes');
      }
      if (seen.has(media.kind)) {
        throw new Error(`YUCP alias media contains a duplicate ${media.kind}`);
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
      seen.add(media.kind);
      return { ...media, bytes, sha256 };
    })
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

function encodeAliasIdentity(input: { aliasId: string }): string {
  return JSON.stringify({
    v: 1,
    a: normalizeAliasId(input.aliasId),
  });
}

export function buildYucpAliasVpmPackageId(input: { aliasId: string }): string {
  const descriptor = encodeAliasIdentity(input);
  const identity = createHash('sha256').update(descriptor, 'utf8').digest('hex');
  return `com.yucp.alias.${identity.slice(0, 32)}`;
}

export function buildYucpAliasVpmPackage(input: {
  aliasId: string;
  artifactUrl: string;
  bootstrapVersion: string;
  vpmDependencies: Readonly<Record<string, string>>;
  packageMetadata?: YucpAliasPackageMetadataInput;
  media?: ReadonlyArray<YucpAliasPackageMediaInput>;
}): BuiltYucpAliasVpmPackage {
  const aliasId = normalizeAliasId(input.aliasId);
  const bootstrapVersion = normalizeBootstrapVersion(input.bootstrapVersion);
  const vpmDependencies = normalizeVpmDependencies(input.vpmDependencies);
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
        version: bootstrapVersion,
        vpmDependencies,
        unity: '2022.3',
        description,
        author: {
          name: authorName,
          email: 'contact@yucp.club',
          url: 'https://yucp.club/',
        },
        ...(packageMetadata || media.length > 0
          ? {
              yucp: {
                kind: 'alias-v1',
                aliasId,
                packageDisplayName: displayName,
                installStrategy: 'server-authorized',
                importerPackage: 'com.yucp.importer',
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
                        byteSize: item.bytes.byteLength,
                        contentType: item.contentType,
                        localPath: item.localPath,
                        sha256: item.sha256,
                      })),
                    }
                  : {}),
              },
            }
          : {}),
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
    archiveEntries[item.localPath] = [item.bytes, { level: 9, mtime: ZIP_TIMESTAMP }];
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
