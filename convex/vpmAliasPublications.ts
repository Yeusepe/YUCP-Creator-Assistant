import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { ApiActorBindingV, requireServiceActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';
import { requireCreatorWorkspaceActor } from './lib/creatorWorkspaceAccess';

const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._/:~-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PUBLICATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SAFE_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const VPM_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_REVISION_COMPONENT = 999_999;
const REVISION_MINOR_SPAN = 1_000_000;
const REVISION_MAJOR_SPAN = 1_000_000_000_000;

const MediaV = v.object({
  // Storage/payload fields are absent for product links that ship no image.
  bucketName: v.optional(v.string()),
  byteSize: v.optional(v.number()),
  contentType: v.optional(v.union(v.literal('image/png'), v.literal('image/jpeg'))),
  kind: v.union(
    v.literal('icon'),
    v.literal('banner'),
    v.literal('gallery'),
    v.literal('product-link')
  ),
  label: v.optional(v.string()),
  localPath: v.optional(v.string()),
  objectKey: v.optional(v.string()),
  ordinal: v.optional(v.number()),
  providerVersion: v.optional(v.string()),
  sha256: v.optional(v.string()),
  url: v.optional(v.string()),
});

const PresentationInputV = {
  authUserId: v.string(),
  packageId: v.string(),
  channel: v.string(),
  artifactBaseUrl: v.string(),
  artifactBucketName: v.string(),
  artifactFormat: v.literal('vpm-alias-zip-v1'),
  contractVersion: v.literal(1),
  packageName: v.string(),
  authorName: v.string(),
  description: v.string(),
  tagline: v.optional(v.string()),
  unityVersion: v.string(),
  importerPackage: v.literal('com.yucp.importer'),
  minImporterVersion: v.string(),
  media: v.array(MediaV),
} as const;

const PresentationResultV = v.object({
  created: v.boolean(),
  changed: v.boolean(),
  packageId: v.string(),
  channel: v.string(),
  presentationFingerprintSha256: v.string(),
  updatedAt: v.number(),
});

const ArtifactV = v.object({
  bucketName: v.string(),
  byteSize: v.number(),
  contentType: v.literal('application/zip'),
  objectKey: v.string(),
  providerVersion: v.string(),
  sha256: v.string(),
});

const PublicationReasonV = v.union(
  v.literal('link-activation'),
  v.literal('presentation-update'),
  v.literal('migration')
);

const PublicationReservationV = v.object({
  bootstrapVersion: v.string(),
  channel: v.string(),
  created: v.boolean(),
  packageId: v.string(),
  packageVersion: v.string(),
  presentationFingerprintSha256: v.string(),
  publicationId: v.string(),
  revision: v.number(),
  status: v.union(v.literal('PREPARING'), v.literal('PUBLISHED')),
});

const PublishedPublicationV = v.object({
  aliasPackageId: v.string(),
  artifact: ArtifactV,
  bootstrapVersion: v.string(),
  channel: v.string(),
  contractVersion: v.literal(1),
  createdAt: v.number(),
  packageId: v.string(),
  packageVersion: v.optional(v.string()),
  presentationFingerprintSha256: v.string(),
  publicationId: v.string(),
  publishedAt: v.number(),
  repositoryManifestJson: v.string(),
  repositoryManifestSha256: v.string(),
  revision: v.number(),
  status: v.literal('PUBLISHED'),
});

type PresentationInput = {
  authUserId: string;
  packageId: string;
  channel: string;
  artifactBaseUrl: string;
  artifactBucketName: string;
  artifactFormat: 'vpm-alias-zip-v1';
  contractVersion: 1;
  packageName: string;
  authorName: string;
  description: string;
  tagline?: string;
  unityVersion: string;
  importerPackage: 'com.yucp.importer';
  minImporterVersion: string;
  media: Array<{
    // Storage/payload fields are absent for product links that ship no image.
    bucketName?: string;
    byteSize?: number;
    contentType?: 'image/jpeg' | 'image/png';
    kind: 'banner' | 'gallery' | 'icon' | 'product-link';
    label?: string;
    localPath?: string;
    objectKey?: string;
    ordinal?: number;
    providerVersion?: string;
    sha256?: string;
    url?: string;
  }>;
};

type NormalizedPresentation = Omit<PresentationInput, 'authUserId'> & {
  creatorAuthUserId: string;
  fingerprintInputJson: string;
  presentationFingerprintSha256: string;
};

type PublishedPublication = {
  aliasPackageId: string;
  artifact: NonNullable<Doc<'vpm_alias_publications'>['artifact']>;
  bootstrapVersion: string;
  channel: string;
  contractVersion: 1;
  createdAt: number;
  packageId: string;
  packageVersion?: string;
  presentationFingerprintSha256: string;
  publicationId: string;
  publishedAt: number;
  repositoryManifestJson: string;
  repositoryManifestSha256: string;
  revision: number;
  status: 'PUBLISHED';
};

function requiredText(value: string, name: string, maximumBytes: number): string {
  const normalized = value.trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > maximumBytes) {
    throw new ConvexError(`${name} is invalid`);
  }
  return normalized;
}

