/**
 * Manual License Service
 *
 * Provides CRUD operations for manual license management.
 * Uses SHA-256 hashing - license keys are NEVER stored in plaintext.
 */

import { ConvexError, v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internalMutation, mutation, query } from './_generated/server';
import {
  ApiActorBindingV,
  requireDelegatedAuthUserActor,
  requireServiceActor,
} from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';

// ============================================================================
// TYPES
// ============================================================================

/** Manual license status values */
export const ManualLicenseStatus = v.union(
  v.literal('active'),
  v.literal('revoked'),
  v.literal('expired'),
  v.literal('exhausted')
);

/** Input for creating a manual license */
export const CreateManualLicenseInput = v.object({
  authUserId: v.string(),
  licenseKeyHash: v.string(),
  productId: v.string(),
  catalogProductId: v.optional(v.id('product_catalog')),
  maxUses: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  notes: v.optional(v.string()),
  buyerEmail: v.optional(v.string()),
});

/** Result of creating a manual license */
export const CreateManualLicenseResult = v.object({
  licenseId: v.id('manual_licenses'),
});

/** Input for validating a manual license */
export const ValidateManualLicenseInput = v.object({
  licenseKeyHash: v.string(),
  productId: v.string(),
  authUserId: v.string(),
});

/** Result of validating a manual license */
export const ValidateManualLicenseResult = v.object({
  valid: v.boolean(),
  licenseId: v.optional(v.id('manual_licenses')),
  status: v.optional(ManualLicenseStatus),
  currentUses: v.optional(v.number()),
  maxUses: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  reason: v.optional(v.string()),
});

/** Input for using a manual license */
export const UseManualLicenseInput = v.object({
  licenseId: v.id('manual_licenses'),
});

/** Input for revoking a manual license */
export const RevokeManualLicenseInput = v.object({
  licenseId: v.id('manual_licenses'),
  authUserId: v.string(),
  reason: v.optional(v.string()),
});

/** Input for bulk creating manual licenses */
export const BulkCreateManualLicensesInput = v.object({
  authUserId: v.string(),
  licenses: v.array(
    v.object({
      licenseKeyHash: v.string(),
      productId: v.string(),
      maxUses: v.optional(v.number()),
      expiresAt: v.optional(v.number()),
      notes: v.optional(v.string()),
      buyerEmail: v.optional(v.string()),
    })
  ),
});

const MAX_MANUAL_LICENSES_PER_BULK_REQUEST = 100;

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get a manual license by ID.
 * Requires apiSecret and scoped to the requesting tenant.
 */
export const getById = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    licenseId: v.id('manual_licenses'),
  },
  handler: async (ctx, { apiSecret, actor, authUserId, licenseId }) => {
    requireApiSecret(apiSecret);
    await requireDelegatedAuthUserActor(actor, authUserId);
    const license = await ctx.db.get(licenseId);
    if (!license) {
      return null;
    }
    // Scope to requesting tenant to prevent cross-tenant data access
    if (license.authUserId !== authUserId) {
      return null;
    }
    // Never return the hash
    const { licenseKeyHash: _, ...rest } = license;
    return rest;
  },
});

/**
 * Find a manual license by key hash.
 * Requires apiSecret. Scoped by the hash itself, no cross-tenant enumeration possible
 * since only the holder of the raw key can compute the correct hash.
 */
export const findByKeyHash = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    licenseKeyHash: v.string(),
  },
  handler: async (ctx, { apiSecret, actor, licenseKeyHash }) => {
    requireApiSecret(apiSecret);
    await requireServiceActor(actor, ['manual-licenses:service']);
    const license = await ctx.db
      .query('manual_licenses')
      .withIndex('by_license_key_hash', (q) => q.eq('licenseKeyHash', licenseKeyHash))
      .first();

    if (!license) {
      return null;
    }

    // Never return the hash
    const { licenseKeyHash: _, ...rest } = license;
    return rest;
  },
});

/**
 * List manual licenses for a creator.
 */
export const listByTenant = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    productId: v.optional(v.string()),
    status: v.optional(ManualLicenseStatus),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { apiSecret, actor, authUserId, productId, status }) => {
    requireApiSecret(apiSecret);
    await requireDelegatedAuthUserActor(actor, authUserId);
    const query = ctx.db
      .query('manual_licenses')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId));

    const licenses = await query.collect();

    let filtered = licenses;

    if (productId) {
      filtered = filtered.filter((l) => l.productId === productId);
    }

    if (status) {
      filtered = filtered.filter((l) => l.status === status);
    }

    // Never return hashes
    return filtered.map(({ licenseKeyHash: _, ...rest }) => rest);
  },
});

