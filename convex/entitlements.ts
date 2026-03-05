/**
 * Entitlement Service
 *
 * Converts provider evidence into entitlement grants and revocations.
 * Handles policy version snapshotting, purchaser memory lookup, and outbox job emission.
 *
 * Key responsibilities:
 * - Grant entitlements from provider evidence with policy snapshot
 * - Revoke entitlements with cascade to roles
 * - Refresh entitlements from fresh evidence
 * - Emit outbox jobs for side effects (role sync, notifications)
 */

import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { Doc } from './_generated/dataModel';

// ============================================================================
// TYPES
// ============================================================================

/** Provider types for entitlements */
export const EntitlementProvider = v.union(
  v.literal('discord'),
  v.literal('gumroad'),
  v.literal('jinxxy'),
  v.literal('manual'),
);

/** Entitlement status values */
export const EntitlementStatus = v.union(
  v.literal('active'),
  v.literal('revoked'),
  v.literal('expired'),
  v.literal('refunded'),
  v.literal('disputed'),
);

/** Provider evidence for granting entitlements */
export const ProviderEvidence = v.object({
  provider: EntitlementProvider,
  sourceReference: v.string(), // Order ID, license key, etc.
  providerCustomerId: v.optional(v.id('provider_customers')),
  purchasedAt: v.optional(v.number()),
  amount: v.optional(v.number()),
  currency: v.optional(v.string()),
  rawEvidence: v.optional(v.any()),
});

/** Result of granting an entitlement */
export const GrantResult = v.object({
  success: v.boolean(),
  entitlementId: v.id('entitlements'),
  isNew: v.boolean(),
  previousStatus: v.optional(EntitlementStatus),
  outboxJobId: v.optional(v.id('outbox_jobs')),
});

/** Result of revoking an entitlement */
export const RevokeResult = v.object({
  success: v.boolean(),
  entitlementId: v.id('entitlements'),
  previousStatus: EntitlementStatus,
  revokedAt: v.number(),
  outboxJobIds: v.array(v.id('outbox_jobs')),
});

/** Revocation reason types */
export const RevocationReason = v.union(
  v.literal('refund'),
  v.literal('dispute'),
  v.literal('expiration'),
  v.literal('manual'),
  v.literal('transfer'),
  v.literal('policy_violation'),
);

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get all entitlements for a subject within a tenant.
 * Returns entitlements sorted by grantedAt descending.
 */
export const getEntitlementsBySubject = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    subjectId: v.id('subjects'),
    includeInactive: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      _id: v.id('entitlements'),
      _creationTime: v.number(),
      tenantId: v.id('tenants'),
      subjectId: v.id('subjects'),
      productId: v.string(),
      sourceProvider: EntitlementProvider,
      sourceReference: v.string(),
      providerCustomerId: v.optional(v.id('provider_customers')),
      catalogProductId: v.optional(v.id('product_catalog')),
      status: EntitlementStatus,
      policySnapshotVersion: v.optional(v.number()),
      grantedAt: v.number(),
      revokedAt: v.optional(v.number()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    let query = ctx.db
      .query('entitlements')
      .withIndex('by_tenant_subject', (q) =>
        q.eq('tenantId', args.tenantId).eq('subjectId', args.subjectId),
      );

    if (!args.includeInactive) {
      query = query.filter((q) => q.eq(q.field('status'), 'active'));
    }

    const entitlements = await query.order('desc').collect();
    return entitlements;
  },
});

/**
 * Get all entitlements for a product within a tenant.
 * Useful for product-level analytics and role assignment.
 */
export const getEntitlementsByProduct = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    productId: v.string(),
    includeInactive: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      _id: v.id('entitlements'),
      _creationTime: v.number(),
      tenantId: v.id('tenants'),
      subjectId: v.id('subjects'),
      productId: v.string(),
      sourceProvider: EntitlementProvider,
      sourceReference: v.string(),
      providerCustomerId: v.optional(v.id('provider_customers')),
      catalogProductId: v.optional(v.id('product_catalog')),
      status: EntitlementStatus,
      policySnapshotVersion: v.optional(v.number()),
      grantedAt: v.number(),
      revokedAt: v.optional(v.number()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    let query = ctx.db
      .query('entitlements')
      .withIndex('by_tenant_product', (q) =>
        q.eq('tenantId', args.tenantId).eq('productId', args.productId),
      );

    if (!args.includeInactive) {
      query = query.filter((q) => q.eq(q.field('status'), 'active'));
    }

    const entitlements = await query.order('desc').collect();
    return entitlements;
  },
});

