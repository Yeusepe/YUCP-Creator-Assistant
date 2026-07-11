import {
  resolveSharedYucpAliasIdFromCatalogProducts,
} from '@yucp/shared';
import type {
  CdngineBackstageDeliveryReference,
  CdngineBackstageSourceReference,
} from '@yucp/shared/cdngineBackstageDelivery';
import type { LoreBackstageArtifactReference } from '@yucp/shared/loreBackstageDelivery';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { ApiActorBindingV, requireDelegatedAuthUserActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';

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

const CdngineBackstageSourceReferenceV = v.object({
  assetId: v.string(),
  assetOwner: v.string(),
  byteSize: v.number(),
  serviceNamespaceId: v.string(),
  sha256: v.string(),
  tenantId: v.optional(v.string()),
  uploadedAt: v.number(),
  versionId: v.string(),
});

const CdngineBackstageDeliveryReferenceV = v.object({
  assetId: v.string(),
  assetOwner: v.string(),
  byteSize: v.number(),
  deliveryScopeId: v.string(),
  serviceNamespaceId: v.string(),
  sha256: v.string(),
  tenantId: v.optional(v.string()),
  uploadedAt: v.number(),
  variant: v.string(),
  versionId: v.string(),
});

const LoreBackstageArtifactReferenceV = v.object({
  repositoryId: v.string(),
  address: v.string(),
  sha256: v.string(),
  byteSize: v.number(),
  uploadedAt: v.string(),
  tenantId: v.optional(v.string()),
});

type BackstageRepoAccessRecord = {
  tokenId: Id<'delivery_repo_tokens'>;
  authUserId: string;
  subjectId: Id<'subjects'>;
  status: 'active' | 'revoked' | 'expired';
  expiresAt?: number;
};

type BackstagePackageDownloadRecord = {
  deliveryArtifactId?: Id<'delivery_release_artifacts'>;
  deliveryArtifactMode?: 'legacy_signed' | 'server_materialized';
  artifactId?: Id<'signed_release_artifacts'>;
  artifactKey?: string;
  downloadUrl: string;
  contentType: string;
  deliveryName: string;
  zipSha256?: string;
  version: string;
  channel: string;
  cdngineDelivery?: CdngineBackstageDeliveryReference;
  loreDelivery?: LoreBackstageArtifactReference;
};

type BackstageRawPackageDownloadRecord = {
  deliveryArtifactId: Id<'delivery_release_artifacts'>;
  downloadUrl: string;
  contentType: string;
  deliveryName: string;
  packageSha256: string;
  sourceKind: 'zip' | 'unitypackage';
  version: string;
  channel: string;
  cdngineSource?: CdngineBackstageSourceReference;
  loreSource?: LoreBackstageArtifactReference;
};

type BackstagePublishedReleaseRecord = {
  deliveryPackageReleaseId: Id<'delivery_package_releases'>;
  zipSha256: string;
  version: string;
  channel: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unauthorized(message: string): never {
  throw new ConvexError(`Unauthorized: ${message}`);
}

async function requireActiveSubjectOwner(
  ctx: QueryCtx | MutationCtx,
  args: {
    authUserId: string;
    subjectId: Id<'subjects'>;
  }
): Promise<void> {
  const subject = await ctx.db.get(args.subjectId);
  if (!subject || subject.status !== 'active' || subject.authUserId !== args.authUserId) {
    unauthorized('subject does not belong to auth user');
  }
}

async function requireBackstageRepoTokenBinding(
  ctx: QueryCtx,
  args: {
    tokenHash: string;
    authUserId: string;
    subjectId: Id<'subjects'>;
  }
): Promise<BackstageRepoAccessRecord> {
  const access = await ctx.runQuery(internal.packageRegistry.getBackstageRepoAccessByToken, {
    tokenHash: args.tokenHash,
  });
  if (!access) {
    unauthorized('repo token is inactive or expired');
  }
  if (access.status !== 'active') {
    unauthorized('repo token is inactive or expired');
  }
  if (typeof access.expiresAt === 'number' && access.expiresAt <= Date.now()) {
    unauthorized('repo token is inactive or expired');
  }
  if (access.authUserId !== args.authUserId || String(access.subjectId) !== String(args.subjectId)) {
    unauthorized('repo token does not authorize this subject');
  }

  const subject = await ctx.db.get(args.subjectId);
  if (!subject || subject.status !== 'active') {
    unauthorized('subject is inactive');
  }

  return access;
}

function normalizeBackstageMetadataInput(input: {
  metadata?: unknown;
  dependencyVersions?: Array<{ packageId: string; version: string }>;
}): Record<string, unknown> | undefined {
  if (input.metadata != null && !isPlainRecord(input.metadata)) {
    throw new Error('metadata must be an object when provided.');
  }
  const baseMetadata: Record<string, unknown> = input.metadata ? { ...input.metadata } : {};
  if (!input.dependencyVersions?.length) {
    return Object.keys(baseMetadata).length > 0 ? baseMetadata : undefined;
  }

  const mergedDependencies = {
    ...(isPlainRecord(baseMetadata.vpmDependencies) ? baseMetadata.vpmDependencies : {}),
    ...(isPlainRecord(baseMetadata.dependencies) ? baseMetadata.dependencies : {}),
    ...Object.fromEntries(
      input.dependencyVersions.map((dependency) => [dependency.packageId, dependency.version])
    ),
  };

  const { dependencies: _legacyDependencies, ...metadataWithoutLegacyDependencies } = baseMetadata;
  return {
    ...metadataWithoutLegacyDependencies,
    vpmDependencies: mergedDependencies,
  };
}

export const resolveAliasContractMetadataForAccessSelectors = internalQuery({
  args: {
    authUserId: v.string(),
    accessSelectors: v.array(BackstageAccessSelectorV),
  },
  returns: v.object({
    aliasId: v.string(),
    catalogProductIds: v.array(v.string()),
  }),
  handler: async (ctx, args): Promise<{ aliasId: string; catalogProductIds: string[] }> => {
    const products = new Map<
      string,
      {
        _id: Id<'product_catalog'>;
        aliases?: string[];
        canonicalSlug?: string;
        displayName?: string;
        providerProductRef?: string;
      }
    >();
    for (const selector of args.accessSelectors) {
      if (selector.kind === 'catalogProduct') {
        const product = await ctx.db.get(selector.catalogProductId);
        if (!product || product.authUserId !== args.authUserId) {
          throw new Error(`Catalog product not found: ${String(selector.catalogProductId)}`);
        }
        products.set(String(product._id), {
          _id: product._id,
          aliases: product.aliases,
          canonicalSlug: product.canonicalSlug,
          displayName: product.displayName,
          providerProductRef: product.providerProductRef,
        });
        continue;
      }

      const tier = await ctx.db.get(selector.catalogTierId);
      if (!tier || tier.authUserId !== args.authUserId || !tier.catalogProductId) {
        throw new Error(`Catalog tier not found: ${String(selector.catalogTierId)}`);
      }
      const product = await ctx.db.get(tier.catalogProductId);
      if (!product || product.authUserId !== args.authUserId) {
        throw new Error(`Catalog product not found for tier: ${String(selector.catalogTierId)}`);
      }
      products.set(String(product._id), {
        _id: product._id,
        aliases: product.aliases,
        canonicalSlug: product.canonicalSlug,
        displayName: product.displayName,
        providerProductRef: product.providerProductRef,
      });
    }

    const uniqueProducts = Array.from(products.values());
    if (uniqueProducts.length === 0) {
      throw new Error('At least one catalog product is required to build alias metadata.');
    }
    const aliasId = resolveSharedYucpAliasIdFromCatalogProducts(uniqueProducts);
    if (!aliasId) {
      throw new Error(
        'Cannot synthesize alias metadata across multiple catalog products with different alias ids.'
      );
    }

    return {
      aliasId,
      catalogProductIds: uniqueProducts.map((product) => String(product._id)),
    };
  },
});

export const resolveAliasContractMetadataForApi = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    accessSelectors: v.array(BackstageAccessSelectorV),
  },
  returns: v.object({
    aliasId: v.string(),
    catalogProductIds: v.array(v.string()),
  }),
  handler: async (ctx, args): Promise<{ aliasId: string; catalogProductIds: string[] }> => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    return await ctx.runQuery(
      internal.backstageRepos.resolveAliasContractMetadataForAccessSelectors,
      {
        authUserId: args.authUserId,
        accessSelectors: args.accessSelectors,
      }
    );
  },
});

