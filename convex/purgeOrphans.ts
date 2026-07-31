import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import {
  getCatalogProductDeleteBlockedReason,
  inspectCatalogProductDeletionDependencies,
} from './lib/catalogProductDeletion';

export const purge = mutation({
  args: {
    apiSecret: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const catalog = await ctx.db.query('product_catalog').collect();
    let purged = 0;

    for (const prod of catalog) {
      const dependencies = await inspectCatalogProductDeletionDependencies(ctx.db, prod._id);
      if (getCatalogProductDeleteBlockedReason(dependencies)) {
        continue;
      }

      // Rules predating catalogProductId reference the product by its provider id.
      const legacyRuleReference = await ctx.db
        .query('role_rules')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', prod.authUserId))
        .filter((q) => q.eq(q.field('productId'), prod.productId))
        .first();

      if (!legacyRuleReference) {
        const links = await ctx.db
          .query('catalog_product_links')
          .filter((q) => q.eq(q.field('catalogProductId'), prod._id))
          .collect();

        for (const link of links) {
          await ctx.db.delete(link._id);
        }

        await ctx.db.delete(prod._id);
        purged++;
      }
    }

    return { purgedCount: purged };
  },
});