/**
 * Get the active entitlement for a subject and product.
 * Returns null if no active entitlement exists.
 */
export const getActiveEntitlement = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    subjectId: v.id('subjects'),
    productId: v.string(),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      entitlement: v.object({
        _id: v.id('entitlements'),
        _creationTime: v.number(),
        tenantId: v.id('tenants'),
        subjectId: v.id('subjects'),
        productId: v.string(),
        sourceProvider: EntitlementProvider,
        sourceReference: v.string(),
        providerCustomerId: v.optional(v.id('provider_customers')),
        catalogProductId: v.optional(v.id('product_catalog')),
        status: EntitlementStatus,
        policySnapshotVersion: v.optional(v.number()),
        grantedAt: v.number(),
        revokedAt: v.optional(v.number()),
        updatedAt: v.number(),
      }),
    }),
    v.object({
      found: v.literal(false),
      entitlement: v.null(),
    }),
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const entitlement = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_subject', (q) =>
        q.eq('tenantId', args.tenantId).eq('subjectId', args.subjectId),
      )
      .filter((q) => q.eq(q.field('productId'), args.productId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    if (!entitlement) {
      return { found: false as const, entitlement: null };
    }

    return { found: true as const, entitlement };
  },
});

/**
 * Stats overview for bot /yucp stats.
 */
export const getStatsOverview = query({
  args: { apiSecret: v.string(), tenantId: v.id('tenants') },
  returns: v.object({
    totalVerified: v.number(),
    totalProducts: v.number(),
    recentGrantsCount: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const activeEntitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_status', (q) =>
        q.eq('tenantId', args.tenantId).eq('status', 'active'),
      )
      .collect();
    const uniqueSubjects = new Set(activeEntitlements.map((e) => e.subjectId));
    const uniqueProducts = new Set(activeEntitlements.map((e) => e.productId));
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentGrants = activeEntitlements.filter((e) => e.grantedAt >= oneDayAgo);
    return {
      totalVerified: uniqueSubjects.size,
      totalProducts: uniqueProducts.size,
      recentGrantsCount: recentGrants.length,
    };
  },
});

/**
 * Verified users for tenant (paginated, for /yucp stats verified).
 */
export const getVerifiedUsersPaginated = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    users: v.array(
      v.object({
        subjectId: v.id('subjects'),
        discordUserId: v.string(),
        displayName: v.optional(v.string()),
        productCount: v.number(),
      }),
    ),
    nextCursor: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = Math.min(args.limit ?? 25, 50);
    const activeEntitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_status', (q) =>
        q.eq('tenantId', args.tenantId).eq('status', 'active'),
      )
      .collect();
    const bySubject = new Map<
      string,
      { productIds: Set<string> }
    >();
    for (const e of activeEntitlements) {
      const existing = bySubject.get(e.subjectId);
      if (existing) {
        existing.productIds.add(e.productId);
      } else {
        bySubject.set(e.subjectId, { productIds: new Set([e.productId]) });
      }
    }
    const subjectIds = Array.from(bySubject.keys());
    const start = args.cursor ? subjectIds.indexOf(args.cursor) + 1 : 0;
    const slice = subjectIds.slice(start, start + limit);
    const users: Array<{
      subjectId: Id<'subjects'>;
      discordUserId: string;
      displayName?: string;
      productCount: number;
    }> = [];
    for (const sid of slice) {
      const subject = await ctx.db.get(sid as Id<'subjects'>);
      const data = bySubject.get(sid)!;
      if (subject) {
        users.push({
          subjectId: subject._id,
          discordUserId: subject.primaryDiscordUserId,
          displayName: subject.displayName,
          productCount: data.productIds.size,
        });
      }
    }
    const nextCursor =
      start + limit < subjectIds.length ? subjectIds[start + limit - 1] : undefined;
    return { users, nextCursor };
  },
});

/**
 * Product verification counts for /yucp stats products.
 */