export const getSubjectByAuthUserForApi = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
  },
  returns: v.union(v.null(), v.object({ _id: v.id('subjects') })),
  handler: async (ctx, args): Promise<{ _id: Id<'subjects'> } | null> => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    return await ctx.runQuery(internal.yucpLicenses.getSubjectByAuthUser, {
      authUserId: args.authUserId,
    });
  },
});

export const issueRepoTokenForApi = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    subjectAuthUserId: v.optional(v.string()),
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
    const subjectOwnerAuthUserId = args.subjectAuthUserId ?? args.authUserId;
    await requireDelegatedAuthUserActor(args.actor, subjectOwnerAuthUserId);
    await requireActiveSubjectOwner(ctx, {
      authUserId: subjectOwnerAuthUserId,
      subjectId: args.subjectId,
    });
    return await ctx.runMutation(internal.packageRegistry.issueBackstageRepoToken, {
      authUserId: args.authUserId,
      subjectAuthUserId: args.subjectAuthUserId,
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
    tokenHash: v.string(),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    packageId: v.string(),
    version: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      deliveryArtifactId: v.optional(v.id('delivery_release_artifacts')),
      deliveryArtifactMode: v.optional(
        v.union(v.literal('legacy_signed'), v.literal('server_materialized'))
      ),
      artifactId: v.optional(v.id('signed_release_artifacts')),
      artifactKey: v.optional(v.string()),
      downloadUrl: v.string(),
      contentType: v.string(),
      deliveryName: v.string(),
      zipSha256: v.optional(v.string()),
      version: v.string(),
      channel: v.string(),
      cdngineDelivery: v.optional(CdngineBackstageDeliveryReferenceV),
      loreDelivery: v.optional(LoreBackstageArtifactReferenceV),
    })
  ),
  handler: async (ctx, args): Promise<BackstagePackageDownloadRecord | null> => {
    requireApiSecret(args.apiSecret);
    await requireBackstageRepoTokenBinding(ctx, {
      tokenHash: args.tokenHash,
      authUserId: args.authUserId,
      subjectId: args.subjectId,
    });
    return await ctx.runQuery(
      internal.packageRegistry.getResolvedEntitledPackageDownloadForSubject,
      {
        authUserId: args.authUserId,
        subjectId: args.subjectId,
        packageId: args.packageId,
        version: args.version,
        channel: args.channel,
      }
    );
  },
});

