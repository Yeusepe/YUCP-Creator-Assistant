import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery } from './_generated/server';
import { RELEASE_ARTIFACT_KEYS } from './lib/releaseArtifactKeys';

const signedReleaseArtifactValidator = v.object({
  artifactKey: v.string(),
  channel: v.string(),
  platform: v.string(),
  version: v.string(),
  metadataVersion: v.number(),
  storageId: v.id('_storage'),
  contentType: v.string(),
  deliveryName: v.string(),
  envelopeCipher: v.string(),
  envelopeIvBase64: v.string(),
  ciphertextSha256: v.string(),
  ciphertextSize: v.number(),
  plaintextSha256: v.string(),
  plaintextSize: v.number(),
  codeSigningSubject: v.optional(v.string()),
  codeSigningThumbprint: v.optional(v.string()),
  status: v.union(v.literal('active'), v.literal('inactive'), v.literal('revoked')),
  activatedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const deliveryArtifactModeValidator = v.union(
  v.literal('legacy_signed'),
  v.literal('server_materialized')
);
const deliveryMaterializationStrategyValidator = v.union(
  v.literal('passthrough'),
  v.literal('normalized_repack')
);
const cdngineDeliveryReferenceValidator = v.object({
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
const cdngineSourceReferenceValidator = v.object({
  assetId: v.string(),
  assetOwner: v.string(),
  byteSize: v.number(),
  serviceNamespaceId: v.string(),
  sha256: v.string(),
  tenantId: v.optional(v.string()),
  uploadedAt: v.number(),
  versionId: v.string(),
});

const deliveryReleaseArtifactValidator = v.object({
  deliveryPackageReleaseId: v.id('delivery_package_releases'),
  artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
  ownership: v.union(v.literal('creator_upload'), v.literal('server_materialized')),
  materializationStrategy: v.optional(deliveryMaterializationStrategyValidator),
  sourceArtifactId: v.optional(v.id('delivery_release_artifacts')),
  storageId: v.optional(v.id('_storage')),
  contentType: v.string(),
  deliveryName: v.string(),
  sha256: v.string(),
  byteSize: v.number(),
  cdngineDelivery: v.optional(cdngineDeliveryReferenceValidator),
  cdngineSource: v.optional(cdngineSourceReferenceValidator),
  status: v.union(v.literal('active'), v.literal('inactive')),
  activatedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function toSignedReleaseArtifact(row: Doc<'signed_release_artifacts'> | null) {
  if (!row) {
    return null;
  }

  const { _id: _artifactId, _creationTime: _docCreationTime, ...artifact } = row;
  return artifact;
}

function toDeliveryReleaseArtifact(row: Doc<'delivery_release_artifacts'> | null) {
  if (!row) {
    return null;
  }

  const { _id: _artifactId, _creationTime: _docCreationTime, ...artifact } = row;
  return artifact;
}

export const getActiveArtifact = internalQuery({
  args: {
    artifactKey: v.string(),
    channel: v.string(),
    platform: v.string(),
  },
  returns: v.union(signedReleaseArtifactValidator, v.null()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('signed_release_artifacts')
      .withIndex('by_artifact_key_status', (q) =>
        q.eq('artifactKey', args.artifactKey).eq('status', 'active')
      )
      .collect();

    const active = rows
      .filter((row) => row.channel === args.channel && row.platform === args.platform)
      .sort(
        (left, right) =>
          (right.activatedAt ?? right.createdAt) - (left.activatedAt ?? left.createdAt)
      )[0];

    return toSignedReleaseArtifact(active);
  },
});

/**
 * Resolves the active coupling-runtime artifact for the non-brokered importer download path,
 * including a fresh storage download URL and the envelope parameters needed to decrypt the
 * ciphertext into the runnable plaintext DLL. Returns null when none is active.
 */
export const getActiveCouplingRuntimeForDownload = internalQuery({
  args: {
    channel: v.string(),
    platform: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      version: v.string(),
      plaintextSha256: v.string(),
      ciphertextSha256: v.string(),
      envelopeCipher: v.string(),
      envelopeIvBase64: v.string(),
      artifactKey: v.string(),
      channel: v.string(),
      platform: v.string(),
      contentType: v.string(),
      deliveryName: v.string(),
      downloadUrl: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('signed_release_artifacts')
      .withIndex('by_artifact_key_status', (q) =>
        q.eq('artifactKey', RELEASE_ARTIFACT_KEYS.couplingRuntime).eq('status', 'active')
      )
      .collect();
    const active = rows
      .filter((row) => row.channel === args.channel && row.platform === args.platform)
      .sort(
        (left, right) =>
          (right.activatedAt ?? right.createdAt) - (left.activatedAt ?? left.createdAt)
      )[0];
    if (!active) {
      return null;
    }
    const downloadUrl = await ctx.storage.getUrl(active.storageId);
    if (!downloadUrl) {
      return null;
    }
    return {
      version: active.version,
      plaintextSha256: active.plaintextSha256,
      ciphertextSha256: active.ciphertextSha256,
      envelopeCipher: active.envelopeCipher,
      envelopeIvBase64: active.envelopeIvBase64,
      artifactKey: active.artifactKey,
      channel: active.channel,
      platform: active.platform,
      contentType: active.contentType,
      deliveryName: active.deliveryName,
      downloadUrl,
    };
  },
});

export const getArtifactById = internalQuery({
  args: {
    artifactId: v.id('signed_release_artifacts'),
  },
  returns: v.union(signedReleaseArtifactValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.artifactId);
    return toSignedReleaseArtifact(row);
  },
});

export const getArtifactDownloadById = internalQuery({
  args: {
    artifactId: v.id('signed_release_artifacts'),
  },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.optional(v.id('_storage')),
      downloadUrl: v.string(),
      contentType: v.string(),
      deliveryName: v.string(),
      plaintextSha256: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.artifactId);
    if (!row) {
      return null;
    }
    const downloadUrl = await ctx.storage.getUrl(row.storageId);
    if (!downloadUrl) {
      return null;
    }
    return {
      storageId: row.storageId,
      downloadUrl,
      contentType: row.contentType,
      deliveryName: row.deliveryName,
      plaintextSha256: row.plaintextSha256,
    };
  },
});

export const getLatestActiveArtifactByKey = internalQuery({
  args: {
    artifactKey: v.string(),
  },
  returns: v.union(signedReleaseArtifactValidator, v.null()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('signed_release_artifacts')
      .withIndex('by_artifact_key_status', (q) =>
        q.eq('artifactKey', args.artifactKey).eq('status', 'active')
      )
      .collect();
    const latest = rows.sort(
      (left, right) => (right.activatedAt ?? right.createdAt) - (left.activatedAt ?? left.createdAt)
    )[0];
    return toSignedReleaseArtifact(latest ?? null);
  },
});

export const getLatestActiveArtifactDownloadByKey = internalQuery({
  args: {
    artifactKey: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.optional(v.id('_storage')),
      downloadUrl: v.string(),
      contentType: v.string(),
      deliveryName: v.string(),
      plaintextSha256: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('signed_release_artifacts')
      .withIndex('by_artifact_key_status', (q) =>
        q.eq('artifactKey', args.artifactKey).eq('status', 'active')
      )
      .collect();
    const latest = rows.sort(
      (left, right) => (right.activatedAt ?? right.createdAt) - (left.activatedAt ?? left.createdAt)
    )[0];
    if (!latest) {
      return null;
    }
    const downloadUrl = await ctx.storage.getUrl(latest.storageId);
    if (!downloadUrl) {
      return null;
    }
    return {
      storageId: latest.storageId,
      downloadUrl,
      contentType: latest.contentType,
      deliveryName: latest.deliveryName,
      plaintextSha256: latest.plaintextSha256,
    };
  },
});

export const publishArtifact = internalMutation({
  args: {
    artifactKey: v.string(),
    channel: v.string(),
    platform: v.string(),
    version: v.string(),
    metadataVersion: v.number(),
    storageId: v.id('_storage'),
    contentType: v.string(),
    deliveryName: v.string(),
    envelopeCipher: v.string(),
    envelopeIvBase64: v.string(),
    ciphertextSha256: v.string(),
    ciphertextSize: v.number(),
    plaintextSha256: v.string(),
    plaintextSize: v.number(),
    codeSigningSubject: v.optional(v.string()),
    codeSigningThumbprint: v.optional(v.string()),
  },
  returns: v.id('signed_release_artifacts'),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query('signed_release_artifacts')
      .withIndex('by_artifact_key', (q) => q.eq('artifactKey', args.artifactKey))
      .collect();

    for (const row of existing) {
      if (
        row.channel === args.channel &&
        row.platform === args.platform &&
        row.status === 'active'
      ) {
        await ctx.db.patch(row._id, {
          status: 'inactive',
          updatedAt: now,
        });
      }
    }

    return await ctx.db.insert('signed_release_artifacts', {
      ...args,
      status: 'active',
      activatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const recordArtifactPublishedAudit = internalMutation({
  args: {
    artifactKey: v.string(),
    channel: v.string(),
    platform: v.string(),
    version: v.string(),
    plaintextSha256: v.string(),
    ciphertextSha256: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('audit_events', {
      eventType: 'release.artifact.published',
      actorType: 'system',
      metadata: {
        artifactKey: args.artifactKey,
        channel: args.channel,
        platform: args.platform,
        version: args.version,
        plaintextSha256: args.plaintextSha256,
        ciphertextSha256: args.ciphertextSha256,
      },
      correlationId: `${args.artifactKey}:${args.channel}:${args.platform}:${args.version}`,
      createdAt: Date.now(),
    });
  },
});

export const getDeliveryArtifactById = internalQuery({
  args: {
    artifactId: v.id('delivery_release_artifacts'),
  },
  returns: v.union(deliveryReleaseArtifactValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.artifactId);
    return toDeliveryReleaseArtifact(row);
  },
});

export const getActiveDeliveryArtifactForRelease = internalQuery({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
  },
  returns: v.union(deliveryReleaseArtifactValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('delivery_release_artifacts')
      .withIndex('by_release_role_status', (q) =>
        q
          .eq('deliveryPackageReleaseId', args.deliveryPackageReleaseId)
          .eq('artifactRole', args.artifactRole)
          .eq('status', 'active')
      )
      .first();
    return toDeliveryReleaseArtifact(row);
  },
});

export const getActiveDeliveryArtifactRecordForRelease = internalQuery({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('delivery_release_artifacts'),
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
      artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
      ownership: v.union(v.literal('creator_upload'), v.literal('server_materialized')),
      materializationStrategy: v.optional(deliveryMaterializationStrategyValidator),
      sourceArtifactId: v.optional(v.id('delivery_release_artifacts')),
      storageId: v.optional(v.id('_storage')),
      contentType: v.string(),
      deliveryName: v.string(),
      sha256: v.string(),
      byteSize: v.number(),
      cdngineDelivery: v.optional(cdngineDeliveryReferenceValidator),
      cdngineSource: v.optional(cdngineSourceReferenceValidator),
      status: v.union(v.literal('active'), v.literal('inactive')),
      activatedAt: v.optional(v.number()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('delivery_release_artifacts')
      .withIndex('by_release_role_status', (q) =>
        q
          .eq('deliveryPackageReleaseId', args.deliveryPackageReleaseId)
          .eq('artifactRole', args.artifactRole)
          .eq('status', 'active')
      )
      .first();
    return row
      ? {
          _id: row._id,
          deliveryPackageReleaseId: row.deliveryPackageReleaseId,
          artifactRole: row.artifactRole,
          ownership: row.ownership,
          materializationStrategy: row.materializationStrategy,
          sourceArtifactId: row.sourceArtifactId,
          storageId: row.storageId,
          contentType: row.contentType,
          deliveryName: row.deliveryName,
          sha256: row.sha256,
          byteSize: row.byteSize,
          cdngineDelivery: row.cdngineDelivery,
          cdngineSource: row.cdngineSource,
          status: row.status,
          activatedAt: row.activatedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      : null;
  },
});

export const getDeliveryArtifactDownloadById = internalQuery({
  args: {
    artifactId: v.id('delivery_release_artifacts'),
  },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.id('_storage'),
      downloadUrl: v.string(),
      contentType: v.string(),
      deliveryName: v.string(),
      sha256: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.artifactId);
    if (!row?.storageId) {
      return null;
    }
    const downloadUrl = await ctx.storage.getUrl(row.storageId);
    if (!downloadUrl) {
      return null;
    }
    return {
      storageId: row.storageId,
      downloadUrl,
      contentType: row.contentType,
      deliveryName: row.deliveryName,
      sha256: row.sha256,
    };
  },
});

export const publishDeliveryArtifact = internalMutation({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
    ownership: v.union(v.literal('creator_upload'), v.literal('server_materialized')),
    materializationStrategy: v.optional(deliveryMaterializationStrategyValidator),
    sourceArtifactId: v.optional(v.id('delivery_release_artifacts')),
    storageId: v.optional(v.id('_storage')),
    contentType: v.string(),
    deliveryName: v.string(),
    sha256: v.string(),
    byteSize: v.number(),
    cdngineDelivery: v.optional(cdngineDeliveryReferenceValidator),
    cdngineSource: v.optional(cdngineSourceReferenceValidator),
  },
  returns: v.id('delivery_release_artifacts'),
  handler: async (ctx, args) => {
    if (args.storageId) {
      throw new Error(
        'Backstage delivery release artifacts must store CDNgine references, not Convex storage.'
      );
    }
    if (args.artifactRole === 'raw_upload' && args.cdngineDelivery) {
      throw new Error(
        'Raw Backstage upload artifacts must store cdngineSource, not cdngineDelivery.'
      );
    }
    if (args.artifactRole === 'server_deliverable' && args.cdngineSource) {
      throw new Error(
        'Server deliverable artifacts must store cdngineDelivery, not cdngineSource.'
      );
    }
    if (args.artifactRole === 'raw_upload' && !args.cdngineSource) {
      throw new Error('Raw Backstage upload artifacts require cdngineSource.');
    }
    if (args.artifactRole === 'server_deliverable' && !args.cdngineDelivery) {
      throw new Error('Server deliverable artifacts require cdngineDelivery.');
    }
    const now = Date.now();
    const existing = await ctx.db
      .query('delivery_release_artifacts')
      .withIndex('by_release_role_status', (q) =>
        q
          .eq('deliveryPackageReleaseId', args.deliveryPackageReleaseId)
          .eq('artifactRole', args.artifactRole)
          .eq('status', 'active')
      )
      .collect();

    for (const row of existing) {
      await ctx.db.patch(row._id, {
        status: 'inactive',
        updatedAt: now,
      });
    }

    return await ctx.db.insert('delivery_release_artifacts', {
      ...args,
      status: 'active',
      activatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});
