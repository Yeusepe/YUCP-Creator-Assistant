import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, internalQuery } from './_generated/server';

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

function toSignedReleaseArtifact(row: Doc<'signed_release_artifacts'> | null) {
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
      .sort((left, right) => (right.activatedAt ?? right.createdAt) - (left.activatedAt ?? left.createdAt))[0];

    return toSignedReleaseArtifact(active);
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
      if (row.channel === args.channel && row.platform === args.platform && row.status === 'active') {
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