export const getProductStats = query({
  args: { apiSecret: v.string(), tenantId: v.id('tenants') },
  returns: v.array(
    v.object({
      productId: v.string(),
      verifiedCount: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const activeEntitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_status', (q) =>
        q.eq('tenantId', args.tenantId).eq('status', 'active'),
      )
      .collect();
    const byProduct = new Map<string, number>();
    for (const e of activeEntitlements) {
      byProduct.set(e.productId, (byProduct.get(e.productId) ?? 0) + 1);
    }
    return Array.from(byProduct.entries()).map(([productId, verifiedCount]) => ({
      productId,
      verifiedCount,
    }));
  },
});

/**
 * Check if a subject has any active entitlement for a product.
 * Lightweight check for authorization purposes.
 */
export const hasActiveEntitlement = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    subjectId: v.id('subjects'),
    productId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const entitlement = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_subject', (q) =>
        q.eq('tenantId', args.tenantId).eq('subjectId', args.subjectId),
      )
      .filter((q) => q.eq(q.field('productId'), args.productId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    return entitlement !== null;
  },
});

/**
 * Get entitlement by ID.
 */
export const getEntitlement = query({
  args: {
    apiSecret: v.string(),
    entitlementId: v.id('entitlements'),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      entitlement: v.object({
        _id: v.id('entitlements'),
        _creationTime: v.number(),
        tenantId: v.id('tenants'),
        subjectId: v.id('subjects'),
        productId: v.string(),
        sourceProvider: EntitlementProvider,
        sourceReference: v.string(),
        providerCustomerId: v.optional(v.id('provider_customers')),
        catalogProductId: v.optional(v.id('product_catalog')),
        status: EntitlementStatus,
        policySnapshotVersion: v.optional(v.number()),
        grantedAt: v.number(),
        revokedAt: v.optional(v.number()),
        updatedAt: v.number(),
      }),
    }),
    v.object({
      found: v.literal(false),
      entitlement: v.null(),
    }),
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const entitlement = await ctx.db.get(args.entitlementId);

    if (!entitlement) {
      return { found: false as const, entitlement: null };
    }

    return { found: true as const, entitlement };
  },
});

/**
 * Get entitlements by provider customer.
 * Used for purchaser memory lookup to find supported products.
 */
