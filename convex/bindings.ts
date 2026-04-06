/**
 * Binding Service - Convex Mutations and Queries
 *
 * Implements activation, revocation, transfer, quarantine, and lookup rules.
 * Enforces one active ownership binding per provider account where policy requires it.
 *
 * Business Rules:
 * - A provider account can only have ONE active ownership binding per tenant
 * - Transfer requires cooldown period (default 24 hours)
 * - Quarantine blocks new grants until reviewed
 * - Revocation cascades to entitlements
 */

import {
  calculateRemainingCooldown,
  canModifyBinding,
  canTransferBinding,
  createBindingAuditMetadata,
  getEffectivePolicy,
  isBindingActive,
  type BindingPolicy as SharedBindingPolicy,
} from '@yucp/shared/binding/service';
import { ConvexError, v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalQuery, mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';

// ============================================================================
// TYPES
// ============================================================================

const BindingType = v.union(
  v.literal('ownership'),
  v.literal('verification'),
  v.literal('manual_override')
);

const BindingStatus = v.union(
  v.literal('pending'),
  v.literal('active'),
  v.literal('revoked'),
  v.literal('transferred'),
  v.literal('quarantined')
);

const ActorType = v.union(v.literal('subject'), v.literal('system'), v.literal('admin'));

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get tenant policy with defaults
 */
async function getTenantPolicy(
  ctx: MutationCtx,
  authUserId: string
): Promise<Required<SharedBindingPolicy>> {
  const profile = await ctx.db
    .query('creator_profiles')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
    .first();

  return getEffectivePolicy(profile?.policy ?? undefined);
}

async function requireActiveSubject(ctx: MutationCtx, subjectId: Id<'subjects'>) {
  const subject = await ctx.db.get(subjectId);
  if (!subject) {
    throw new ConvexError('Subject not found');
  }
  if (subject.status !== 'active') {
    throw new ConvexError(`Subject is not active: ${subject.status}`);
  }
  return subject;
}

/**
 * Create an audit event for binding operations
 */
async function createAuditEvent(
  ctx: MutationCtx,
  params: {
    authUserId: string;
    eventType: 'binding.created' | 'binding.activated' | 'binding.revoked' | 'binding.transferred';
    actorType: 'subject' | 'system' | 'admin';
    actorId?: string;
    subjectId?: Id<'subjects'>;
    externalAccountId?: Id<'external_accounts'>;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await ctx.db.insert('audit_events', {
    authUserId: params.authUserId,
    eventType: params.eventType,
    actorType: params.actorType,
    actorId: params.actorId,
    subjectId: params.subjectId,
    externalAccountId: params.externalAccountId,
    metadata: params.metadata,
    createdAt: Date.now(),
  });
}

/**
 * Revoke all entitlements associated with a binding's subject
 */
async function revokeEntitlementsForSubject(
  ctx: MutationCtx,
  authUserId: string,
  subjectId: Id<'subjects'>,
  reason: string
): Promise<number> {
  const entitlements = await ctx.db
    .query('entitlements')
    .withIndex('by_auth_user_subject', (q) =>
      q.eq('authUserId', authUserId).eq('subjectId', subjectId)
    )
    .filter((q) => q.eq(q.field('status'), 'active'))
    .take(1000);

  const now = Date.now();
  for (const entitlement of entitlements) {
    await ctx.db.patch(entitlement._id, {
      status: 'revoked',
      revokedAt: now,
      updatedAt: now,
    });

    // Create audit event for entitlement revocation
    await ctx.db.insert('audit_events', {
      authUserId,
      eventType: 'entitlement.revoked',
      actorType: 'system',
      subjectId,
      entitlementId: entitlement._id,
      metadata: { reason, cascadeFromBinding: true },
      createdAt: now,
    });
  }

  return entitlements.length;
}

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Activate a binding - create or reactivate
 *
 * Creates a new binding or reactivates an existing one.
 * Enforces one active ownership binding per provider account.
 */
export const activateBinding = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    externalAccountId: v.id('external_accounts'),
    bindingType: BindingType,
    createdBy: v.optional(v.id('subjects')),
    reason: v.optional(v.string()),
    actorType: v.optional(ActorType),
    actorId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    bindingId: v.id('bindings'),
    isNew: v.boolean(),
    previousStatus: v.optional(BindingStatus),
    conflict: v.optional(
      v.object({
        existingBindingId: v.id('bindings'),
        message: v.string(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const actorType = args.actorType || 'system';
    await requireActiveSubject(ctx, args.subjectId);

    // Check for existing active ownership binding for this external account
    if (args.bindingType === 'ownership') {
      const existingOwnership = await ctx.db
        .query('bindings')
        .withIndex('by_auth_user_external', (q) =>
          q.eq('authUserId', args.authUserId).eq('externalAccountId', args.externalAccountId)
        )
        .filter((q) =>
          q.and(
            q.eq(q.field('bindingType'), 'ownership'),
            q.or(q.eq(q.field('status'), 'active'), q.eq(q.field('status'), 'pending'))
          )
        )
        .first();

      if (existingOwnership && existingOwnership.subjectId !== args.subjectId) {
        // Conflict: another subject already has ownership
        return {
          success: false,
          bindingId: existingOwnership._id,
          isNew: false,
          previousStatus: existingOwnership.status,
          conflict: {
            existingBindingId: existingOwnership._id,
            message: 'This provider account already has an active ownership binding',
          },
        };
      }
    }

    // Check for existing binding for this subject + external account
    const existingBinding = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
      )
      .filter((q) => q.eq(q.field('externalAccountId'), args.externalAccountId))
      .first();

    if (existingBinding) {
      // Reactivate or update existing binding
      const previousStatus = existingBinding.status;

      // Reactivate bindings that are no longer in the modifiable active/pending states.
      if (!canModifyBinding(previousStatus as Parameters<typeof canModifyBinding>[0])) {
        await ctx.db.patch(existingBinding._id, {
          status: 'active',
          bindingType: args.bindingType,
          reason: args.reason,
          version: existingBinding.version + 1,
          updatedAt: now,
        });

        // Create audit event
        await createAuditEvent(ctx, {
          authUserId: args.authUserId,
          eventType: 'binding.activated',
          actorType,
          actorId: args.actorId,
          subjectId: args.subjectId,
          externalAccountId: args.externalAccountId,
          metadata: createBindingAuditMetadata('activate', existingBinding._id, {
            previousStatus,
            bindingType: args.bindingType,
            reason: args.reason,
          }),
        });

        return {
          success: true,
          bindingId: existingBinding._id,
          isNew: false,
          previousStatus,
          conflict: undefined,
        };
      }

      // Binding already active or pending - just return it
      return {
        success: true,
        bindingId: existingBinding._id,
        isNew: false,
        previousStatus,
        conflict: undefined,
      };
    }

    // Create new binding
    const bindingId = await ctx.db.insert('bindings', {
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      externalAccountId: args.externalAccountId,
      bindingType: args.bindingType,
      status: 'active',
      createdBy: args.createdBy,
      reason: args.reason,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    // Create audit event
    await createAuditEvent(ctx, {
      authUserId: args.authUserId,
      eventType: 'binding.created',
      actorType,
      actorId: args.actorId,
      subjectId: args.subjectId,
      externalAccountId: args.externalAccountId,
      metadata: {
        bindingId,
        bindingType: args.bindingType,
        reason: args.reason,
      },
    });

    return {
      success: true,
      bindingId,
      isNew: true,
      previousStatus: undefined,
      conflict: undefined,
    };
  },
});

/**
 * Revoke a binding
 *
 * Soft deletes the binding with a reason and cascades to entitlements.
 */
export const revokeBinding = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    bindingId: v.id('bindings'),
    reason: v.string(),
    revokedBy: v.optional(v.id('subjects')),
    actorType: v.optional(ActorType),
    actorId: v.optional(v.string()),
    cascadeToEntitlements: v.optional(v.boolean()),
  },
  returns: v.object({
    success: v.boolean(),
    bindingId: v.id('bindings'),
    entitlementsRevoked: v.number(),
    previousStatus: BindingStatus,
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const actorType = args.actorType || 'system';
    const cascadeToEntitlements = args.cascadeToEntitlements ?? true;

    const binding = await ctx.db.get(args.bindingId);
    if (!binding) {
      throw new Error(`Binding not found: ${args.bindingId}`);
    }

    if (binding.authUserId !== args.authUserId) {
      throw new ConvexError('Unauthorized: not the owner');
    }

    const previousStatus = binding.status;

    // Check if binding can be revoked
    if (previousStatus === 'revoked') {
      return {
        success: true,
        bindingId: args.bindingId,
        entitlementsRevoked: 0,
        previousStatus,
      };
    }

    // Update binding status
    await ctx.db.patch(args.bindingId, {
      status: 'revoked',
      reason: args.reason,
      version: binding.version + 1,
      updatedAt: now,
    });

    // Cascade to entitlements if requested
    let entitlementsRevoked = 0;
    if (cascadeToEntitlements) {
      entitlementsRevoked = await revokeEntitlementsForSubject(
        ctx,
        binding.authUserId,
        binding.subjectId,
        args.reason
      );
    }

    // Create audit event
    await createAuditEvent(ctx, {
      authUserId: binding.authUserId,
      eventType: 'binding.revoked',
      actorType,
      actorId: args.actorId,
      subjectId: binding.subjectId,
      externalAccountId: binding.externalAccountId,
      metadata: createBindingAuditMetadata('revoke', args.bindingId, {
        reason: args.reason,
        entitlementsRevoked,
        cascadeToEntitlements,
      }),
    });

    return {
      success: true,
      bindingId: args.bindingId,
      entitlementsRevoked,
      previousStatus,
    };
  },
});

/**
 * Transfer a binding to a new subject
 *
 * Moves the binding to a new subject after enforcing cooldown period.
 * The old binding is marked as 'transferred' and a new one is created.
 */
export const transferBinding = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    bindingId: v.id('bindings'),
    newSubjectId: v.id('subjects'),
    transferredBy: v.optional(v.id('subjects')),
    reason: v.optional(v.string()),
    actorType: v.optional(ActorType),
    actorId: v.optional(v.string()),
    bypassCooldown: v.optional(v.boolean()),
  },
  returns: v.object({
    success: v.boolean(),
    oldBindingId: v.id('bindings'),
    newBindingId: v.optional(v.id('bindings')),
    cooldownRemaining: v.optional(v.number()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const actorType = args.actorType || 'system';

    const binding = await ctx.db.get(args.bindingId);
    if (!binding) {
      throw new Error(`Binding not found: ${args.bindingId}`);
    }

    if (binding.authUserId !== args.authUserId) {
      throw new ConvexError('Unauthorized: not the owner');
    }

    // Check if binding can be transferred
    if (!isBindingActive(binding.status as Parameters<typeof isBindingActive>[0])) {
      return {
        success: false,
        oldBindingId: args.bindingId,
        newBindingId: undefined,
        cooldownRemaining: undefined,
        error: `Cannot transfer binding with status: ${binding.status}`,
      };
    }

    // Get tenant policy
    const policy = await getTenantPolicy(ctx, binding.authUserId);

    // Check if transfers are allowed
    if (
      !args.bypassCooldown &&
      !canTransferBinding(binding.status as Parameters<typeof canTransferBinding>[0], policy)
    ) {
      return {
        success: false,
        oldBindingId: args.bindingId,
        newBindingId: undefined,
        cooldownRemaining: undefined,
        error: 'Transfers are not allowed by tenant policy',
      };
    }

    // Check cooldown unless bypassed
    if (!args.bypassCooldown) {
      const cooldownRemaining = calculateRemainingCooldown(
        binding.createdAt,
        policy.transferCooldownHours
      );

      if (cooldownRemaining > 0) {
        return {
          success: false,
          oldBindingId: args.bindingId,
          newBindingId: undefined,
          cooldownRemaining,
          error: `Cooldown period not elapsed. ${Math.ceil(cooldownRemaining / (60 * 60 * 1000))} hours remaining.`,
        };
      }
    }

    // Check for existing ownership binding for the new subject with this external account
    const existingForNewSubject = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', binding.authUserId).eq('subjectId', args.newSubjectId)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field('externalAccountId'), binding.externalAccountId),
          q.eq(q.field('status'), 'active')
        )
      )
      .first();

    if (existingForNewSubject) {
      return {
        success: false,
        oldBindingId: args.bindingId,
        newBindingId: undefined,
        cooldownRemaining: undefined,
        error: 'New subject already has an active binding for this external account',
      };
    }

    // Mark old binding as transferred
    await ctx.db.patch(args.bindingId, {
      status: 'transferred',
      reason: args.reason || 'Transferred to new subject',
      version: binding.version + 1,
      updatedAt: now,
    });

    // Create new binding for new subject
    const newBindingId = await ctx.db.insert('bindings', {
      authUserId: binding.authUserId,
      subjectId: args.newSubjectId,
      externalAccountId: binding.externalAccountId,
      bindingType: binding.bindingType,
      status: 'active',
      createdBy: args.transferredBy,
      reason: args.reason || `Transferred from ${binding.subjectId}`,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    // Create audit events
    await createAuditEvent(ctx, {
      authUserId: binding.authUserId,
      eventType: 'binding.transferred',
      actorType,
      actorId: args.actorId,
      subjectId: binding.subjectId,
      externalAccountId: binding.externalAccountId,
      metadata: createBindingAuditMetadata('transfer', args.bindingId, {
        oldBindingId: args.bindingId,
        newBindingId,
        newSubjectId: args.newSubjectId,
        reason: args.reason,
        bypassCooldown: args.bypassCooldown,
      }),
    });

    return {
      success: true,
      oldBindingId: args.bindingId,
      newBindingId,
      cooldownRemaining: undefined,
      error: undefined,
    };
  },
});

/**
 * Quarantine a binding
 *
 * Marks a binding for review and blocks new grants until reviewed.
 */
export const quarantineBinding = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    bindingId: v.id('bindings'),
    reason: v.string(),
    quarantinedBy: v.optional(v.id('subjects')),
    actorType: v.optional(ActorType),
    actorId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    bindingId: v.id('bindings'),
    previousStatus: BindingStatus,
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const actorType = args.actorType || 'system';

    const binding = await ctx.db.get(args.bindingId);
    if (!binding) {
      throw new Error(`Binding not found: ${args.bindingId}`);
    }

    if (binding.authUserId !== args.authUserId) {
      throw new ConvexError('Unauthorized: not the owner');
    }

    const previousStatus = binding.status;

    // Check if binding is already quarantined
    if (previousStatus === 'quarantined') {
      return {
        success: true,
        bindingId: args.bindingId,
        previousStatus,
      };
    }

    // Only active or pending bindings can be quarantined
    if (!canModifyBinding(previousStatus as Parameters<typeof canModifyBinding>[0])) {
      return {
        success: false,
        bindingId: args.bindingId,
        previousStatus,
      };
    }

    // Update binding status
    await ctx.db.patch(args.bindingId, {
      status: 'quarantined',
      reason: args.reason,
      version: binding.version + 1,
      updatedAt: now,
    });

    // Create audit event
    await createAuditEvent(ctx, {
      authUserId: binding.authUserId,
      eventType: 'binding.revoked', // Using existing event type for quarantine
      actorType,
      actorId: args.actorId,
      subjectId: binding.subjectId,
      externalAccountId: binding.externalAccountId,
      metadata: createBindingAuditMetadata('quarantine', args.bindingId, {
        quarantineReason: args.reason,
        previousStatus,
      }),
    });

    return {
      success: true,
      bindingId: args.bindingId,
      previousStatus,
    };
  },
});