function normalizePackageVersion(value: string): string {
  const normalized = value.trim();
  if (VPM_VERSION_PATTERN.test(normalized)) {
    return normalized;
  }
  const abbreviated = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(normalized);
  if (!abbreviated) {
    throw new ConvexError('VPM package version is invalid');
  }
  return `${abbreviated[1]}.${abbreviated[2] ?? '0'}.0`;
}

function optionalText(
  value: string | undefined,
  name: string,
  maximumBytes: number
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredText(value, name, maximumBytes);
}

function validatePackageId(packageId: string): string {
  const normalized = packageId.trim();
  if (!PACKAGE_ID_PATTERN.test(normalized)) {
    throw new ConvexError('Package ID is invalid');
  }
  return normalized;
}

function validateChannel(channel: string): string {
  const normalized = channel.trim();
  if (!SAFE_CHANNEL_PATTERN.test(normalized)) {
    throw new ConvexError('VPM channel is invalid');
  }
  return normalized;
}

function validateSha256(sha256: string, name: string): string {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new ConvexError(`${name} is invalid`);
  }
  return sha256;
}

function normalizeArtifactBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConvexError('VPM artifact base URL is invalid');
  }
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ConvexError('VPM artifact base URL is invalid');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ConvexError('VPM presentation contains a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new ConvexError('VPM presentation contains an unsupported value');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeMedia(media: PresentationInput['media']): PresentationInput['media'] {
  if (media.length > 42) {
    throw new ConvexError('VPM presentation media exceeds 42 items');
  }
  const roles = new Set<string>();
  return media
    .map((entry): PresentationInput['media'][number] => {
      const requiresOrdinal = entry.kind === 'gallery' || entry.kind === 'product-link';
      const maximumOrdinal = entry.kind === 'gallery' ? 8 : 32;
      if (
        requiresOrdinal &&
        (!Number.isSafeInteger(entry.ordinal) ||
          (entry.ordinal as number) < 0 ||
          (entry.ordinal as number) >= maximumOrdinal)
      ) {
        throw new ConvexError('VPM presentation media ordinal is invalid');
      }
      if (!requiresOrdinal && entry.ordinal !== undefined) {
        throw new ConvexError('VPM presentation media ordinal is invalid');
      }
      const role = `${entry.kind}:${entry.ordinal ?? 0}`;
      if (roles.has(role)) {
        throw new ConvexError(`VPM presentation contains a duplicate ${entry.kind} role`);
      }
      roles.add(role);
      let productLinkMetadata: Pick<PresentationInput['media'][number], 'label' | 'url'> = {};
      if (entry.kind === 'product-link') {
        const label = requiredText(entry.label ?? '', 'VPM product link label', 120);
        const urlText = requiredText(entry.url ?? '', 'VPM product link URL', 2_048);
        let url: URL;
        try {
          url = new URL(urlText);
        } catch {
          throw new ConvexError('VPM product link URL is invalid');
        }
        if (url.protocol !== 'https:' || url.username || url.password) {
          throw new ConvexError('VPM product link URL is invalid');
        }
        productLinkMetadata = { label, url: url.toString() };
      } else if (entry.label !== undefined || entry.url !== undefined) {
        throw new ConvexError('VPM presentation media product link metadata is invalid');
      }
      const hasPayload =
        entry.bucketName !== undefined ||
        entry.byteSize !== undefined ||
        entry.contentType !== undefined ||
        entry.localPath !== undefined ||
        entry.objectKey !== undefined ||
        entry.providerVersion !== undefined ||
        entry.sha256 !== undefined;
      if (!hasPayload) {
        if (entry.kind !== 'product-link') {
          throw new ConvexError('VPM presentation media requires an image payload');
        }
        return {
          kind: entry.kind,
          ordinal: entry.ordinal as number,
          ...productLinkMetadata,
        };
      }
      const extension = entry.contentType === 'image/png' ? 'png' : 'jpg';
      const expectedPath =
        entry.kind === 'icon' || entry.kind === 'banner'
          ? `Documentation~/YUCP/${entry.kind}.${extension}`
          : `Documentation~/YUCP/${
              entry.kind === 'gallery' ? 'gallery' : 'product-links'
            }/${String(entry.ordinal).padStart(3, '0')}.${extension}`;
      if (
        (entry.contentType !== 'image/png' && entry.contentType !== 'image/jpeg') ||
        entry.localPath !== expectedPath ||
        !Number.isSafeInteger(entry.byteSize) ||
        (entry.byteSize as number) < 8 ||
        (entry.byteSize as number) > 16 * 1024 * 1024
      ) {
        throw new ConvexError('VPM presentation media is invalid');
      }
      return {
        bucketName: requiredText(entry.bucketName ?? '', 'VPM media bucket', 1_024),
        byteSize: entry.byteSize,
        contentType: entry.contentType,
        kind: entry.kind,
        localPath: entry.localPath,
        objectKey: requiredText(entry.objectKey ?? '', 'VPM media object key', 1_024),
        ...(entry.ordinal === undefined ? {} : { ordinal: entry.ordinal }),
        providerVersion: requiredText(
          entry.providerVersion ?? '',
          'VPM media provider version',
          1_024
        ),
        sha256: validateSha256(entry.sha256 ?? '', 'VPM media SHA-256'),
        ...productLinkMetadata,
      };
    })
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        (left.ordinal ?? 0) - (right.ordinal ?? 0) ||
        (left.localPath ?? '').localeCompare(right.localPath ?? '')
    );
}