export const getEntitlementsByProviderCustomer = query({
  args: {
    apiSecret: v.string(),
    providerCustomerId: v.id('provider_customers'),
  },
  returns: v.array(
    v.object({
      _id: v.id('entitlements'),
      _creationTime: v.number(),
      tenantId: v.id('tenants'),
      subjectId: v.id('subjects'),
      productId: v.string(),
      sourceProvider: EntitlementProvider,
      sourceReference: v.string(),
      providerCustomerId: v.optional(v.id('provider_customers')),
      catalogProductId: v.optional(v.id('product_catalog')),
      status: EntitlementStatus,
      policySnapshotVersion: v.optional(v.number()),
      grantedAt: v.number(),
      revokedAt: v.optional(v.number()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_provider_customer', (q) =>
        q.eq('providerCustomerId', args.providerCustomerId),
      )
      .collect();

    return entitlements;
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Grant an entitlement from provider evidence.
 *
 * This mutation:
 * 1. Checks for existing entitlement (idempotent)
 * 2. Creates new entitlement with policy snapshot
 * 3. Emits outbox job for role sync
 * 4. Creates audit event
 *
 * Idempotent: Safe to call multiple times with the same sourceReference.
 */
export const grantEntitlement = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    subjectId: v.id('subjects'),
    productId: v.string(),
    evidence: ProviderEvidence,
    catalogProductId: v.optional(v.id('product_catalog')),
    correlationId: v.optional(v.string()),
  },
  returns: GrantResult,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    // Get tenant for policy snapshot
    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) {
      throw new Error(`Tenant not found: ${args.tenantId}`);
    }

    // Check for existing entitlement with same sourceReference (idempotency)
    const existingEntitlement = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_subject', (q) =>
        q.eq('tenantId', args.tenantId).eq('subjectId', args.subjectId),
      )
      .filter((q) => q.eq(q.field('sourceReference'), args.evidence.sourceReference))
      .first();

    if (existingEntitlement) {
      // Entitlement already exists - check if we need to reactivate
      if (existingEntitlement.status === 'active') {
        // Already active, nothing to do
        return {
          success: true,
          entitlementId: existingEntitlement._id,
          isNew: false,
          previousStatus: undefined,
          outboxJobId: undefined,
        };
      }

      // Reactivate a revoked/expired entitlement
      const previousStatus = existingEntitlement.status;
      await ctx.db.patch(existingEntitlement._id, {
        status: 'active',
        revokedAt: undefined,
        updatedAt: now,
      });

      // Emit role sync job
      const outboxJobId = await emitRoleSyncJob(
        ctx,
        args.tenantId,
        args.subjectId,
        existingEntitlement._id,
        args.correlationId,
      );

      // Create audit event
      await createAuditEvent(ctx, {
        tenantId: args.tenantId,
        eventType: 'entitlement.granted',
        subjectId: args.subjectId,
        entitlementId: existingEntitlement._id,
        metadata: {
          productId: args.productId,
          sourceProvider: args.evidence.provider,
          sourceReference: args.evidence.sourceReference,
          reactivated: true,
          previousStatus,
        },
        correlationId: args.correlationId,
      });

      return {
        success: true,
        entitlementId: existingEntitlement._id,
        isNew: false,
        previousStatus,
        outboxJobId,
      };
    }

    // Calculate policy snapshot version
    // Use a simple counter based on tenant policy updates
    const policySnapshotVersion = await getPolicySnapshotVersion(ctx, args.tenantId, tenant);

    // Create new entitlement
    const entitlementId = await ctx.db.insert('entitlements', {
      tenantId: args.tenantId,
      subjectId: args.subjectId,
      productId: args.productId,
      sourceProvider: args.evidence.provider,
      sourceReference: args.evidence.sourceReference,
      providerCustomerId: args.evidence.providerCustomerId,
      catalogProductId: args.catalogProductId,
      status: 'active',
      policySnapshotVersion,
      grantedAt: args.evidence.purchasedAt ?? now,
      updatedAt: now,
    });

    // Emit role sync job
    const outboxJobId = await emitRoleSyncJob(
      ctx,
      args.tenantId,
      args.subjectId,
      entitlementId,
      args.correlationId,
    );

    // Create audit event
    await createAuditEvent(ctx, {
      tenantId: args.tenantId,
      eventType: 'entitlement.granted',
      subjectId: args.subjectId,
      entitlementId,
      metadata: {
        productId: args.productId,
        sourceProvider: args.evidence.provider,
        sourceReference: args.evidence.sourceReference,
        policySnapshotVersion,
        catalogProductId: args.catalogProductId,
      },
      correlationId: args.correlationId,
    });

    return {
      success: true,
      entitlementId,
      isNew: true,
      previousStatus: undefined,
      outboxJobId,
    };
  },
});

/**
 * Revoke an entitlement.
 *
 * This mutation:
 * 1. Updates entitlement status to the appropriate revoked status
 * 2. Emits outbox jobs for role removal
 * 3. Creates audit event
 *
 * Does NOT delete the entitlement - uses soft delete via status field.
 */
export const revokeEntitlement = mutation({
  args: {
    apiSecret: v.string(),
    entitlementId: v.id('entitlements'),
    reason: RevocationReason,
    details: v.optional(v.string()),
    correlationId: v.optional(v.string()),
  },
  returns: RevokeResult,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const entitlement = await ctx.db.get(args.entitlementId);
    if (!entitlement) {
      throw new Error(`Entitlement not found: ${args.entitlementId}`);
    }

    const previousStatus = entitlement.status;

    // Don't revoke if already in a terminal state
    if (previousStatus !== 'active') {
      return {
        success: false,
        entitlementId: args.entitlementId,
        previousStatus,
        revokedAt: now,
        outboxJobIds: [],
      };
    }

    // Map reason to status
    const newStatus = mapReasonToStatus(args.reason);

    // Update entitlement
    await ctx.db.patch(args.entitlementId, {
      status: newStatus,
      revokedAt: now,
      updatedAt: now,
    });

    // Find all role rules for this product and emit role removal jobs
    const outboxJobIds = await emitRoleRemovalJobs(
      ctx,
      entitlement.tenantId,
      entitlement.subjectId,
      entitlement.productId,
      args.entitlementId,
      args.correlationId,
    );

    // Create audit event
    await createAuditEvent(ctx, {
      tenantId: entitlement.tenantId,
      eventType: 'entitlement.revoked',
      subjectId: entitlement.subjectId,
      entitlementId: args.entitlementId,
      metadata: {
        productId: entitlement.productId,
        reason: args.reason,
        details: args.details,
        previousStatus,
        newStatus,
      },
      correlationId: args.correlationId,
    });

    return {
      success: true,
      entitlementId: args.entitlementId,
      previousStatus,
      revokedAt: now,
      outboxJobIds,
    };
  },
});

