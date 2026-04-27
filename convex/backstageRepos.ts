import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { action, mutation, query } from './_generated/server';
import { ApiActorBindingV, requireDelegatedAuthUserActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';

const BACKSTAGE_ARTIFACT_KEY_PREFIX = 'backstage-package:';
const BACKSTAGE_PACKAGE_PLATFORM = 'unity-vpm';
const BACKSTAGE_PACKAGE_CONTENT_TYPE = 'application/zip';
const BACKSTAGE_PACKAGE_ENVELOPE_CIPHER = 'none';
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const BackstageAccessSelectorV = v.union(
  v.object({
    kind: v.literal('catalogProduct'),
    catalogProductId: v.id('product_catalog'),
  }),
  v.object({
    kind: v.literal('catalogTier'),
    catalogTierId: v.id('catalog_tiers'),
  })
);

type BackstageRepoAccessRecord = {
  tokenId: Id<'delivery_repo_tokens'>;
  authUserId: string;
  subjectId: Id<'subjects'>;
  status: 'active' | 'revoked' | 'expired';
  expiresAt?: number;
};

type BackstagePackageDownloadRecord = {
  artifactId?: Id<'signed_release_artifacts'>;
  artifactKey: string;
  downloadUrl: string;
  contentType: string;
  deliveryName: string;
  zipSha256?: string;
  version: string;
  channel: string;
};

type BackstagePublishedReleaseRecord = {
  deliveryPackageReleaseId: Id<'delivery_package_releases'>;
  artifactId: Id<'signed_release_artifacts'>;
  artifactKey: string;
  zipSha256: string;
  version: string;
  channel: string;
};

function buildBackstageArtifactKey(packageId: string): string {
  return `${BACKSTAGE_ARTIFACT_KEY_PREFIX}${packageId}`;
}

function defaultBackstageDeliveryName(packageId: string, version: string): string {
  const packageToken = packageId.split('.').at(-1)?.trim() || 'package';
  return `${packageToken}-${version}.zip`;
}

function inferBackstageContentType(deliveryName: string, uploadedContentType?: string): string {
  const explicitType = uploadedContentType?.trim();
  if (explicitType) {
    return explicitType;
  }
  if (deliveryName.toLowerCase().endsWith('.unitypackage')) {
    return 'application/octet-stream';
  }
  return BACKSTAGE_PACKAGE_CONTENT_TYPE;
}

export const getSubjectByAuthUserForApi = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.union(v.null(), v.object({ _id: v.id('subjects') })),
  handler: async (ctx, args): Promise<{ _id: Id<'subjects'> } | null> => {
    requireApiSecret(args.apiSecret);
    return await ctx.runQuery(internal.yucpLicenses.getSubjectByAuthUser, {
      authUserId: args.authUserId,
    });
  },
});

export const issueRepoTokenForApi = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    label: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  returns: v.object({
    token: v.string(),
    tokenId: v.id('delivery_repo_tokens'),
    expiresAt: v.optional(v.number()),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ token: string; tokenId: Id<'delivery_repo_tokens'>; expiresAt?: number }> => {
    requireApiSecret(args.apiSecret);
    return await ctx.runMutation(internal.packageRegistry.issueBackstageRepoToken, {
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      label: args.label,
      expiresAt: args.expiresAt,
    });
  },
});

export const getRepoAccessByTokenForApi = query({
  args: {
    apiSecret: v.string(),
    tokenHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      tokenId: v.id('delivery_repo_tokens'),
      authUserId: v.string(),
      subjectId: v.id('subjects'),
      status: v.union(v.literal('active'), v.literal('revoked'), v.literal('expired')),
      expiresAt: v.optional(v.number()),
    })
  ),
  handler: async (ctx, args): Promise<BackstageRepoAccessRecord | null> => {
    requireApiSecret(args.apiSecret);
    return await ctx.runQuery(internal.packageRegistry.getBackstageRepoAccessByToken, {
      tokenHash: args.tokenHash,
    });
  },
});