async function normalizePresentation(input: PresentationInput): Promise<NormalizedPresentation> {
  const media = normalizeMedia(input.media);
  const normalized = {
    creatorAuthUserId: requiredText(input.authUserId, 'Creator auth user ID', 256),
    packageId: validatePackageId(input.packageId),
    channel: validateChannel(input.channel),
    artifactBaseUrl: normalizeArtifactBaseUrl(input.artifactBaseUrl),
    artifactBucketName: requiredText(input.artifactBucketName, 'VPM artifact bucket', 1_024),
    artifactFormat: input.artifactFormat,
    contractVersion: input.contractVersion,
    packageName: requiredText(input.packageName, 'VPM package name', 120),
    authorName: requiredText(input.authorName, 'VPM package author', 120),
    description: requiredText(input.description, 'VPM package description', 500),
    tagline: optionalText(input.tagline, 'VPM package tagline', 160),
    unityVersion: requiredText(input.unityVersion, 'VPM Unity version', 32),
    importerPackage: input.importerPackage,
    minImporterVersion: requiredText(input.minImporterVersion, 'VPM minimum importer version', 64),
    media,
  } as const;
  const fingerprintInputJson = canonicalJson({
    artifactBaseUrl: normalized.artifactBaseUrl,
    artifactBucketName: normalized.artifactBucketName,
    artifactFormat: normalized.artifactFormat,
    authorName: normalized.authorName,
    channel: normalized.channel,
    contractVersion: normalized.contractVersion,
    description: normalized.description,
    importerPackage: normalized.importerPackage,
    media: normalized.media.map((entry) => ({
      // Payload-less product links carry no image fields; a key explicitly set to
      // undefined would make the canonical fingerprint serializer reject the write.
      ...(entry.byteSize === undefined ? {} : { byteSize: entry.byteSize }),
      ...(entry.contentType === undefined ? {} : { contentType: entry.contentType }),
      kind: entry.kind,
      ...(entry.localPath === undefined ? {} : { localPath: entry.localPath }),
      ...(entry.ordinal === undefined ? {} : { ordinal: entry.ordinal }),
      ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.url ? { url: entry.url } : {}),
    })),
    minImporterVersion: normalized.minImporterVersion,
    packageId: normalized.packageId,
    packageName: normalized.packageName,
    ...(normalized.tagline ? { tagline: normalized.tagline } : {}),
    unityVersion: normalized.unityVersion,
  });
  const presentationFingerprintSha256 = await sha256Hex(
    `yucp:vpm-alias-presentation:v2\u0000${fingerprintInputJson}`
  );
  return {
    ...normalized,
    fingerprintInputJson,
    presentationFingerprintSha256,
  };
}

