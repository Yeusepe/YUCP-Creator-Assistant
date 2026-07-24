import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { ApiActorBindingV, requireServiceActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';

const DEFAULT_CHANNEL = 'stable';

export const upsertReadyVersion = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    packageId: v.string(),
    version: v.string(),
    versionId: v.string(),
    activeContentDigest: v.string(),
    activePolicyVersion: v.string(),
    bindingRoot: v.string(),
    commonRoot: v.string(),
    logicalBytes: v.number(),
    logicalFiles: v.number(),
    manifestSha256: v.string(),
    protectedFiles: v.array(
      v.object({
        materializerType: v.string(),
        normalizedPath: v.string(),
        required: v.boolean(),
        sourceSha256: v.string(),
      })
    ),
    protectedSourceRoot: v.string(),
    protectionPolicyDigest: v.string(),
    protectionPolicyId: v.string(),
    releaseRoot: v.string(),
    channel: v.optional(v.string()),
    catalogProductId: v.optional(v.id('product_catalog')),
    createdAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<'package_versions_ref'>> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);

    const existing = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_version_id', (q) => q.eq('versionId', args.versionId))
      .first();
    if (existing) {
      return existing._id;
    }

    const channel = args.channel ?? DEFAULT_CHANNEL;
    const currentReadyVersions = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_package_channel', (q) =>
        q.eq('packageId', args.packageId).eq('channel', channel).eq('state', 'READY')
      )
      .collect();
    const hasCurrentReadyAtOrAfter = currentReadyVersions.some(
      (current) => current.createdAt >= args.createdAt
    );

    for (const current of currentReadyVersions) {
      if (current.createdAt < args.createdAt) {
        await ctx.db.patch(current._id, { state: 'SUPERSEDED' });
      }
    }

    return await ctx.db.insert('package_versions_ref', {
      packageId: args.packageId,
      version: args.version,
      versionId: args.versionId,
      activeContentDigest: args.activeContentDigest,
      activePolicyVersion: args.activePolicyVersion,
      bindingRoot: args.bindingRoot,
      commonRoot: args.commonRoot,
      logicalBytes: args.logicalBytes,
      logicalFiles: args.logicalFiles,
      manifestSha256: args.manifestSha256,
      protectedFiles: args.protectedFiles,
      protectedSourceRoot: args.protectedSourceRoot,
      protectionPolicyDigest: args.protectionPolicyDigest,
      protectionPolicyId: args.protectionPolicyId,
      releaseRoot: args.releaseRoot,
      channel,
      state: hasCurrentReadyAtOrAfter ? 'SUPERSEDED' : 'READY',
      catalogProductId: args.catalogProductId,
      createdAt: args.createdAt,
    });
  },
});

export const markVersionDeleted = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    versionId: v.string(),
    deletedAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<'package_versions_ref'>> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);

    const existing = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_version_id', (q) => q.eq('versionId', args.versionId))
      .first();
    if (!existing) {
      throw new Error(`Package version reference not found: ${args.versionId}`);
    }
    if (existing.state === 'DELETED') {
      return existing._id;
    }

    await ctx.db.patch(existing._id, {
      state: 'DELETED',
      deletedAt: args.deletedAt,
    });
    if (existing.state !== 'READY') {
      return existing._id;
    }

    const fallback = (
      await ctx.db
        .query('package_versions_ref')
        .withIndex('by_package_channel', (q) =>
          q
            .eq('packageId', existing.packageId)
            .eq('channel', existing.channel)
            .eq('state', 'SUPERSEDED')
        )
        .collect()
    ).sort(
      (left, right) =>
        right.createdAt - left.createdAt || String(right._id).localeCompare(String(left._id))
    )[0];
    if (fallback) {
      await ctx.db.patch(fallback._id, { state: 'READY' });
    }
    return existing._id;
  },
});

export const resolveDownloadableVersion = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    catalogProductId: v.optional(v.id('product_catalog')),
    packageId: v.optional(v.string()),
    channel: v.optional(v.string()),
    releaseRoot: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Doc<'package_versions_ref'> | null> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);

    const releaseRoot = args.releaseRoot;
    if (releaseRoot) {
      const exact = await ctx.db
        .query('package_versions_ref')
        .withIndex('by_release_root', (q) => q.eq('releaseRoot', releaseRoot))
        .first();
      if (
        !exact ||
        exact.state === 'DELETED' ||
        (args.packageId !== undefined && exact.packageId !== args.packageId) ||
        (args.catalogProductId !== undefined &&
          exact.catalogProductId !== args.catalogProductId)
      ) {
        return null;
      }
      return exact;
    }

    const channel = args.channel ?? DEFAULT_CHANNEL;
    if (args.catalogProductId) {
      const candidates = await ctx.db
        .query('package_versions_ref')
        .withIndex('by_catalog_product', (q) =>
          q.eq('catalogProductId', args.catalogProductId).eq('state', 'READY')
        )
        .collect();
      return (
        candidates
          .filter(
            (candidate) =>
              candidate.channel === channel &&
              (args.packageId === undefined || candidate.packageId === args.packageId)
          )
          .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
      );
    }

    const packageId = args.packageId;
    if (!packageId) {
      return null;
    }

    return await ctx.db
      .query('package_versions_ref')
      .withIndex('by_package_channel', (q) =>
        q.eq('packageId', packageId).eq('channel', channel).eq('state', 'READY')
      )
      .order('desc')
      .first();
  },
});