/**
 * Revoke all entitlements for a subject in a tenant.
 * Used when user disconnects their last account - no remaining proof of ownership.
 */
export const revokeAllEntitlementsForSubject = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    subjectId: v.id('subjects'),
  },
  returns: v.object({
    revokedCount: v.number(),
    outboxJobIds: v.array(v.id('outbox_jobs')),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const outboxJobIds: Id<'outbox_jobs'>[] = [];

    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_subject', (q) =>
        q.eq('tenantId', args.tenantId).eq('subjectId', args.subjectId),
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    for (const entitlement of entitlements) {
      await ctx.db.patch(entitlement._id, {
        status: 'revoked',
        revokedAt: now,
        updatedAt: now,
      });

      const jobIds = await emitRoleRemovalJobs(
        ctx,
        args.tenantId,
        args.subjectId,
        entitlement.productId,
        entitlement._id,
        'disconnect:all',
      );
      outboxJobIds.push(...jobIds);

      await createAuditEvent(ctx, {
        tenantId: args.tenantId,
        eventType: 'entitlement.revoked',
        subjectId: args.subjectId,
        entitlementId: entitlement._id,
        metadata: {
          productId: entitlement.productId,
          reason: 'manual',
          details: 'Last account disconnected - revoking all entitlements',
          cascadeFromDisconnect: true,
        },
      });
    }

    return {
      revokedCount: entitlements.length,
      outboxJobIds,
    };
  },
});

/**
 * Revoke all entitlements for a subject in a tenant that came from a specific provider.
 * Used when a user disconnects Gumroad/Discord via the verify panel.
 * Emits role_removal jobs so Discord roles are actually removed.
 */
export const revokeEntitlementsForProviderDisconnect = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    subjectId: v.id('subjects'),
    provider: v.string(),
  },
  returns: v.object({
    revokedCount: v.number(),
    outboxJobIds: v.array(v.id('outbox_jobs')),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const outboxJobIds: Id<'outbox_jobs'>[] = [];

    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_subject', (q) =>
        q.eq('tenantId', args.tenantId).eq('subjectId', args.subjectId),
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .filter((q) => q.eq(q.field('sourceProvider'), args.provider))
      .collect();

    for (const entitlement of entitlements) {
      await ctx.db.patch(entitlement._id, {
        status: 'revoked',
        revokedAt: now,
        updatedAt: now,
      });

      const jobIds = await emitRoleRemovalJobs(
        ctx,
        args.tenantId,
        args.subjectId,
        entitlement.productId,
        entitlement._id,
        `disconnect:${args.provider}`,
      );
      outboxJobIds.push(...jobIds);

      await createAuditEvent(ctx, {
        tenantId: args.tenantId,
        eventType: 'entitlement.revoked',
        subjectId: args.subjectId,
        entitlementId: entitlement._id,
        metadata: {
          productId: entitlement.productId,
          reason: 'manual',
          details: `Provider disconnect: ${args.provider}`,
          cascadeFromDisconnect: true,
        },
      });
    }

    return {
      revokedCount: entitlements.length,
      outboxJobIds,
    };
  },
});

/**
 * Revoke all entitlements for a specific product for a subject.
 * Used by /creator-admin moderation unverify to strip verified roles.
 */