export const resolveRawPackageDownloadForApi = query({
  args: {
    apiSecret: v.string(),
    actor: v.optional(ApiActorBindingV),
    tokenHash: v.optional(v.string()),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    packageId: v.string(),
    version: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      deliveryArtifactId: v.id('delivery_release_artifacts'),
      downloadUrl: v.string(),
      contentType: v.string(),
      deliveryName: v.string(),
      packageSha256: v.string(),
      sourceKind: v.union(v.literal('zip'), v.literal('unitypackage')),
      version: v.string(),
      channel: v.string(),
      cdngineSource: v.optional(CdngineBackstageSourceReferenceV),
      loreSource: v.optional(LoreBackstageArtifactReferenceV),
    })
  ),
  handler: async (ctx, args): Promise<BackstageRawPackageDownloadRecord | null> => {
    requireApiSecret(args.apiSecret);
    if (args.tokenHash) {
      await requireBackstageRepoTokenBinding(ctx, {
        tokenHash: args.tokenHash,
        authUserId: args.authUserId,
        subjectId: args.subjectId,
      });
    } else if (args.actor) {
      await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    } else {
      unauthorized('missing repo token or actor binding');
    }
    return await ctx.runQuery(
      internal.packageRegistry.getResolvedEntitledRawPackageDownloadForSubject,
      {
        authUserId: args.authUserId,
        subjectId: args.subjectId,
        packageId: args.packageId,
        version: args.version,
        channel: args.channel,
      }
    );
  },
});

export const publishCdngineReleaseForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductId: v.optional(v.id('product_catalog')),
    catalogProductIds: v.optional(v.array(v.id('product_catalog'))),
    accessSelectors: v.optional(v.array(BackstageAccessSelectorV)),
    packageId: v.string(),
    version: v.string(),
    channel: v.optional(v.string()),
    packageName: v.optional(v.string()),
    displayName: v.optional(v.string()),
    description: v.optional(v.string()),
    repositoryVisibility: v.optional(v.union(v.literal('hidden'), v.literal('listed'))),
    defaultChannel: v.optional(v.string()),
    unityVersion: v.optional(v.string()),
    metadata: v.optional(v.any()),
    rawDeliveryName: v.optional(v.string()),
    rawContentType: v.optional(v.string()),
    rawSha256: v.string(),
    rawByteSize: v.number(),
    cdngineSource: CdngineBackstageSourceReferenceV,
    deliverableDeliveryName: v.string(),
    deliverableContentType: v.string(),
    deliverableSha256: v.string(),
    deliverableByteSize: v.number(),
    cdngineDelivery: CdngineBackstageDeliveryReferenceV,
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
    zipSha256: v.string(),
    version: v.string(),
    channel: v.string(),
  }),
  handler: async (ctx, args): Promise<BackstagePublishedReleaseRecord> => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const channel = (args.channel || '').trim() || 'stable';
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

    const release = (await ctx.runMutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: args.authUserId,
      packageId: args.packageId,
      version: args.version,
      channel,
      releaseStatus: args.releaseStatus,
      repositoryVisibility: args.repositoryVisibility,
      unityVersion: args.unityVersion,
      zipSha256: args.deliverableSha256,
      metadata: args.metadata,
    })) as { deliveryPackageReleaseId: Id<'delivery_package_releases'> };

    const rawArtifactId: Id<'delivery_release_artifacts'> = await ctx.runMutation(
      internal.releaseArtifacts.publishDeliveryArtifact,
      {
        deliveryPackageReleaseId: release.deliveryPackageReleaseId,
        artifactRole: 'raw_upload',
        ownership: 'creator_upload',
        contentType: args.rawContentType ?? 'application/octet-stream',
        deliveryName: args.rawDeliveryName ?? `${args.packageId}-${args.version}.zip`,
        sha256: args.rawSha256,
        byteSize: args.rawByteSize,
        cdngineSource: args.cdngineSource,
      }
    );

    await ctx.runMutation(internal.releaseArtifacts.publishDeliveryArtifact, {
      deliveryPackageReleaseId: release.deliveryPackageReleaseId,
      artifactRole: 'server_deliverable',
      ownership: 'server_materialized',
      materializationStrategy: 'normalized_repack',
      sourceArtifactId: rawArtifactId,
      contentType: args.deliverableContentType,
      deliveryName: args.deliverableDeliveryName,
      sha256: args.deliverableSha256,
      byteSize: args.deliverableByteSize,
      cdngineDelivery: args.cdngineDelivery,
    });

    return {
      deliveryPackageReleaseId: release.deliveryPackageReleaseId,
      zipSha256: args.deliverableSha256,
      version: args.version,
      channel,
    };
  },
});

