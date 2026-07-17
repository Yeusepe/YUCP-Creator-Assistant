import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;

// ponytail: One-shot production retirement tool. Delete after all delivery tables are empty.
export const clearBackstageDeliveryTables = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedBatchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;
    const batchSize = Number.isFinite(requestedBatchSize)
      ? Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(requestedBatchSize)))
      : DEFAULT_BATCH_SIZE;
    const pagination = { cursor: null, numItems: batchSize } as const;

    const artifacts = await ctx.db.query('delivery_release_artifacts').paginate(pagination);
    const releases = await ctx.db.query('delivery_package_releases').paginate(pagination);
    const productLinks = await ctx.db.query('delivery_package_products').paginate(pagination);
    const repoTokens = await ctx.db.query('delivery_repo_tokens').paginate(pagination);
    const packages = await ctx.db.query('delivery_packages').paginate(pagination);

    for (const document of artifacts.page) {
      await ctx.db.delete(document._id);
    }
    for (const document of releases.page) {
      await ctx.db.delete(document._id);
    }
    for (const document of productLinks.page) {
      await ctx.db.delete(document._id);
    }
    for (const document of repoTokens.page) {
      await ctx.db.delete(document._id);
    }
    for (const document of packages.page) {
      await ctx.db.delete(document._id);
    }

    return {
      batchSize,
      deleted: {
        deliveryPackageProducts: productLinks.page.length,
        deliveryPackageReleases: releases.page.length,
        deliveryPackages: packages.page.length,
        deliveryReleaseArtifacts: artifacts.page.length,
        deliveryRepoTokens: repoTokens.page.length,
      },
      isDone:
        artifacts.isDone &&
        releases.isDone &&
        productLinks.isDone &&
        repoTokens.isDone &&
        packages.isDone,
    };
  },
});
