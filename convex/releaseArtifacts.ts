import { materializeBackstageReleaseArtifact } from '@yucp/shared/backstageReleaseMaterialization';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';

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

const deliveryReleaseArtifactValidator = v.object({
  deliveryPackageReleaseId: v.id('delivery_package_releases'),
  artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
  ownership: v.union(v.literal('creator_upload'), v.literal('server_materialized')),
  materializationStrategy: v.optional(deliveryMaterializationStrategyValidator),
  sourceArtifactId: v.optional(v.id('delivery_release_artifacts')),
  storageId: v.id('_storage'),
  contentType: v.string(),
  deliveryName: v.string(),
  sha256: v.string(),
  byteSize: v.number(),
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

type MaterializedReleaseDeliverableResult = {
  deliveryArtifactMode: 'server_materialized';
  rawArtifactId: Id<'delivery_release_artifacts'>;
  deliverableArtifactId: Id<'delivery_release_artifacts'>;
  deliverableSha256: string;
  materializationStrategy: 'normalized_repack';
};

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

export const publishDeliveryArtifact = internalMutation({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
      artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
      ownership: v.union(v.literal('creator_upload'), v.literal('server_materialized')),
      materializationStrategy: v.optional(deliveryMaterializationStrategyValidator),
      sourceArtifactId: v.optional(v.id('delivery_release_artifacts')),
      storageId: v.id('_storage'),
      contentType: v.string(),
    deliveryName: v.string(),
    sha256: v.string(),
    byteSize: v.number(),
  },
  returns: v.id('delivery_release_artifacts'),
  handler: async (ctx, args) => {
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

export const materializeUploadedReleaseDeliverable = internalAction({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    storageId: v.id('_storage'),
    contentType: v.string(),
    deliveryName: v.string(),
    sha256: v.string(),
  },
    returns: v.object({
      deliveryArtifactMode: deliveryArtifactModeValidator,
      rawArtifactId: v.id('delivery_release_artifacts'),
      deliverableArtifactId: v.id('delivery_release_artifacts'),
      deliverableSha256: v.string(),
      materializationStrategy: v.union(v.literal('normalized_repack')),
    }),
  handler: async (ctx, args): Promise<MaterializedReleaseDeliverableResult> => {
    const uploaded = await ctx.storage.get(args.storageId);
    if (!uploaded) {
      throw new Error(`Uploaded release storage not found: ${args.storageId}`);
    }

    const byteSize = uploaded.size;
    const rawArtifactId: Id<'delivery_release_artifacts'> = await ctx.runMutation(
      internal.releaseArtifacts.publishDeliveryArtifact,
      {
        deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        artifactRole: 'raw_upload',
        ownership: 'creator_upload',
        storageId: args.storageId,
        contentType: args.contentType,
        deliveryName: args.deliveryName,
        sha256: args.sha256,
        byteSize,
      }
    );

    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: new Uint8Array(await uploaded.arrayBuffer()),
      deliveryName: args.deliveryName,
      contentType: args.contentType,
    });
    const deliverableBytes = materialized.bytes.buffer.slice(
      materialized.bytes.byteOffset,
      materialized.bytes.byteOffset + materialized.bytes.byteLength
    ) as ArrayBuffer;
    const deliverableStorageId: Id<'_storage'> = await ctx.storage.store(
      new Blob([deliverableBytes], {
        type: materialized.contentType,
      })
    );
    const deliverableArtifactId: Id<'delivery_release_artifacts'> = await ctx.runMutation(
      internal.releaseArtifacts.publishDeliveryArtifact,
      {
        deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        artifactRole: 'server_deliverable',
        ownership: 'server_materialized',
        materializationStrategy: materialized.materializationStrategy,
        sourceArtifactId: rawArtifactId,
        storageId: deliverableStorageId,
        contentType: materialized.contentType,
        deliveryName: materialized.deliveryName,
        sha256: materialized.sha256,
        byteSize: materialized.byteSize,
      }
    );
    await ctx.runMutation(internal.packageRegistry.updateMaterializedReleaseDigest, {
      deliveryPackageReleaseId: args.deliveryPackageReleaseId,
      zipSha256: materialized.sha256,
    });

    return {
      deliveryArtifactMode: 'server_materialized',
      rawArtifactId,
      deliverableArtifactId,
      deliverableSha256: materialized.sha256,
      materializationStrategy: materialized.materializationStrategy,
    };
  },
});