/**
 * Release a binding from quarantine
 *
 * Restores a quarantined binding to active status after review.
 */
export const releaseFromQuarantine = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    bindingId: v.id('bindings'),
    releasedBy: v.optional(v.id('subjects')),
    actorType: v.optional(ActorType),
    actorId: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    bindingId: v.id('bindings'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const actorType = args.actorType || 'system';

    const binding = await ctx.db.get(args.bindingId);
    if (!binding) {
      throw new Error(`Binding not found: ${args.bindingId}`);
    }

    if (binding.authUserId !== args.authUserId) {
      throw new ConvexError('Unauthorized: not the owner');
    }

    if (binding.status !== 'quarantined') {
      throw new Error(`Binding is not quarantined: ${args.bindingId}`);
    }

    // Update binding status
    await ctx.db.patch(args.bindingId, {
      status: 'active',
      reason: args.notes || 'Released from quarantine',
      version: binding.version + 1,
      updatedAt: now,
    });

    // Create audit event
    await createAuditEvent(ctx, {
      authUserId: binding.authUserId,
      eventType: 'binding.activated',
      actorType,
      actorId: args.actorId,
      subjectId: binding.subjectId,
      externalAccountId: binding.externalAccountId,
      metadata: createBindingAuditMetadata('activate', args.bindingId, {
        releasedFromQuarantine: true,
        notes: args.notes,
      }),
    });

    return {
      success: true,
      bindingId: args.bindingId,
    };
  },
});

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get all bindings for a subject
 */