export const revokeEntitlementsByProduct = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    discordUserId: v.string(),
    productId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    reason: v.optional(v.string()),
    revokedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .first();

    if (!subject) {
      return { success: false, reason: 'not_found', revokedCount: 0 };
    }

    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_subject', (q) =>
        q.eq('tenantId', args.tenantId).eq('subjectId', subject._id),
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .filter((q) => q.eq(q.field('productId'), args.productId))
      .collect();

    if (entitlements.length === 0) {
      return { success: false, reason: 'no_active_entitlements', revokedCount: 0 };
    }

    const now = Date.now();
    let revokedCount = 0;

    for (const ent of entitlements) {
      await ctx.db.patch(ent._id, {
        status: 'revoked',
        revokedAt: now,
        updatedAt: now,
      });

      await emitRoleRemovalJobs(
        ctx,
        args.tenantId,
        subject._id,
        args.productId,
        ent._id,
        `unverify:${Date.now()}`,
      );

      await createAuditEvent(ctx, {
        tenantId: args.tenantId,
        eventType: 'entitlement.revoked',
        subjectId: subject._id,
        entitlementId: ent._id,
        metadata: {
          productId: args.productId,
          reason: 'manual',
          details: 'Revoked via /creator-admin moderation unverify',
        },
      });

      revokedCount++;
    }

    return { success: true, revokedCount };
  },
});


/**
 * Refresh an entitlement from fresh evidence.
 *
 * Updates the entitlement with new evidence data while preserving the grant.
 * Useful for updating metadata after a re-verification.
 */
export const refreshEntitlement = mutation({
  args: {
    apiSecret: v.string(),
    entitlementId: v.id('entitlements'),
    evidence: ProviderEvidence,
    correlationId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    entitlementId: v.id('entitlements'),
    updatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const entitlement = await ctx.db.get(args.entitlementId);
    if (!entitlement) {
      throw new Error(`Entitlement not found: ${args.entitlementId}`);
    }

    // Update entitlement with fresh evidence
    await ctx.db.patch(args.entitlementId, {
      providerCustomerId: args.evidence.providerCustomerId ?? entitlement.providerCustomerId,
      updatedAt: now,
    });

    // Create audit event
    await createAuditEvent(ctx, {
      tenantId: entitlement.tenantId,
      eventType: 'entitlement.granted', // Using granted as "refresh" for audit trail
      subjectId: entitlement.subjectId,
      entitlementId: args.entitlementId,
      metadata: {
        productId: entitlement.productId,
        action: 'refresh',
        sourceProvider: args.evidence.provider,
      },
      correlationId: args.correlationId,
    });

    return {
      success: true,
      entitlementId: args.entitlementId,
      updatedAt: now,
    };
  },
});

/**
 * Batch grant entitlementments for supported products discovery.
 *
 * Used when autoDiscoverSupportedProductsForRememberedPurchaser is enabled.
 * Finds all products the purchaser has bought from this tenant and grants entitlements.
 */
export const grantEntitlementsForPurchaser = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    subjectId: v.id('subjects'),
    providerCustomerId: v.id('provider_customers'),
    products: v.array(
      v.object({
        productId: v.string(),
        catalogProductId: v.optional(v.id('product_catalog')),
        sourceReference: v.string(),
        purchasedAt: v.optional(v.number()),
      }),
    ),
    correlationId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    grantedCount: v.number(),
    skippedCount: v.number(),
    entitlementIds: v.array(v.id('entitlements')),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const entitlementIds: Id<'entitlements'>[] = [];
    let grantedCount = 0;
    let skippedCount = 0;

    // Get tenant for policy snapshot
    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) {
      throw new Error(`Tenant not found: ${args.tenantId}`);
    }

    const policySnapshotVersion = await getPolicySnapshotVersion(ctx, args.tenantId, tenant);

    for (const product of args.products) {
      // Check for existing entitlement
      const existing = await ctx.db
        .query('entitlements')
        .withIndex('by_tenant_subject', (q) =>
          q.eq('tenantId', args.tenantId).eq('subjectId', args.subjectId),
        )
        .filter((q) => q.eq(q.field('productId'), product.productId))
        .filter((q) => q.eq(q.field('status'), 'active'))
        .first();

      if (existing) {
        skippedCount++;
        continue;
      }

      // Create entitlement
      const entitlementId = await ctx.db.insert('entitlements', {
        tenantId: args.tenantId,
        subjectId: args.subjectId,
        productId: product.productId,
        sourceProvider: 'gumroad', // Default for purchaser discovery
        sourceReference: product.sourceReference,
        providerCustomerId: args.providerCustomerId,
        catalogProductId: product.catalogProductId,
        status: 'active',
        policySnapshotVersion,
        grantedAt: product.purchasedAt ?? now,
        updatedAt: now,
      });

      entitlementIds.push(entitlementId);
      grantedCount++;

      // Emit role sync job for each
      await emitRoleSyncJob(
        ctx,
        args.tenantId,
        args.subjectId,
        entitlementId,
        args.correlationId,
      );
    }

    // Create single audit event for batch
    if (grantedCount > 0) {
      await createAuditEvent(ctx, {
        tenantId: args.tenantId,
        eventType: 'entitlement.granted',
        subjectId: args.subjectId,
        metadata: {
          action: 'batch_grant',
          grantedCount,
          skippedCount,
          productIds: args.products.map((p) => p.productId),
        },
        correlationId: args.correlationId,
      });
    }

    return {
      success: true,
      grantedCount,
      skippedCount,
      entitlementIds,
    };
  },
});

