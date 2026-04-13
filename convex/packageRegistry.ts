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
import type { Doc } from './_generated/dataModel';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const PACKAGE_NAME_MAX_LENGTH = 120;
const PACKAGE_DELETE_BLOCKED_REASON =
  'Package has signing or license history and cannot be deleted.';
const PACKAGE_ARCHIVED_UPDATE_BLOCKED_REASON =
  'Archived packages cannot be updated. Restore the package before renaming it.';
const PACKAGE_ARCHIVED_SIGNING_BLOCKED_REASON =
  'Archived packages cannot be updated. Restore the package before signing or changing it.';

function getPackageStatus(
  registration: Pick<Doc<'package_registry'>, 'status'>
): 'active' | 'archived' {
  return registration.status === 'archived' ? 'archived' : 'active';
}

function isArchivedRegistration(registration: Pick<Doc<'package_registry'>, 'status'>): boolean {
  return getPackageStatus(registration) === 'archived';
}

function normalizePackageName(packageName: string | undefined): string | undefined {
  if (typeof packageName !== 'string') {
    return undefined;
  }
  const normalized = packageName.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > PACKAGE_NAME_MAX_LENGTH) {
    throw new ConvexError(`Package name must be ${PACKAGE_NAME_MAX_LENGTH} characters or fewer`);
  }
  return normalized;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export const getRegistration = internalQuery({
  args: { packageId: v.string() },
  handler: async (ctx, args): Promise<Doc<'package_registry'> | null> => {
    return await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
  },
});