export const getBindingsBySubject = internalQuery({
  args: {
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    includeInactive: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      _id: v.id('bindings'),
      _creationTime: v.number(),
      authUserId: v.string(),
      subjectId: v.id('subjects'),
      externalAccountId: v.id('external_accounts'),
      bindingType: BindingType,
      status: BindingStatus,
      createdBy: v.optional(v.id('subjects')),
      reason: v.optional(v.string()),
      version: v.number(),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const includeInactive = args.includeInactive ?? false;

    let query = ctx.db
      .query('bindings')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
      );

    if (!includeInactive) {
      query = query.filter((q) =>
        q.or(q.eq(q.field('status'), 'active'), q.eq(q.field('status'), 'pending'))
      );
    }

    return await query.take(1000);
  },
});

/**
 * Get all bindings for an external account
 */
export const getBindingsByExternalAccount = internalQuery({
  args: {
    authUserId: v.string(),
    externalAccountId: v.id('external_accounts'),
    includeInactive: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      _id: v.id('bindings'),
      _creationTime: v.number(),
      authUserId: v.string(),
      subjectId: v.id('subjects'),
      externalAccountId: v.id('external_accounts'),
      bindingType: BindingType,
      status: BindingStatus,
      createdBy: v.optional(v.id('subjects')),
      reason: v.optional(v.string()),
      version: v.number(),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const includeInactive = args.includeInactive ?? false;

    let query = ctx.db
      .query('bindings')
      .withIndex('by_auth_user_external', (q) =>
        q.eq('authUserId', args.authUserId).eq('externalAccountId', args.externalAccountId)
      );

    if (!includeInactive) {
      query = query.filter((q) =>
        q.or(q.eq(q.field('status'), 'active'), q.eq(q.field('status'), 'pending'))
      );
    }

    return await query.take(1000);
  },
});

