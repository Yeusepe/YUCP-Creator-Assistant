import type { AnyDataModel, GenericDatabaseWriter } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const DELIVERY_TABLE_PREFIX = 'delivery_';

const RETIRED_TABLES = {
  artifacts: `${DELIVERY_TABLE_PREFIX}release_${'artifacts'}`,
  releases: `${DELIVERY_TABLE_PREFIX}package_${'releases'}`,
  productLinks: `${DELIVERY_TABLE_PREFIX}package_${'products'}`,
  repoTokens: `${DELIVERY_TABLE_PREFIX}repo_${'tokens'}`,
  packages: `${DELIVERY_TABLE_PREFIX}${'packages'}`,
} as const;

async function clearBatch(
  db: GenericDatabaseWriter<AnyDataModel>,
  tableName: string,
  batchSize: number
): Promise<{ deleted: number; isDone: boolean }> {
  const result = await db.query(tableName).paginate({ cursor: null, numItems: batchSize });
  for (const document of result.page) {
    await db.delete(document._id);
  }
  return { deleted: result.page.length, isDone: result.isDone };
}

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
    const db = ctx.db as unknown as GenericDatabaseWriter<AnyDataModel>;
    const artifacts = await clearBatch(db, RETIRED_TABLES.artifacts, batchSize);
    const releases = await clearBatch(db, RETIRED_TABLES.releases, batchSize);
    const productLinks = await clearBatch(db, RETIRED_TABLES.productLinks, batchSize);
    const repoTokens = await clearBatch(db, RETIRED_TABLES.repoTokens, batchSize);
    const packages = await clearBatch(db, RETIRED_TABLES.packages, batchSize);

    return {
      batchSize,
      deleted: {
        deliveryPackageProducts: productLinks.deleted,
        deliveryPackageReleases: releases.deleted,
        deliveryPackages: packages.deleted,
        deliveryReleaseArtifacts: artifacts.deleted,
        deliveryRepoTokens: repoTokens.deleted,
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