export const getRegistrationsByYucpUser = internalQuery({
  args: { yucpUserId: v.string() },
  handler: async (ctx, args): Promise<Doc<'package_registry'>[]> => {
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
  | { registered: true; conflict: false; archived: false }
  | { registered: false; conflict: true; archived: false; ownedBy: string }
  | { registered: false; conflict: false; archived: true; reason: string };

export const registerPackage = internalMutation({
  args: {
    packageId: v.string(),
    packageName: v.optional(v.string()),
    publisherId: v.string(),
    /** Better Auth user ID of the registering creator */
    yucpUserId: v.string(),
  },
  handler: async (ctx, args): Promise<RegistrationResult> => {
    // c74: Validate packageId format, only safe characters, bounded length.
    if (!PACKAGE_ID_RE.test(args.packageId)) {
      throw new ConvexError(`Invalid packageId format: ${args.packageId}`);
    }

    const normalizedPackageName = normalizePackageName(args.packageName);

    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();

    if (existing) {
      if (existing.yucpUserId !== args.yucpUserId) {
        // Different creator claims this namespace, ownership conflict
        return { registered: false, conflict: true, archived: false, ownedBy: existing.yucpUserId };
      }
      if (isArchivedRegistration(existing)) {
        return {
          registered: false,
          conflict: false,
          archived: true,
          reason: PACKAGE_ARCHIVED_SIGNING_BLOCKED_REASON,
        };
      }
      // Same owner, potentially different publisherId (key rotation), update
      await ctx.db.patch(existing._id, {
        publisherId: args.publisherId,
        packageName: normalizedPackageName ?? existing.packageName,
        status: 'active',
        updatedAt: Date.now(),
      });
      return { registered: true, conflict: false, archived: false };
    }

    const now = Date.now();
    await ctx.db.insert('package_registry', {
      packageId: args.packageId,
      packageName: normalizedPackageName,
      publisherId: args.publisherId,
      yucpUserId: args.yucpUserId,
      status: 'active',
      registeredAt: now,
      updatedAt: now,
    });
    return { registered: true, conflict: false, archived: false };
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

export const listForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    includeArchived: v.optional(v.boolean()),
  },
  returns: v.object({
    packages: v.array(
      v.object({
        packageId: v.string(),
        packageName: v.optional(v.string()),
        registeredAt: v.number(),
        updatedAt: v.number(),
        status: v.union(v.literal('active'), v.literal('archived')),
        archivedAt: v.optional(v.number()),
        canDelete: v.boolean(),
        deleteBlockedReason: v.optional(v.string()),
        canArchive: v.boolean(),
        canRestore: v.boolean(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const rows = (
      await ctx.db
        .query('package_registry')
        .withIndex('by_yucp_user_id', (q) => q.eq('yucpUserId', args.authUserId))
        .collect()
    ).filter((row) => args.includeArchived || !isArchivedRegistration(row));

    const packages = await Promise.all(
      rows.map(async (row) => {
        const status = getPackageStatus(row);
        const signingLog = await ctx.db
          .query('signing_log')
          .withIndex('by_package_id', (q) => q.eq('packageId', row.packageId))
          .first();
        const protectedAsset = signingLog
          ? null
          : await ctx.db
              .query('protected_assets')
              .withIndex('by_package_id', (q) => q.eq('packageId', row.packageId))
              .first();
        const couplingTrace =
          signingLog || protectedAsset
            ? null
            : await ctx.db
                .query('coupling_trace_records')
                .withIndex('by_package_token', (q) => q.eq('packageId', row.packageId))
                .first();
        const protectedUnlock =
          signingLog || protectedAsset || couplingTrace
            ? null
            : await ctx.db
                .query('protected_asset_unlocks')
                .withIndex('by_package_asset_machine_project', (q) =>
                  q.eq('packageId', row.packageId)
                )
                .first();
        const deleteBlockedReason =
          signingLog || protectedAsset || couplingTrace || protectedUnlock
            ? PACKAGE_DELETE_BLOCKED_REASON
            : undefined;
        return {
          packageId: row.packageId,
          packageName: row.packageName,
          registeredAt: row.registeredAt,
          updatedAt: row.updatedAt,
          status,
          archivedAt: row.archivedAt,
          canDelete: deleteBlockedReason === undefined,
          deleteBlockedReason,
          canArchive: status === 'active',
          canRestore: status === 'archived',
        };
      })
    );

    return {
      packages: packages.sort((left, right) => {
        const leftLabel = (left.packageName ?? left.packageId).toLowerCase();
        const rightLabel = (right.packageName ?? right.packageId).toLowerCase();
        return leftLabel.localeCompare(rightLabel) || left.packageId.localeCompare(right.packageId);
      }),
    };
  },
});

export const renameForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    packageId: v.string(),
    packageName: v.string(),
  },
  returns: v.union(
    v.object({
      updated: v.literal(true),
      packageId: v.string(),
      packageName: v.string(),
    }),
    v.object({
      updated: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const normalizedPackageName = normalizePackageName(args.packageName);
    if (!normalizedPackageName) {
      return { updated: false as const, reason: 'Package name is required.' };
    }

    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (!existing || existing.yucpUserId !== args.authUserId) {
      return { updated: false as const, reason: 'Package not found.' };
    }
    if (isArchivedRegistration(existing)) {
      return {
        updated: false as const,
        reason: PACKAGE_ARCHIVED_UPDATE_BLOCKED_REASON,
      };
    }

    await ctx.db.patch(existing._id, {
      packageName: normalizedPackageName,
      updatedAt: Date.now(),
    });

    return {
      updated: true as const,
      packageId: args.packageId,
      packageName: normalizedPackageName,
    };
  },
});

export const archiveForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    packageId: v.string(),
  },
  returns: v.union(
    v.object({
      archived: v.literal(true),
      packageId: v.string(),
    }),
    v.object({
      archived: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (!existing || existing.yucpUserId !== args.authUserId) {
      return { archived: false as const, reason: 'Package not found.' };
    }

    if (!isArchivedRegistration(existing)) {
      await ctx.db.patch(existing._id, {
        status: 'archived',
        archivedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return { archived: true as const, packageId: args.packageId };
  },
});

export const restoreForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    packageId: v.string(),
  },
  returns: v.union(
    v.object({
      restored: v.literal(true),
      packageId: v.string(),
    }),
    v.object({
      restored: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (!existing || existing.yucpUserId !== args.authUserId) {
      return { restored: false as const, reason: 'Package not found.' };
    }

    if (isArchivedRegistration(existing)) {
      await ctx.db.patch(existing._id, {
        status: 'active',
        archivedAt: undefined,
        updatedAt: Date.now(),
      });
    }

    return { restored: true as const, packageId: args.packageId };
  },
});

export const deleteForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    packageId: v.string(),
  },
  returns: v.union(
    v.object({
      deleted: v.literal(true),
      packageId: v.string(),
    }),
    v.object({
      deleted: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (!existing || existing.yucpUserId !== args.authUserId) {
      return { deleted: false as const, reason: 'Package not found.' };
    }

    const signingLog = await ctx.db
      .query('signing_log')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (signingLog) {
      return { deleted: false as const, reason: PACKAGE_DELETE_BLOCKED_REASON };
    }

    const protectedAsset = await ctx.db
      .query('protected_assets')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (protectedAsset) {
      return { deleted: false as const, reason: PACKAGE_DELETE_BLOCKED_REASON };
    }

    const couplingTrace = await ctx.db
      .query('coupling_trace_records')
      .withIndex('by_package_token', (q) => q.eq('packageId', args.packageId))
      .first();
    if (couplingTrace) {
      return { deleted: false as const, reason: PACKAGE_DELETE_BLOCKED_REASON };
    }

    const protectedUnlock = await ctx.db
      .query('protected_asset_unlocks')
      .withIndex('by_package_asset_machine_project', (q) => q.eq('packageId', args.packageId))
      .first();
    if (protectedUnlock) {
      return { deleted: false as const, reason: PACKAGE_DELETE_BLOCKED_REASON };
    }

    await ctx.db.delete(existing._id);
    return { deleted: true as const, packageId: args.packageId };
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