/**
 * Get the active ownership binding for an external account
 * Used to enforce one active ownership per provider account
 */
export const getActiveOwnershipBinding = internalQuery({
  args: {
    authUserId: v.string(),
    externalAccountId: v.id('external_accounts'),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      binding: v.object({
        _id: v.id('bindings'),
        _creationTime: v.number(),
        authUserId: v.string(),
        subjectId: v.id('subjects'),
        externalAccountId: v.id('external_accounts'),
        bindingType: BindingType,
        status: BindingStatus,
        createdBy: v.optional(v.id('subjects')),
        reason: v.optional(v.string()),
        version: v.number(),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
    }),
    v.object({
      found: v.literal(false),
      binding: v.null(),
    })
  ),
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_external', (q) =>
        q.eq('authUserId', args.authUserId).eq('externalAccountId', args.externalAccountId)
      )
      .filter((q) =>
        q.and(q.eq(q.field('bindingType'), 'ownership'), q.eq(q.field('status'), 'active'))
      )
      .first();

    if (!binding) {
      return { found: false as const, binding: null };
    }

    return { found: true as const, binding };
  },
});

/**
 * Get a single binding by ID
 */
export const getBinding = internalQuery({
  args: {
    bindingId: v.id('bindings'),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      binding: v.object({
        _id: v.id('bindings'),
        _creationTime: v.number(),
        authUserId: v.string(),
        subjectId: v.id('subjects'),
        externalAccountId: v.id('external_accounts'),
        bindingType: BindingType,
        status: BindingStatus,
        createdBy: v.optional(v.id('subjects')),
        reason: v.optional(v.string()),
        version: v.number(),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
    }),
    v.object({
      found: v.literal(false),
      binding: v.null(),
    })
  ),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);

    if (!binding) {
      return { found: false as const, binding: null };
    }

    return { found: true as const, binding };
  },
});