export const touchRepoTokenForApi = mutation({
  args: {
    apiSecret: v.string(),
    tokenId: v.id('delivery_repo_tokens'),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    requireApiSecret(args.apiSecret);
    return await ctx.runMutation(internal.packageRegistry.touchBackstageRepoToken, {
      tokenId: args.tokenId,
    });
  },
});

export const buildRepositoryForApi = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    repositoryUrl: v.string(),
    packageBaseUrl: v.string(),
    packageHeaders: v.optional(v.record(v.string(), v.string())),
    repositoryName: v.optional(v.string()),
    repositoryId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    requireApiSecret(args.apiSecret);
    return await ctx.runQuery(internal.packageRegistry.buildBackstageRepositoryForSubject, {
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      repositoryUrl: args.repositoryUrl,
      packageBaseUrl: args.packageBaseUrl,
      packageHeaders: args.packageHeaders,
      repositoryName: args.repositoryName,
      repositoryId: args.repositoryId,
    });
  },
});

export const resolvePackageDownloadForApi = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    packageId: v.string(),
    version: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      artifactId: v.optional(v.id('signed_release_artifacts')),
      artifactKey: v.string(),
      downloadUrl: v.string(),
      contentType: v.string(),
      deliveryName: v.string(),
      zipSha256: v.optional(v.string()),
      version: v.string(),
      channel: v.string(),
    })
  ),
  handler: async (ctx, args): Promise<BackstagePackageDownloadRecord | null> => {
    requireApiSecret(args.apiSecret);
    const release = (await ctx.runQuery(
      internal.packageRegistry.getEntitledPackageReleaseForSubject,
      {
        authUserId: args.authUserId,
        subjectId: args.subjectId,
        packageId: args.packageId,
        version: args.version,
        channel: args.channel,
      }
    )) as {
      artifactKey?: string;
      signedArtifactId?: Id<'signed_release_artifacts'>;
      zipSha256?: string;
      version: string;
      channel: string;
    } | null;
    if (!release) {
      return null;
    }

    const artifact = (
      release.signedArtifactId
        ? await ctx.runQuery(internal.releaseArtifacts.getArtifactById, {
            artifactId: release.signedArtifactId,
          })
        : release.artifactKey
          ? await ctx.runQuery(internal.releaseArtifacts.getLatestActiveArtifactByKey, {
              artifactKey: release.artifactKey,
            })
          : null
    ) as {
      artifactKey: string;
      storageId: Id<'_storage'>;
      contentType: string;
      deliveryName: string;
    } | null;
    if (!artifact) {
      return null;
    }
    const downloadUrl = await ctx.storage.getUrl(artifact.storageId);
    if (!downloadUrl) {
      return null;
    }

    return {
      artifactId: release.signedArtifactId,
      artifactKey: artifact.artifactKey,
      downloadUrl,
      contentType: artifact.contentType,
      deliveryName: artifact.deliveryName,
      zipSha256: release.zipSha256,
      version: release.version,
      channel: release.channel,
    };
  },
});

export const generateReleaseUploadUrlForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    return await ctx.storage.generateUploadUrl();
  },
});