/**
 * Enqueue role sync jobs for all active entitlements for a specific user.
 * Used by the /creator refresh command to force role re-evaluation.
 */
export const enqueueRoleSyncsForUser = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    discordUserId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    jobsCreated: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    // Find subject
    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .first();

    if (!subject) {
      return { success: false, jobsCreated: 0 };
    }

    // Find active entitlements
    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_subject', (q) =>
        q.eq('tenantId', args.tenantId).eq('subjectId', subject._id),
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    let jobsCreated = 0;
    const correlationId = `refresh:${Date.now()}`;

    for (const ent of entitlements) {
      await emitRoleSyncJob(
        ctx,
        args.tenantId,
        subject._id,
        ent._id,
        correlationId,
      );
      jobsCreated++;
    }

    return { success: true, jobsCreated };
  },
});

// ============================================================================
// INTERNAL MUTATIONS
// ============================================================================

/**
 * Internal mutation for system-triggered entitlement expiration.
 * Called by scheduled jobs to expire entitlements past their validity.
 */
export const expireEntitlements = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    expirationThreshold: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
    expiredCount: v.number(),
    entitlementIds: v.array(v.id('entitlements')),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const entitlementIds: Id<'entitlements'>[] = [];
    let expiredCount = 0;

    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) {
      throw new Error(`Tenant not found: ${args.tenantId}`);
    }

    const { gracePeriodHours } = tenant.policy ?? {};
    // revocationBehavior is available via tenant.policy.revocationBehavior if needed for role removal behavior

    // If no grace period is configured, skip expiration (entitlements never expire via this job)
    if (gracePeriodHours == null || gracePeriodHours <= 0) {
      return {
        success: true,
        expiredCount: 0,
        entitlementIds: [],
      };
    }

    const activeEntitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_status', (q) =>
        q.eq('tenantId', args.tenantId).eq('status', 'active'),
      )
      .collect();

    const gracePeriodMs = gracePeriodHours * 3600000;

    for (const entitlement of activeEntitlements) {
      const expiresAt =
        entitlement.expiresAt ??
        entitlement.grantedAt + gracePeriodMs;

      if (now > expiresAt) {
        await ctx.db.patch(entitlement._id, {
          status: 'expired',
          revokedAt: now,
          updatedAt: now,
          expiresAt,
        });

        entitlementIds.push(entitlement._id);
        expiredCount++;

        await emitRoleRemovalJobs(
          ctx,
          entitlement.tenantId,
          entitlement.subjectId,
          entitlement.productId,
          entitlement._id,
          undefined,
        );
      }
    }

    return {
      success: true,
      expiredCount,
      entitlementIds,
    };
  },
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the current policy snapshot version for a tenant.
 * Uses a hash of the policy object for versioning.
 */
async function getPolicySnapshotVersion(
  ctx: { db: { query: Function } },
  tenantId: Id<'tenants'>,
  tenant: Doc<'tenants'>,
): Promise<number> {
  // Simple hash-based versioning
  // Count existing entitlements to get a rough version number
  const existingEntitlements = await (ctx as any).db
    .query('entitlements')
    .withIndex('by_tenant', (q: any) => q.eq('tenantId', tenantId))
    .collect();

  // Use the count as a simple version increment
  // In production, you'd want a proper policy version field on the tenant
  return existingEntitlements.length + 1;
}