/**
 * Check if a subject has an active ownership binding for an external account
 */
export const hasActiveOwnershipBinding = internalQuery({
  args: {
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    externalAccountId: v.id('external_accounts'),
  },
  returns: v.object({
    hasBinding: v.boolean(),
    bindingId: v.optional(v.id('bindings')),
  }),
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field('externalAccountId'), args.externalAccountId),
          q.eq(q.field('bindingType'), 'ownership'),
          q.eq(q.field('status'), 'active')
        )
      )
      .first();

    return {
      hasBinding: binding !== null,
      bindingId: binding?._id,
    };
  },
});

/**
 * Get all bindings for a tenant (admin view)
 */
export const getBindingsByTenant = internalQuery({
  args: {
    authUserId: v.string(),
    status: v.optional(BindingStatus),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id('bindings'),
      _creationTime: v.number(),
      authUserId: v.string(),
      subjectId: v.id('subjects'),
      externalAccountId: v.id('external_accounts'),
      bindingType: BindingType,
      status: BindingStatus,
      createdBy: v.optional(v.id('subjects')),
      reason: v.optional(v.string()),
      version: v.number(),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 100, 500);

    let query = ctx.db
      .query('bindings')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId));

    if (args.status) {
      query = query.filter((q) => q.eq(q.field('status'), args.status));
    }

    return await query.take(limit);
  },
});