export const publishUploadedReleaseForAuthUser = action({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductId: v.optional(v.id('product_catalog')),
    catalogProductIds: v.optional(v.array(v.id('product_catalog'))),
    accessSelectors: v.optional(v.array(BackstageAccessSelectorV)),
    packageId: v.string(),
    storageId: v.id('_storage'),
    version: v.string(),
    zipSha256: v.string(),
    channel: v.optional(v.string()),
    packageName: v.optional(v.string()),
    displayName: v.optional(v.string()),
    description: v.optional(v.string()),
    repositoryVisibility: v.optional(v.union(v.literal('hidden'), v.literal('listed'))),
    defaultChannel: v.optional(v.string()),
    unityVersion: v.optional(v.string()),
    metadata: v.optional(v.any()),
    deliveryName: v.optional(v.string()),
    contentType: v.optional(v.string()),
    releaseStatus: v.optional(
      v.union(
        v.literal('draft'),
        v.literal('published'),
        v.literal('revoked'),
        v.literal('superseded')
      )
    ),
  },
  returns: v.object({
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    artifactId: v.id('signed_release_artifacts'),
    artifactKey: v.string(),
    zipSha256: v.string(),
    version: v.string(),
    channel: v.string(),
  }),
  handler: async (ctx, args): Promise<BackstagePublishedReleaseRecord> => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const uploaded = await ctx.storage.get(args.storageId);
    if (!uploaded) {
      throw new Error(`Uploaded Backstage package not found: ${args.storageId}`);
    }

    const zipSha256 = args.zipSha256.trim().toLowerCase();
    if (!SHA256_HEX_RE.test(zipSha256)) {
      throw new Error('zipSha256 must be a lowercase 64-character SHA-256 hex digest.');
    }
    const channel = (args.channel || '').trim() || 'stable';
    const artifactKey = buildBackstageArtifactKey(args.packageId);
    const accessSelectors = Array.from(
      new Map(
        (
          args.accessSelectors ??
          (args.catalogProductIds ?? (args.catalogProductId ? [args.catalogProductId] : [])).map(
            (catalogProductId) =>
              ({
                kind: 'catalogProduct' as const,
                catalogProductId,
              }) satisfies { kind: 'catalogProduct'; catalogProductId: Id<'product_catalog'> }
          )
        ).map((selector) => [
          selector.kind === 'catalogTier'
            ? `tier:${String(selector.catalogTierId)}`
            : `product:${String(selector.catalogProductId)}`,
          selector,
        ])
      ).values()
    );
    if (accessSelectors.length === 0) {
      throw new Error(
        'At least one package access selector is required to publish a Backstage release.'
      );
    }
    const deliveryName =
      (args.deliveryName || '').trim() ||
      defaultBackstageDeliveryName(args.packageId, args.version);
    const contentType = inferBackstageContentType(
      deliveryName,
      (args.contentType || '').trim() || uploaded.type
    );

    await ctx.runMutation(internal.packageRegistry.upsertDeliveryPackageForAccessSelectors, {
      authUserId: args.authUserId,
      accessSelectors,
      packageId: args.packageId,
      packageName: args.packageName,
      displayName: args.displayName,
      description: args.description,
      repositoryVisibility: args.repositoryVisibility,
      defaultChannel: args.defaultChannel ?? channel,
    });

    const artifactId = (await ctx.runMutation(internal.releaseArtifacts.publishArtifact, {
      artifactKey,
      channel,
      platform: BACKSTAGE_PACKAGE_PLATFORM,
      version: args.version,
      metadataVersion: 1,
      storageId: args.storageId,
      contentType,
      deliveryName,
      envelopeCipher: BACKSTAGE_PACKAGE_ENVELOPE_CIPHER,
      envelopeIvBase64: '',
      ciphertextSha256: zipSha256,
      ciphertextSize: uploaded.size,
      plaintextSha256: zipSha256,
      plaintextSize: uploaded.size,
    })) as Id<'signed_release_artifacts'>;

    await ctx.runMutation(internal.releaseArtifacts.recordArtifactPublishedAudit, {
      artifactKey,
      channel,
      platform: BACKSTAGE_PACKAGE_PLATFORM,
      version: args.version,
      plaintextSha256: zipSha256,
      ciphertextSha256: zipSha256,
    });

    const release = (await ctx.runMutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: args.authUserId,
      packageId: args.packageId,
      version: args.version,
      channel,
      releaseStatus: args.releaseStatus,
      repositoryVisibility: args.repositoryVisibility,
      signedArtifactId: artifactId,
      artifactKey,
      unityVersion: args.unityVersion,
      zipSha256,
      metadata: args.metadata,
    })) as { deliveryPackageReleaseId: Id<'delivery_package_releases'> };

    return {
      deliveryPackageReleaseId: release.deliveryPackageReleaseId,
      artifactId,
      artifactKey,
      zipSha256,
      version: args.version,
      channel,
    };
  },
});
