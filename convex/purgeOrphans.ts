import { mutation } from './_generated/server';
import { v } from 'convex/values';

function requireApiSecret(apiSecret: string | undefined): void {
    const expected = process.env.CONVEX_API_SECRET;
    if (!expected || apiSecret !== expected) {
        throw new Error('Unauthorized: invalid or missing API secret');
    }
}

export const purge = mutation({
    args: {
        apiSecret: v.string(),
    },
    returns: v.any(),
    handler: async (ctx, args) => {
        requireApiSecret(args.apiSecret);
        // Get everything in the product catalog
        const catalog = await ctx.db.query('product_catalog').collect();
        let purged = 0;

        for (const prod of catalog) {
            // Check if any rule references this catalog product
            const refs = await ctx.db
                .query('role_rules')
                .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', prod._id))
                .first();

            // If no rules explicitly reference this catalog ID, try a fallback search by productId
            // just in case old rules don't have catalogProductId set
            const refsByStringId = await ctx.db
                .query('role_rules')
                .withIndex('by_tenant', (q) => q.eq('tenantId', prod.tenantId))
                .filter((q) => q.eq(q.field('productId'), prod.productId))
                .first();

            if (!refs && !refsByStringId) {
                // Find and delete links first
                const links = await ctx.db
                    .query('catalog_product_links')
                    .filter((q) => q.eq(q.field('catalogProductId'), prod._id))
                    .collect();

                for (const link of links) {
                    await ctx.db.delete(link._id);
                }

                // Delete the catalog entry itself
                await ctx.db.delete(prod._id);
                purged++;
            }
        }

        return { purgedCount: purged };
    },
});