// ============================================================================
// PUBLIC API QUERIES
// ============================================================================

export const listByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subjectId: v.optional(v.string()),
    status: v.optional(v.string()),
    bindingType: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.subjectId) {
      all = all.filter((b) => String(b.subjectId) === args.subjectId);
    }
    if (args.status) {
      all = all.filter((b) => b.status === args.status);
    }
    if (args.bindingType) {
      all = all.filter((b) => b.bindingType === args.bindingType);
    }

    const limit = Math.min(args.limit ?? 50, 100);
    let startIndex = 0;
    if (args.cursor) {
      const idx = all.findIndex((item) => String(item._id) === args.cursor);
      if (idx !== -1) startIndex = idx + 1;
    }
    const page = all.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < all.length;
    // Project: strip tenantId (deprecated), version (internal concurrency), and createdBy (internal)
    const data = page.map((b) => ({
      id: b._id,
      subjectId: b.subjectId,
      externalAccountId: b.externalAccountId,
      bindingType: b.bindingType,
      status: b.status,
      reason: b.reason,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }));
    return {
      data,
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    };
  },
});

export const getBindingById = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    bindingId: v.id('bindings'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const b = await ctx.db.get(args.bindingId);
    if (!b || b.authUserId !== args.authUserId) return null;
    // Project: strip tenantId (deprecated), version (internal concurrency), and createdBy (internal)
    return {
      id: b._id,
      subjectId: b.subjectId,
      externalAccountId: b.externalAccountId,
      bindingType: b.bindingType,
      status: b.status,
      reason: b.reason,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
  },
});
