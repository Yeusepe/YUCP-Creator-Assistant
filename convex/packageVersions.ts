import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, query } from './_generated/server';
import { ApiActorBindingV, requireServiceActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';

const DEFAULT_CHANNEL = 'stable';

export const upsertReadyVersion = internalMutation({
  args: {
    packageId: v.string(),
    version: v.string(),
    versionId: v.string(),
    channel: v.optional(v.string()),
    catalogProductId: v.optional(v.id('product_catalog')),
    totalSize: v.optional(v.number()),
    contentType: v.optional(v.string()),
    createdAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<'package_versions_ref'>> => {
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

    for (const current of currentReadyVersions) {
      await ctx.db.patch(current._id, { state: 'SUPERSEDED' });
    }

    return await ctx.db.insert('package_versions_ref', {
      packageId: args.packageId,
      version: args.version,
      versionId: args.versionId,
      channel,
      state: 'READY',
      catalogProductId: args.catalogProductId,
      totalSize: args.totalSize,
      contentType: args.contentType,
      createdAt: args.createdAt,
    });
  },
});

export const resolveDownloadableVersion = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    catalogProductId: v.optional(v.id('product_catalog')),
    packageId: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Doc<'package_versions_ref'> | null> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);

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