async function requireOwnedPackage(
  ctx: QueryCtx | MutationCtx,
  input: { authUserId: string; packageId: string }
): Promise<Doc<'package_registry'>> {
  const registration = await ctx.db
    .query('package_registry')
    .withIndex('by_package_id', (q) => q.eq('packageId', validatePackageId(input.packageId)))
    .first();
  if (
    !registration ||
    registration.yucpUserId !== input.authUserId ||
    registration.status === 'archived'
  ) {
    throw new ConvexError('Package is not available');
  }
  return registration;
}

function revisionToVersion(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ConvexError('VPM alias revision is invalid');
  }
  const offset = revision - 1;
  const major = 1 + Math.floor(offset / REVISION_MAJOR_SPAN);
  const remainder = offset % REVISION_MAJOR_SPAN;
  const minor = Math.floor(remainder / REVISION_MINOR_SPAN);
  const patch = remainder % REVISION_MINOR_SPAN;
  if (
    major > MAX_REVISION_COMPONENT ||
    minor > MAX_REVISION_COMPONENT ||
    patch > MAX_REVISION_COMPONENT
  ) {
    throw new ConvexError('VPM alias revision exceeds Unity package version limits');
  }
  return `${major}.${minor}.${patch}`;
}

function serializeReservation(
  publication: Doc<'vpm_alias_publications'>,
  created: boolean
): {
  bootstrapVersion: string;
  channel: string;
  created: boolean;
  packageId: string;
  packageVersion: string;
  presentationFingerprintSha256: string;
  publicationId: string;
  revision: number;
  status: 'PREPARING' | 'PUBLISHED';
} {
  if (publication.status === 'FAILED') {
    throw new ConvexError('Failed VPM alias publication was not prepared for retry');
  }
  return {
    bootstrapVersion: publication.bootstrapVersion,
    channel: publication.channel,
    created,
    packageId: publication.packageId,
    packageVersion: publication.packageVersion ?? publication.bootstrapVersion,
    presentationFingerprintSha256: publication.presentationFingerprintSha256,
    publicationId: publication.publicationId,
    revision: publication.revision,
    status: publication.status,
  };
}

function serializePublished(
  publication: Doc<'vpm_alias_publications'>
): PublishedPublication | null {
  if (
    publication.status !== 'PUBLISHED' ||
    !publication.aliasPackageId ||
    !publication.artifact ||
    !publication.publishedAt ||
    !publication.repositoryManifestJson ||
    !publication.repositoryManifestSha256
  ) {
    return null;
  }
  return {
    aliasPackageId: publication.aliasPackageId,
    artifact: publication.artifact,
    bootstrapVersion: publication.bootstrapVersion,
    channel: publication.channel,
    contractVersion: publication.contractVersion,
    createdAt: publication.createdAt,
    packageId: publication.packageId,
    ...(publication.packageVersion ? { packageVersion: publication.packageVersion } : {}),
    presentationFingerprintSha256: publication.presentationFingerprintSha256,
    publicationId: publication.publicationId,
    publishedAt: publication.publishedAt,
    repositoryManifestJson: publication.repositoryManifestJson,
    repositoryManifestSha256: publication.repositoryManifestSha256,
    revision: publication.revision,
    status: 'PUBLISHED',
  };
}

