/**
 * YUCP Package Name Registry, Layer 1 defense.
 *
 * Enforces namespace ownership: the first verified publisher to sign a
 * packageId owns that name permanently. Subsequent signers with a different
 * yucpUserId are rejected, making it impossible to impersonate an existing
 * package by creating a new account.
 *
 * Identity is anchored to the Better Auth user ID (yucpUserId), not to any
 * specific storefront account, so creators with multiple stores all bind to
 * the same stable identity.
 *
 * References:
 *   npm registry ownership model  https://docs.npmjs.com/about-package-naming
 *   Sigstore policy engine         https://docs.sigstore.dev/policy-controller/overview/
 */

import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export const getRegistration = internalQuery({
  args: { packageId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
  },
});

export const getRegistrationsByYucpUser = internalQuery({
  args: { yucpUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('package_registry')
      .withIndex('by_yucp_user_id', (q) => q.eq('yucpUserId', args.yucpUserId))
      .collect();
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

export type RegistrationResult =
  | { registered: true; conflict: false }
  | { registered: false; conflict: true; ownedBy: string };

export const registerPackage = internalMutation({
  args: {
    packageId: v.string(),
    publisherId: v.string(),
    /** Better Auth user ID of the registering creator */
    yucpUserId: v.string(),
  },
  handler: async (ctx, args): Promise<RegistrationResult> => {
    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();

    if (existing) {
      if (existing.yucpUserId !== args.yucpUserId) {
        // Different creator claims this namespace, ownership conflict
        return { registered: false, conflict: true, ownedBy: existing.yucpUserId };
      }
      // Same owner, potentially different publisherId (key rotation), update
      await ctx.db.patch(existing._id, {
        publisherId: args.publisherId,
        updatedAt: Date.now(),
      });
      return { registered: true, conflict: false };
    }

    const now = Date.now();
    await ctx.db.insert('package_registry', {
      packageId: args.packageId,
      publisherId: args.publisherId,
      yucpUserId: args.yucpUserId,
      registeredAt: now,
      updatedAt: now,
    });
    return { registered: true, conflict: false };
  },
});

/**
 * Admin-only: transfer package ownership after identity verification.
 * Records the previous owner for audit purposes.
 */
export const transferPackage = internalMutation({
  args: {
    packageId: v.string(),
    newPublisherId: v.string(),
    newYucpUserId: v.string(),
    transferReason: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (!existing) return { transferred: false, reason: 'not_found' };

    await ctx.db.patch(existing._id, {
      publisherId: args.newPublisherId,
      yucpUserId: args.newYucpUserId,
      transferredFromYucpUserId: existing.yucpUserId,
      transferReason: args.transferReason,
      updatedAt: Date.now(),
    });
    return { transferred: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Product Catalog Queries (public API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List product_catalog entries for a creator with optional provider/status filters and pagination.
 */
export const listByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    provider: v.optional(v.string()),
    status: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.provider) {
      all = all.filter((p) => p.provider === args.provider);
    }
    if (args.status) {
      all = all.filter((p) => p.status === args.status);
    }

    const limit = Math.min(args.limit ?? 50, 100);
    let startIndex = 0;
    if (args.cursor) {
      const idx = all.findIndex((item) => String(item._id) === args.cursor);
      if (idx !== -1) startIndex = idx + 1;
    }
    const data = all.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < all.length;
    return {
      data,
      hasMore,
      nextCursor: hasMore ? String(data[data.length - 1]._id) : null,
    };
  },
});

/**
 * Get a single product_catalog entry by ID, scoped to authUserId.
 */
export const getByIdForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    catalogProductId: v.id('product_catalog'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const doc = await ctx.db.get(args.catalogProductId);
    if (!doc || doc.authUserId !== args.authUserId) return null;
    return doc;
  },
});
