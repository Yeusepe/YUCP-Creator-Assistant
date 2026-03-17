/**
 * Manual License Service
 *
 * Provides CRUD operations for manual license management.
 * Uses SHA-256 hashing - license keys are NEVER stored in plaintext.
 */

import { ConvexError, v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internalMutation, mutation, query } from './_generated/server';
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

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get a manual license by ID.
 */
export const getById = query({
  args: { licenseId: v.id('manual_licenses') },
  handler: async (ctx, { licenseId }) => {
    const license = await ctx.db.get(licenseId);
    if (!license) {
      return null;
    }
    // Never return the hash
    const { licenseKeyHash: _, ...rest } = license;
    return rest;
  },
});

/**
 * Find a manual license by key hash.
 */
export const findByKeyHash = query({
  args: { licenseKeyHash: v.string() },
  handler: async (ctx, { licenseKeyHash }) => {
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
    authUserId: v.string(),
    productId: v.optional(v.string()),
    status: v.optional(ManualLicenseStatus),
  },
  handler: async (ctx, { authUserId, productId, status }) => {
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
  args: { authUserId: v.string() },
  handler: async (ctx, { authUserId }) => {
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
    licenseId: v.id('manual_licenses'),
    authUserId: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { apiSecret, licenseId, authUserId, reason }) => {
    requireApiSecret(apiSecret);
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
    licenseId: v.id('manual_licenses'),
    status: ManualLicenseStatus,
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { apiSecret, licenseId, status, reason }) => {
    requireApiSecret(apiSecret);
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
  handler: async (ctx, { apiSecret, authUserId, licenses }) => {
    requireApiSecret(apiSecret);
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
  args: { apiSecret: v.string(), authUserId: v.string(), licenseId: v.id('manual_licenses') },
  handler: async (ctx, { apiSecret, authUserId, licenseId }) => {
    requireApiSecret(apiSecret);
    const license = await ctx.db.get(licenseId);
    if (!license) throw new Error(`Manual license not found: ${licenseId}`);
    if (license.authUserId !== authUserId) throw new ConvexError('Unauthorized: not the owner');
    await ctx.db.delete(licenseId);
    return { success: true };
  },
});

/**
 * Validate a license by hash.
 */
export const validateByHash = query({
  args: ValidateManualLicenseInput,
  handler: async (ctx, { licenseKeyHash, productId, authUserId }) => {
    const license = await ctx.db
      .query('manual_licenses')
      .withIndex('by_license_key_hash', (q) => q.eq('licenseKeyHash', licenseKeyHash))
      .first();

    if (!license) {
      return { valid: false, reason: 'not_found' };
    }

    // Check product match
    if (license.productId !== productId) {
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