async function writePresentation(
  ctx: MutationCtx,
  input: PresentationInput,
  mode: 'seed' | 'update'
): Promise<{
  created: boolean;
  changed: boolean;
  packageId: string;
  channel: string;
  presentationFingerprintSha256: string;
  updatedAt: number;
}> {
  const normalized = await normalizePresentation(input);
  const registration = await requireOwnedPackage(ctx, {
    authUserId: normalized.creatorAuthUserId,
    packageId: normalized.packageId,
  });
  const existing = await ctx.db
    .query('package_vpm_presentations')
    .withIndex('by_creator_package_channel', (q) =>
      q
        .eq('creatorAuthUserId', normalized.creatorAuthUserId)
        .eq('packageId', normalized.packageId)
        .eq('channel', normalized.channel)
    )
    .first();
  if (existing && mode === 'seed') {
    return {
      created: false,
      changed: false,
      packageId: existing.packageId,
      channel: existing.channel,
      presentationFingerprintSha256: existing.presentationFingerprintSha256,
      updatedAt: existing.updatedAt,
    };
  }
  const now = Date.now();
  if (existing) {
    const changed =
      existing.presentationFingerprintSha256 !== normalized.presentationFingerprintSha256;
    await ctx.db.patch(registration._id, {
      packageName: normalized.packageName,
      updatedAt: now,
    });
    await ctx.db.patch(existing._id, {
      ...normalized,
      createdAt: existing.createdAt,
      updatedAt: now,
    });
    return {
      created: false,
      changed,
      packageId: normalized.packageId,
      channel: normalized.channel,
      presentationFingerprintSha256: normalized.presentationFingerprintSha256,
      updatedAt: now,
    };
  }
  await ctx.db.patch(registration._id, {
    packageName: normalized.packageName,
    updatedAt: now,
  });
  await ctx.db.insert('package_vpm_presentations', {
    ...normalized,
    createdAt: now,
    updatedAt: now,
  });
  return {
    created: true,
    changed: true,
    packageId: normalized.packageId,
    channel: normalized.channel,
    presentationFingerprintSha256: normalized.presentationFingerprintSha256,
    updatedAt: now,
  };
}

export const seedPresentationIfMissingForCreator = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    ...PresentationInputV,
  },
  returns: PresentationResultV,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireCreatorWorkspaceActor(ctx, args.actor, args.authUserId);
    return await writePresentation(ctx, args, 'seed');
  },
});

export const updatePresentationForCreator = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    ...PresentationInputV,
  },
  returns: PresentationResultV,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireCreatorWorkspaceActor(ctx, args.actor, args.authUserId);
    return await writePresentation(ctx, args, 'update');
  },
});

const { authUserId: _serviceAuthUserId, ...ServicePresentationInputV } = PresentationInputV;

/**
 * Upsert a package presentation from release-derived values on behalf of the
 * publishing service, so publications triggered without a creator session
 * (e.g. buyer repository refresh after a new release) still serve the latest
 * release metadata. The owning creator is resolved from the package registry.
 */
export const syncPresentationForService = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    ...ServicePresentationInputV,
  },
  returns: PresentationResultV,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    const registration = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', validatePackageId(args.packageId)))
      .first();
    if (!registration?.yucpUserId || registration.status === 'archived') {
      throw new ConvexError('Package is not available');
    }
    return await writePresentation(ctx, { ...args, authUserId: registration.yucpUserId }, 'update');
  },
});

export const getPresentationForService = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    packageId: v.string(),
    channel: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      artifactBaseUrl: v.string(),
      artifactBucketName: v.optional(v.string()),
      authorName: v.string(),
      channel: v.string(),
      description: v.string(),
      media: v.array(MediaV),
      minImporterVersion: v.string(),
      packageId: v.string(),
      packageName: v.string(),
      presentationFingerprintSha256: v.string(),
      tagline: v.optional(v.string()),
      unityVersion: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    const packageId = validatePackageId(args.packageId);
    const channel = validateChannel(args.channel);
    const presentation = await ctx.db
      .query('package_vpm_presentations')
      .withIndex('by_package_channel', (q) => q.eq('packageId', packageId).eq('channel', channel))
      .first();
    if (!presentation) {
      return null;
    }
    return {
      artifactBaseUrl: presentation.artifactBaseUrl,
      ...(presentation.artifactBucketName
        ? { artifactBucketName: presentation.artifactBucketName }
        : {}),
      authorName: presentation.authorName,
      channel: presentation.channel,
      description: presentation.description,
      media: presentation.media,
      minImporterVersion: presentation.minImporterVersion,
      packageId: presentation.packageId,
      packageName: presentation.packageName,
      presentationFingerprintSha256: presentation.presentationFingerprintSha256,
      ...(presentation.tagline ? { tagline: presentation.tagline } : {}),
      unityVersion: presentation.unityVersion,
    };
  },
});