/**
 * Get statistics for manual licenses.
 */
export const getStats = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
  },
  handler: async (ctx, { apiSecret, actor, authUserId }) => {
    requireApiSecret(apiSecret);
    await requireDelegatedAuthUserActor(actor, authUserId);
    const licenses = await ctx.db
      .query('manual_licenses')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
      .collect();

    return {
      total: licenses.length,
      active: licenses.filter((l) => l.status === 'active').length,
      revoked: licenses.filter((l) => l.status === 'revoked').length,
      expired: licenses.filter((l) => l.status === 'expired').length,
      exhausted: licenses.filter((l) => l.status === 'exhausted').length,
    };
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a new manual license.
 * Requires apiSecret - called by API server only.
 */
export const create = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    licenseKeyHash: v.string(),
    productId: v.string(),
    catalogProductId: v.optional(v.id('product_catalog')),
    maxUses: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    notes: v.optional(v.string()),
    buyerEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const now = Date.now();

    const licenseId = await ctx.db.insert('manual_licenses', {
      authUserId: args.authUserId,
      licenseKeyHash: args.licenseKeyHash,
      productId: args.productId,
      catalogProductId: args.catalogProductId,
      maxUses: args.maxUses,
      currentUses: 0,
      status: 'active',
      expiresAt: args.expiresAt,
      notes: args.notes,
      buyerEmail: args.buyerEmail,
      createdAt: now,
      updatedAt: now,
    });

    return { licenseId };
  },
});

/**
 * Increment usage count for a license.
 */
export const incrementUsage = internalMutation({
  args: { licenseId: v.id('manual_licenses') },
  handler: async (ctx, { licenseId }) => {
    const license = await ctx.db.get(licenseId);
    if (!license) {
      throw new Error('License not found');
    }

    const now = Date.now();
    const newUses = license.currentUses + 1;

    // Check if this would exhaust the license
    let newStatus = license.status;
    if (license.maxUses !== undefined && newUses >= license.maxUses) {
      newStatus = 'exhausted';
    }

    await ctx.db.patch(licenseId, {
      currentUses: newUses,
      status: newStatus,
      updatedAt: now,
    });

    const updated = await ctx.db.get(licenseId);
    const { licenseKeyHash: _, ...rest } = updated!;
    return rest;
  },
});

/**
 * Revoke a manual license.
 * Requires apiSecret - called by API server only.
 */
export const revoke = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    licenseId: v.id('manual_licenses'),
    authUserId: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { apiSecret, actor, licenseId, authUserId, reason }) => {
    requireApiSecret(apiSecret);
    await requireDelegatedAuthUserActor(actor, authUserId);
    const license = await ctx.db.get(licenseId);
    if (!license) {
      throw new Error('License not found');
    }

    // Verify creator ownership
    if (license.authUserId !== authUserId) {
      throw new Error('License not found');
    }

    const now = Date.now();

    await ctx.db.patch(licenseId, {
      status: 'revoked',
      notes: reason ? `${license.notes || ''}\nRevoked: ${reason}`.trim() : license.notes,
      updatedAt: now,
    });

    const updated = await ctx.db.get(licenseId);
    const { licenseKeyHash: _, ...rest } = updated!;
    return rest;
  },
});

/**
 * Update license status (used for expiry detection).
 * Requires apiSecret - called by API server only.
 */
export const updateStatus = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    licenseId: v.id('manual_licenses'),
    status: ManualLicenseStatus,
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { apiSecret, actor, licenseId, status, reason }) => {
    requireApiSecret(apiSecret);
    await requireServiceActor(actor, ['manual-licenses:service']);
    const license = await ctx.db.get(licenseId);
    if (!license) {
      throw new Error('License not found');
    }

    const now = Date.now();

    await ctx.db.patch(licenseId, {
      status,
      notes: reason ? `${license.notes || ''}\n${reason}`.trim() : license.notes,
      updatedAt: now,
    });

    const updated = await ctx.db.get(licenseId);
    const { licenseKeyHash: _, ...rest } = updated!;
    return rest;
  },
});

/**
 * Bulk create manual licenses.
 * Requires apiSecret - called by API server only.
 */
