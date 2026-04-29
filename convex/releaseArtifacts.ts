import { materializeBackstageReleaseArtifact } from '@yucp/shared/backstageReleaseMaterialization';
import { sha256Hex } from '@yucp/shared/crypto';
import { v } from 'convex/values';
import { unzipSync } from 'fflate';
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

type RepairMaterializedReleaseDeliverableResult =
  | {
      status: 'missing_raw_upload';
      deliveryPackageReleaseId: Id<'delivery_package_releases'>;
    }
  | {
      status: 'current';
      deliveryPackageReleaseId: Id<'delivery_package_releases'>;
      previousSha256?: string;
      nextSha256: string;
    }
  | {
      status: 'repaired';
      deliveryPackageReleaseId: Id<'delivery_package_releases'>;
      previousSha256?: string;
      nextSha256: string;
      deliverableArtifactId: Id<'delivery_release_artifacts'>;
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

export const getArtifactDownloadById = internalQuery({
  args: {
    artifactId: v.id('signed_release_artifacts'),
  },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.id('_storage'),
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
      storageId: v.id('_storage'),
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
      storageId: v.id('_storage'),
      contentType: v.string(),
      deliveryName: v.string(),
      sha256: v.string(),
      byteSize: v.number(),
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

export const generateDeliveryArtifactUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
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
    const release = await ctx.runQuery(internal.packageRegistry.getDeliveryPackageReleaseById, {
      deliveryPackageReleaseId: args.deliveryPackageReleaseId,
    });
    if (!release) {
      throw new Error(`Delivery package release not found: ${args.deliveryPackageReleaseId}`);
    }
    const deliveryPackage = await ctx.runQuery(internal.packageRegistry.getDeliveryPackageById, {
      deliveryPackageId: release.deliveryPackageId,
    });
    if (!deliveryPackage) {
      throw new Error(`Delivery package not found: ${release.deliveryPackageId}`);
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
      packageId: release.packageId,
      version: release.version,
      displayName: deliveryPackage.displayName ?? deliveryPackage.packageName,
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

export const repairMaterializedReleaseDeliverable = internalAction({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    apply: v.optional(v.boolean()),
  },
  returns: v.union(
    v.object({
      status: v.literal('missing_raw_upload'),
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
    }),
    v.object({
      status: v.literal('current'),
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
      previousSha256: v.optional(v.string()),
      nextSha256: v.string(),
    }),
    v.object({
      status: v.literal('repaired'),
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
      previousSha256: v.optional(v.string()),
      nextSha256: v.string(),
      deliverableArtifactId: v.id('delivery_release_artifacts'),
    })
  ),
  handler: async (ctx, args): Promise<RepairMaterializedReleaseDeliverableResult> => {
    let rawArtifact = await ctx.runQuery(
      internal.releaseArtifacts.getActiveDeliveryArtifactRecordForRelease,
      {
        deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        artifactRole: 'raw_upload',
      }
    );
    const currentDeliverable = await ctx.runQuery(
      internal.releaseArtifacts.getActiveDeliveryArtifactForRelease,
      {
        deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        artifactRole: 'server_deliverable',
      }
    );
    const release = await ctx.runQuery(internal.packageRegistry.getDeliveryPackageReleaseById, {
      deliveryPackageReleaseId: args.deliveryPackageReleaseId,
    });
    if (!release) {
      throw new Error(`Delivery package release not found: ${args.deliveryPackageReleaseId}`);
    }
    const deliveryPackage = await ctx.runQuery(internal.packageRegistry.getDeliveryPackageById, {
      deliveryPackageId: release.deliveryPackageId,
    });
    if (!deliveryPackage) {
      throw new Error(`Delivery package not found: ${release.deliveryPackageId}`);
    }

    let uploaded: Blob | null = null;
    if (!rawArtifact) {
      const signedArtifact = release.signedArtifactId
        ? await ctx.runQuery(internal.releaseArtifacts.getArtifactById, {
            artifactId: release.signedArtifactId,
          })
        : release.artifactKey
          ? await ctx.runQuery(internal.releaseArtifacts.getLatestActiveArtifactByKey, {
              artifactKey: release.artifactKey,
            })
          : null;
      const legacyWrapperStorageId = currentDeliverable?.storageId ?? signedArtifact?.storageId;
      if (!legacyWrapperStorageId) {
        return {
          status: 'missing_raw_upload',
          deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        };
      }
      const legacyWrapperBlob = await ctx.storage.get(legacyWrapperStorageId);
      if (!legacyWrapperBlob) {
        throw new Error(`Deliverable release storage not found: ${legacyWrapperStorageId}`);
      }
      const legacyArchive = unzipSync(new Uint8Array(await legacyWrapperBlob.arrayBuffer()));
      const legacyPayloadBytes = legacyArchive['BackstagePayload~/payload.unitypackage'];
      if (!legacyPayloadBytes) {
        return {
          status: 'missing_raw_upload',
          deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        };
      }
      const manifestBytes = legacyArchive['BackstagePayload~/backstage-payload.json'];
      const manifest = manifestBytes
        ? (JSON.parse(new TextDecoder().decode(manifestBytes)) as { payloadFileName?: string })
        : null;
      const recoveredDeliveryName =
        manifest?.payloadFileName?.trim() || `${release.packageId}-${release.version}.unitypackage`;
      const recoveredStorageId: Id<'_storage'> = await ctx.storage.store(
        new Blob(
          [
            legacyPayloadBytes.buffer.slice(
              legacyPayloadBytes.byteOffset,
              legacyPayloadBytes.byteOffset + legacyPayloadBytes.byteLength
            ) as ArrayBuffer,
          ],
          {
            type: 'application/octet-stream',
          }
        )
      );
      const recoveredRawArtifactId: Id<'delivery_release_artifacts'> = await ctx.runMutation(
        internal.releaseArtifacts.publishDeliveryArtifact,
        {
          deliveryPackageReleaseId: args.deliveryPackageReleaseId,
          artifactRole: 'raw_upload',
          ownership: 'creator_upload',
          storageId: recoveredStorageId,
          contentType: 'application/octet-stream',
          deliveryName: recoveredDeliveryName,
          sha256: await sha256Hex(legacyPayloadBytes),
          byteSize: legacyPayloadBytes.byteLength,
        }
      );
      rawArtifact = await ctx.runQuery(
        internal.releaseArtifacts.getActiveDeliveryArtifactRecordForRelease,
        {
          deliveryPackageReleaseId: args.deliveryPackageReleaseId,
          artifactRole: 'raw_upload',
        }
      );
      if (!rawArtifact || String(rawArtifact._id) !== String(recoveredRawArtifactId)) {
        throw new Error(`Recovered raw upload could not be activated: ${args.deliveryPackageReleaseId}`);
      }
    }

    uploaded = await ctx.storage.get(rawArtifact.storageId);
    if (!uploaded) {
      throw new Error(`Uploaded release storage not found: ${rawArtifact.storageId}`);
    }

    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: new Uint8Array(await uploaded.arrayBuffer()),
      deliveryName: rawArtifact.deliveryName,
      contentType: rawArtifact.contentType,
      packageId: release.packageId,
      version: release.version,
      displayName: deliveryPackage.displayName ?? deliveryPackage.packageName,
    });
    const previousSha256 = currentDeliverable?.sha256 ?? release.zipSha256;
    const needsRepair =
      currentDeliverable?.sha256 !== materialized.sha256 ||
      currentDeliverable?.contentType !== materialized.contentType ||
      currentDeliverable?.deliveryName !== materialized.deliveryName ||
      release.zipSha256 !== materialized.sha256;

    if (!needsRepair || !args.apply) {
      return {
        status: 'current',
        deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        previousSha256,
        nextSha256: materialized.sha256,
      };
    }

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
        sourceArtifactId: rawArtifact._id,
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
      status: 'repaired',
      deliveryPackageReleaseId: args.deliveryPackageReleaseId,
      previousSha256,
      nextSha256: materialized.sha256,
      deliverableArtifactId,
    };
  },
});