export const reservePublicationForService = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    packageId: v.string(),
    channel: v.string(),
    presentationFingerprintSha256: v.string(),
    publicationId: v.string(),
    packageVersion: v.optional(v.string()),
    publicationReason: PublicationReasonV,
    traceparent: v.optional(v.string()),
  },
  returns: PublicationReservationV,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    const packageId = validatePackageId(args.packageId);
    const channel = validateChannel(args.channel);
    const fingerprint = validateSha256(
      args.presentationFingerprintSha256,
      'VPM presentation fingerprint'
    );
    const packageVersion = args.packageVersion
      ? normalizePackageVersion(args.packageVersion)
      : undefined;
    if (!PUBLICATION_ID_PATTERN.test(args.publicationId)) {
      throw new ConvexError('VPM publication ID is invalid');
    }
    const presentation = await ctx.db
      .query('package_vpm_presentations')
      .withIndex('by_package_channel', (q) => q.eq('packageId', packageId).eq('channel', channel))
      .first();
    if (!presentation || presentation.presentationFingerprintSha256 !== fingerprint) {
      throw new ConvexError('VPM presentation fingerprint is stale');
    }
    await requireOwnedPackage(ctx, {
      authUserId: presentation.creatorAuthUserId,
      packageId,
    });
    const existingCandidates = await ctx.db
      .query('vpm_alias_publications')
      .withIndex('by_package_channel_fingerprint', (q) =>
        q
          .eq('packageId', packageId)
          .eq('channel', channel)
          .eq('presentationFingerprintSha256', fingerprint)
      )
      .collect();
    const existing = packageVersion
      ? existingCandidates.find((candidate) => candidate.packageVersion === packageVersion)
      : existingCandidates[0];
    if (existing && existing.status !== 'FAILED') {
      return serializeReservation(existing, false);
    }
    if (existing) {
      const now = Date.now();
      await ctx.db.patch(existing._id, {
        status: 'PREPARING',
        failureCode: undefined,
        traceparent: args.traceparent,
        updatedAt: now,
      });
      return serializeReservation({ ...existing, status: 'PREPARING', updatedAt: now }, false);
    }
    const duplicateId = await ctx.db
      .query('vpm_alias_publications')
      .withIndex('by_publication_id', (q) => q.eq('publicationId', args.publicationId))
      .first();
    if (duplicateId) {
      throw new ConvexError('VPM publication ID is already in use');
    }
    const latest = await ctx.db
      .query('vpm_alias_publications')
      .withIndex('by_package_channel_revision', (q) =>
        q.eq('packageId', packageId).eq('channel', channel)
      )
      .order('desc')
      .first();
    const revision = (latest?.revision ?? 0) + 1;
    const now = Date.now();
    const publicationId = args.publicationId.toLowerCase();
    const bootstrapVersion = revisionToVersion(revision);
    const publication = {
      creatorAuthUserId: presentation.creatorAuthUserId,
      packageId,
      channel,
      publicationId,
      revision,
      bootstrapVersion,
      packageVersion: packageVersion ?? bootstrapVersion,
      status: 'PREPARING' as const,
      contractVersion: presentation.contractVersion,
      artifactFormat: presentation.artifactFormat,
      fingerprintSchemaVersion: 2 as const,
      presentationFingerprintSha256: fingerprint,
      fingerprintInputJson: presentation.fingerprintInputJson,
      publicationReason: args.publicationReason,
      traceparent: args.traceparent,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert('vpm_alias_publications', publication);
    return serializeReservation(publication as Doc<'vpm_alias_publications'>, true);
  },
});