/**
 * Map revocation reason to entitlement status.
 */
function mapReasonToStatus(
  reason: 'refund' | 'dispute' | 'expiration' | 'manual' | 'transfer' | 'policy_violation',
): 'revoked' | 'expired' | 'refunded' | 'disputed' {
  switch (reason) {
    case 'refund':
      return 'refunded';
    case 'dispute':
      return 'disputed';
    case 'expiration':
      return 'expired';
    default:
      return 'revoked';
  }
}

/**
 * Emit a role sync job to the outbox.
 */
async function emitRoleSyncJob(
  ctx: { db: { insert: Function; query: Function } },
  tenantId: Id<'tenants'>,
  subjectId: Id<'subjects'>,
  entitlementId: Id<'entitlements'>,
  correlationId?: string,
): Promise<Id<'outbox_jobs'>> {
  const now = Date.now();

  // Get subject to find Discord user ID
  const subject = await (ctx as any).db.get(subjectId);

  const idempotencyKey = `role_sync:${tenantId}:${subjectId}:${entitlementId}:${now}`;

  const outboxJobId = await (ctx as any).db.insert('outbox_jobs', {
    tenantId,
    jobType: 'role_sync',
    payload: {
      subjectId,
      entitlementId,
      discordUserId: subject?.primaryDiscordUserId,
    },
    status: 'pending',
    idempotencyKey,
    targetDiscordUserId: subject?.primaryDiscordUserId,
    retryCount: 0,
    maxRetries: 5,
    createdAt: now,
    updatedAt: now,
  });

  return outboxJobId;
}

/**
 * Emit role removal jobs for all guilds with role rules for this product.
 */
async function emitRoleRemovalJobs(
  ctx: { db: { insert: Function; query: Function } },
  tenantId: Id<'tenants'>,
  subjectId: Id<'subjects'>,
  productId: string,
  entitlementId: Id<'entitlements'>,
  correlationId?: string,
): Promise<Id<'outbox_jobs'>[]> {
  const now = Date.now();
  const outboxJobIds: Id<'outbox_jobs'>[] = [];

  // Find all role rules for this product
  const roleRules = await (ctx as any).db
    .query('role_rules')
    .withIndex('by_tenant', (q: any) => q.eq('tenantId', tenantId))
    .filter((q: any) => q.eq(q.field('productId'), productId))
    .filter((q: any) => q.eq(q.field('enabled'), true))
    .filter((q: any) => q.eq(q.field('removeOnRevoke'), true))
    .collect();

  // Get subject for Discord user ID
  const subject = await (ctx as any).db.get(subjectId);

  for (const rule of roleRules) {
    const idempotencyKey = `role_removal:${tenantId}:${subjectId}:${rule.guildId}:${productId}:${now}`;

    const outboxJobId = await (ctx as any).db.insert('outbox_jobs', {
      tenantId,
      jobType: 'role_removal',
      payload: {
        subjectId,
        entitlementId,
        guildId: rule.guildId,
        roleId: rule.verifiedRoleId,
        discordUserId: subject?.primaryDiscordUserId,
      },
      status: 'pending',
      idempotencyKey,
      targetGuildId: rule.guildId,
      targetDiscordUserId: subject?.primaryDiscordUserId,
      retryCount: 0,
      maxRetries: 5,
      createdAt: now,
      updatedAt: now,
    });

    outboxJobIds.push(outboxJobId);
  }

  return outboxJobIds;
}

/**
 * Create an audit event.
 */
async function createAuditEvent(
  ctx: { db: { insert: Function } },
  params: {
    tenantId: Id<'tenants'>;
    eventType: 'entitlement.granted' | 'entitlement.revoked' | 'discord.role.sync.requested';
    subjectId?: Id<'subjects'>;
    entitlementId?: Id<'entitlements'>;
    metadata?: any;
    correlationId?: string;
  },
): Promise<void> {
  await (ctx as any).db.insert('audit_events', {
    tenantId: params.tenantId,
    eventType: params.eventType,
    actorType: 'system',
    subjectId: params.subjectId,
    entitlementId: params.entitlementId,
    metadata: params.metadata,
    correlationId: params.correlationId,
    createdAt: Date.now(),
  });
}