export const publishLoreReleaseForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductId: v.optional(v.id('product_catalog')),
    catalogProductIds: v.optional(v.array(v.id('product_catalog'))),
    accessSelectors: v.optional(v.array(BackstageAccessSelectorV)),
    packageId: v.string(),
    version: v.string(),
    channel: v.optional(v.string()),
    packageName: v.optional(v.string()),
    displayName: v.optional(v.string()),
    description: v.optional(v.string()),
    repositoryVisibility: v.optional(v.union(v.literal('hidden'), v.literal('listed'))),
    defaultChannel: v.optional(v.string()),
    unityVersion: v.optional(v.string()),
    metadata: v.optional(v.any()),
    rawDeliveryName: v.optional(v.string()),
    rawContentType: v.optional(v.string()),
    rawSha256: v.string(),
    rawByteSize: v.number(),
    loreSource: LoreBackstageArtifactReferenceV,
    deliverableDeliveryName: v.string(),
    deliverableContentType: v.string(),
    deliverableSha256: v.string(),
    deliverableByteSize: v.number(),
    loreDelivery: LoreBackstageArtifactReferenceV,
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
    zipSha256: v.string(),
    version: v.string(),
    channel: v.string(),
  }),
  handler: async (ctx, args): Promise<BackstagePublishedReleaseRecord> => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const channel = (args.channel || '').trim() || 'stable';
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

    const release = (await ctx.runMutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: args.authUserId,
      packageId: args.packageId,
      version: args.version,
      channel,
      releaseStatus: args.releaseStatus,
      repositoryVisibility: args.repositoryVisibility,
      unityVersion: args.unityVersion,
      zipSha256: args.deliverableSha256,
      metadata: args.metadata,
    })) as { deliveryPackageReleaseId: Id<'delivery_package_releases'> };

    const rawArtifactId: Id<'delivery_release_artifacts'> = await ctx.runMutation(
      internal.releaseArtifacts.publishDeliveryArtifact,
      {
        deliveryPackageReleaseId: release.deliveryPackageReleaseId,
        artifactRole: 'raw_upload',
        ownership: 'creator_upload',
        contentType: args.rawContentType ?? 'application/octet-stream',
        deliveryName: args.rawDeliveryName ?? `${args.packageId}-${args.version}.zip`,
        sha256: args.rawSha256,
        byteSize: args.rawByteSize,
        loreSource: args.loreSource,
      }
    );

    await ctx.runMutation(internal.releaseArtifacts.publishDeliveryArtifact, {
      deliveryPackageReleaseId: release.deliveryPackageReleaseId,
      artifactRole: 'server_deliverable',
      ownership: 'server_materialized',
      materializationStrategy: 'normalized_repack',
      sourceArtifactId: rawArtifactId,
      contentType: args.deliverableContentType,
      deliveryName: args.deliverableDeliveryName,
      sha256: args.deliverableSha256,
      byteSize: args.deliverableByteSize,
      loreDelivery: args.loreDelivery,
    });

    return {
      deliveryPackageReleaseId: release.deliveryPackageReleaseId,
      zipSha256: args.deliverableSha256,
      version: args.version,
      channel,
    };
  },
});