export const commitPublicationForService = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    publicationId: v.string(),
    repositoryManifestJson: v.string(),
    repositoryManifestSha256: v.string(),
    artifact: ArtifactV,
  },
  returns: PublishedPublicationV,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    if (!PUBLICATION_ID_PATTERN.test(args.publicationId)) {
      throw new ConvexError('VPM publication ID is invalid');
    }
    const publication = await ctx.db
      .query('vpm_alias_publications')
      .withIndex('by_publication_id', (q) =>
        q.eq('publicationId', args.publicationId.toLowerCase())
      )
      .first();
    if (!publication) {
      throw new ConvexError('VPM alias publication was not reserved');
    }
    if (
      !Number.isSafeInteger(args.artifact.byteSize) ||
      args.artifact.byteSize <= 0 ||
      !args.artifact.objectKey.endsWith(
        `/${publication.publicationId}/${publication.bootstrapVersion}.zip`
      )
    ) {
      throw new ConvexError('VPM alias artifact reference is invalid');
    }
    const artifact = {
      bucketName: requiredText(args.artifact.bucketName, 'VPM artifact bucket', 1_024),
      byteSize: args.artifact.byteSize,
      contentType: args.artifact.contentType,
      objectKey: requiredText(args.artifact.objectKey, 'VPM artifact object key', 1_024),
      providerVersion: requiredText(
        args.artifact.providerVersion,
        'VPM artifact provider version',
        1_024
      ),
      sha256: validateSha256(args.artifact.sha256, 'VPM artifact SHA-256'),
    };
    const repositoryManifestJson = requiredText(
      args.repositoryManifestJson,
      'VPM repository manifest',
      64 * 1024
    );
    const manifestDigest = await sha256Hex(repositoryManifestJson);
    if (
      manifestDigest !==
      validateSha256(args.repositoryManifestSha256, 'VPM repository manifest SHA-256')
    ) {
      throw new ConvexError('VPM repository manifest digest does not match');
    }
    let manifest: Record<string, unknown>;
    try {
      const parsed = JSON.parse(repositoryManifestJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      manifest = parsed as Record<string, unknown>;
    } catch {
      throw new ConvexError('VPM repository manifest is invalid');
    }
    const expectedPath = `/api/vpm/alias-publications/${publication.publicationId}/${publication.bootstrapVersion}.zip`;
    if (
      typeof manifest.name !== 'string' ||
      typeof manifest.url !== 'string' ||
      manifest.version !== (publication.packageVersion ?? publication.bootstrapVersion) ||
      manifest.zipSHA256 !== artifact.sha256 ||
      !manifest.url.endsWith(expectedPath)
    ) {
      throw new ConvexError('VPM repository manifest does not match its publication');
    }
    const committedFields = {
      aliasPackageId: manifest.name,
      artifact,
      repositoryManifestJson,
      repositoryManifestSha256: manifestDigest,
    };
    if (publication.status === 'PUBLISHED') {
      const published = serializePublished(publication);
      if (
        !published ||
        publication.aliasPackageId !== committedFields.aliasPackageId ||
        publication.repositoryManifestJson !== committedFields.repositoryManifestJson ||
        publication.repositoryManifestSha256 !== committedFields.repositoryManifestSha256 ||
        canonicalJson(publication.artifact) !== canonicalJson(committedFields.artifact)
      ) {
        throw new ConvexError('Published VPM alias publication is immutable');
      }
      return published;
    }
    if (publication.status !== 'PREPARING') {
      throw new ConvexError('VPM alias publication is not ready to commit');
    }
    const now = Date.now();
    await ctx.db.patch(publication._id, {
      ...committedFields,
      failureCode: undefined,
      publishedAt: now,
      status: 'PUBLISHED',
      updatedAt: now,
    });
    const published = serializePublished({
      ...publication,
      ...committedFields,
      publishedAt: now,
      status: 'PUBLISHED',
      updatedAt: now,
    });
    if (!published) {
      throw new ConvexError('Published VPM alias publication is incomplete');
    }
    return published;
  },
});