export const bulkCreate = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    licenses: v.array(
      v.object({
        licenseKeyHash: v.string(),
        productId: v.string(),
        maxUses: v.optional(v.number()),
        expiresAt: v.optional(v.number()),
        notes: v.optional(v.string()),
        buyerEmail: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, { apiSecret, actor, authUserId, licenses }) => {
    requireApiSecret(apiSecret);
    await requireDelegatedAuthUserActor(actor, authUserId);
    if (licenses.length === 0) {
      throw new ConvexError('At least one manual license is required');
    }
    if (licenses.length > MAX_MANUAL_LICENSES_PER_BULK_REQUEST) {
      throw new ConvexError(
        `Maximum of ${MAX_MANUAL_LICENSES_PER_BULK_REQUEST} licenses per bulk request`
      );
    }
    const now = Date.now();
    const results: Id<'manual_licenses'>[] = [];

    for (const input of licenses) {
      const licenseId = await ctx.db.insert('manual_licenses', {
        authUserId,
        licenseKeyHash: input.licenseKeyHash,
        productId: input.productId,
        maxUses: input.maxUses,
        currentUses: 0,
        status: 'active',
        expiresAt: input.expiresAt,
        notes: input.notes,
        buyerEmail: input.buyerEmail,
        createdAt: now,
        updatedAt: now,
      });
      results.push(licenseId);
    }

    return { created: results.length, licenseIds: results };
  },
});

/**
 * Delete a manual license (hard delete - use revoke instead for audit trail).
 * Requires apiSecret - called by API server only.
 */
export const hardDelete = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    licenseId: v.id('manual_licenses'),
  },
  handler: async (ctx, { apiSecret, actor, authUserId, licenseId }) => {
    requireApiSecret(apiSecret);
    await requireDelegatedAuthUserActor(actor, authUserId);
    const license = await ctx.db.get(licenseId);
    if (!license) throw new Error(`Manual license not found: ${licenseId}`);
    if (license.authUserId !== authUserId) throw new ConvexError('Unauthorized: not the owner');
    await ctx.db.delete(licenseId);
    return { success: true };
  },
});

/**
 * Validate a license by hash.
 * Requires apiSecret. The licenseKeyHash field was previously named `hashedKey`
 * in the API server call, both names are accepted for backward compatibility,
 * but the canonical field name in Convex is `licenseKeyHash`.
 */
export const validateByHash = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    licenseKeyHash: v.optional(v.string()),
    /** @deprecated Use licenseKeyHash. Accepted for backward compat with API server callers. */
    hashedKey: v.optional(v.string()),
    productId: v.optional(v.string()),
    authUserId: v.string(),
  },
  handler: async (ctx, { apiSecret, actor, licenseKeyHash, hashedKey, productId, authUserId }) => {
    requireApiSecret(apiSecret);
    await requireDelegatedAuthUserActor(actor, authUserId);
    const resolvedHash = licenseKeyHash ?? hashedKey;
    if (!resolvedHash) {
      return { valid: false as const, reason: 'not_found' };
    }
    const license = await ctx.db
      .query('manual_licenses')
      .withIndex('by_license_key_hash', (q) => q.eq('licenseKeyHash', resolvedHash))
      .first();

    if (!license) {
      return { valid: false, reason: 'not_found' };
    }

    // Check product match (only if productId was supplied)
    if (productId !== undefined && license.productId !== productId) {
      return { valid: false, reason: 'wrong_product' };
    }

    // Check creator match
    if (license.authUserId !== authUserId) {
      return { valid: false, reason: 'not_found' };
    }

    // Check status
    if (license.status === 'revoked') {
      return {
        valid: false,
        licenseId: license._id,
        status: license.status,
        reason: 'revoked',
      };
    }

    // Check expiry
    if (license.expiresAt && Date.now() > license.expiresAt) {
      return {
        valid: false,
        licenseId: license._id,
        status: 'expired',
        expiresAt: license.expiresAt,
        reason: 'expired',
      };
    }

    // Check usage limit
    if (license.maxUses !== undefined && license.currentUses >= license.maxUses) {
      return {
        valid: false,
        licenseId: license._id,
        status: 'exhausted',
        currentUses: license.currentUses,
        maxUses: license.maxUses,
        reason: 'exhausted',
      };
    }

    return {
      valid: true,
      licenseId: license._id,
      status: license.status,
      currentUses: license.currentUses,
      maxUses: license.maxUses,
      expiresAt: license.expiresAt,
    };
  },
});