export const markPublicationFailedForService = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    publicationId: v.string(),
    failureCode: v.string(),
  },
  returns: v.object({ failed: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    if (
      !PUBLICATION_ID_PATTERN.test(args.publicationId) ||
      !SAFE_FAILURE_CODE_PATTERN.test(args.failureCode)
    ) {
      throw new ConvexError('VPM publication failure is invalid');
    }
    const publication = await ctx.db
      .query('vpm_alias_publications')
      .withIndex('by_publication_id', (q) =>
        q.eq('publicationId', args.publicationId.toLowerCase())
      )
      .first();
    if (!publication) {
      throw new ConvexError('VPM alias publication was not reserved');
    }
    if (publication.status === 'PUBLISHED') {
      throw new ConvexError('Published VPM alias publication is immutable');
    }
    if (publication.status === 'FAILED' && publication.failureCode === args.failureCode) {
      return { failed: false };
    }
    await ctx.db.patch(publication._id, {
      failureCode: args.failureCode,
      status: 'FAILED',
      updatedAt: Date.now(),
    });
    return { failed: true };
  },
});

export const listPublishedForPackage = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    packageId: v.string(),
    channel: v.string(),
    artifactBucketName: v.string(),
  },
  returns: v.array(PublishedPublicationV),
  handler: async (ctx, args): Promise<PublishedPublication[]> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    const publications = await ctx.db
      .query('vpm_alias_publications')
      .withIndex('by_package_channel_status_revision', (q) =>
        q
          .eq('packageId', validatePackageId(args.packageId))
          .eq('channel', validateChannel(args.channel))
          .eq('status', 'PUBLISHED')
      )
      .collect();
    const artifactBucketName = requiredText(args.artifactBucketName, 'VPM artifact bucket', 1_024);
    return publications.flatMap((publication) => {
      const serialized = serializePublished(publication);
      return serialized?.artifact.bucketName === artifactBucketName ? [serialized] : [];
    });
  },
});

export const getLatestPublishedForPackage = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    packageId: v.string(),
    channel: v.string(),
    artifactBucketName: v.string(),
  },
  returns: v.union(v.null(), PublishedPublicationV),
  handler: async (ctx, args): Promise<PublishedPublication | null> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    const publications = await ctx.db
      .query('vpm_alias_publications')
      .withIndex('by_package_channel_status_revision', (q) =>
        q
          .eq('packageId', validatePackageId(args.packageId))
          .eq('channel', validateChannel(args.channel))
          .eq('status', 'PUBLISHED')
      )
      .order('desc')
      .collect();
    const artifactBucketName = requiredText(args.artifactBucketName, 'VPM artifact bucket', 1_024);
    for (const publication of publications) {
      const serialized = serializePublished(publication);
      if (serialized?.artifact.bucketName === artifactBucketName) {
        return serialized;
      }
    }
    return null;
  },
});

export const getPublishedByPublicationId = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    publicationId: v.string(),
  },
  returns: v.union(v.null(), PublishedPublicationV),
  handler: async (ctx, args): Promise<PublishedPublication | null> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    if (!PUBLICATION_ID_PATTERN.test(args.publicationId)) {
      return null;
    }
    const publication = await ctx.db
      .query('vpm_alias_publications')
      .withIndex('by_publication_id', (q) =>
        q.eq('publicationId', args.publicationId.toLowerCase())
      )
      .first();
    return publication ? serializePublished(publication) : null;
  },
});

export const listIncompleteForReconciliation = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    updatedBefore: v.number(),
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      bootstrapVersion: v.string(),
      packageId: v.string(),
      publicationId: v.string(),
      status: v.union(v.literal('PREPARING'), v.literal('FAILED')),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      throw new ConvexError('VPM reconciliation limit is invalid');
    }
    const candidates = [
      ...(await ctx.db
        .query('vpm_alias_publications')
        .withIndex('by_status_updated_at', (q) =>
          q.eq('status', 'PREPARING').lt('updatedAt', args.updatedBefore)
        )
        .take(args.limit)),
      ...(await ctx.db
        .query('vpm_alias_publications')
        .withIndex('by_status_updated_at', (q) =>
          q.eq('status', 'FAILED').lt('updatedAt', args.updatedBefore)
        )
        .take(args.limit)),
    ];
    return candidates
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, args.limit)
      .map((publication) => ({
        bootstrapVersion: publication.bootstrapVersion,
        packageId: publication.packageId,
        publicationId: publication.publicationId,
        status: publication.status as 'PREPARING' | 'FAILED',
        updatedAt: publication.updatedAt,
      }));
  },
});

export const _testing = {
  revisionToVersion,
};
