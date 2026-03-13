/**
 * License Verification - One-License-to-Account Linking
 *
 * When a user verifies one license (Gumroad or Jinxxy), ties that license to their subject,
 * registers it as their provider account, and enables auto-verification of all other products
 * they own from that provider.
 *
 * Flow:
 * 1. Create or update external_account for provider
 * 2. Create binding between subject and external_account
 * 3. Upsert provider_customers with normalized identity
 * 4. Materialize entitlements for ALL products the user owns from that provider
 * 5. Enqueue outbox jobs for role sync
 */

import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation } from './_generated/server';
import { LicenseProviderV } from './lib/providers';

// ============================================================================
// TYPES
// ============================================================================

const Provider = LicenseProviderV;

const ProductToGrant = v.object({
  productId: v.string(),
  sourceReference: v.string(),
  catalogProductId: v.optional(v.id('product_catalog')),
});

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

/**
 * Hash email for provider_customers normalizedEmailHash (SHA-256 hex)
 */
function hashForStorage(value: string): string {
  // Convex doesn't have crypto.subtle in mutations - use a simple hash for matching
  // In production you'd want proper hashing; for now we use a deterministic encoding
  let h = 0;
  const str = value.toLowerCase().trim();
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return `h${Math.abs(h).toString(16)}`;
}

/**
 * Complete license verification - creates external_account, binding, provider_customer,
 * and grants entitlements for all products. Enqueues outbox jobs for role sync.
 */
export const completeLicenseVerification = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    provider: Provider,
    providerUserId: v.string(),
    providerUsername: v.optional(v.string()),
    providerMetadata: v.optional(
      v.object({
        email: v.optional(v.string()),
        avatarUrl: v.optional(v.string()),
        profileUrl: v.optional(v.string()),
        rawData: v.optional(v.any()),
      })
    ),
    productsToGrant: v.array(ProductToGrant),
    correlationId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    externalAccountId: v.id('external_accounts'),
    bindingId: v.id('bindings'),
    providerCustomerId: v.optional(v.id('provider_customers')),
    entitlementIds: v.array(v.id('entitlements')),
    outboxJobIds: v.array(v.id('outbox_jobs')),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    // 1. Create or update external_account
    let externalAccountId: Id<'external_accounts'>;
    const existingAccount = await ctx.db
      .query('external_accounts')
      .withIndex('by_provider_user', (q) =>
        q.eq('provider', args.provider).eq('providerUserId', args.providerUserId)
      )
      .first();

    if (existingAccount) {
      externalAccountId = existingAccount._id;
      await ctx.db.patch(externalAccountId, {
        providerUsername: args.providerUsername ?? existingAccount.providerUsername,
        providerMetadata: args.providerMetadata ?? existingAccount.providerMetadata,
        lastValidatedAt: now,
        status: 'active',
        updatedAt: now,
      });
    } else {
      externalAccountId = await ctx.db.insert('external_accounts', {
        provider: args.provider,
        providerUserId: args.providerUserId,
        providerUsername: args.providerUsername,
        providerMetadata: args.providerMetadata,
        lastValidatedAt: now,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    }

    // 2. Create or activate binding (verification type - links subject to provider account)
    const existingBinding = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
      )
      .filter((q) => q.eq(q.field('externalAccountId'), externalAccountId))
      .first();

    let bindingId: Id<'bindings'>;
    if (existingBinding) {
      bindingId = existingBinding._id;
      if (existingBinding.status !== 'active' && existingBinding.status !== 'pending') {
        await ctx.db.patch(bindingId, {
          status: 'active',
          bindingType: 'verification',
          reason: 'License verification - re-activated',
          version: existingBinding.version + 1,
          updatedAt: now,
        });
      }
    } else {
      bindingId = await ctx.db.insert('bindings', {
        authUserId: args.authUserId,
        subjectId: args.subjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: args.subjectId,
        reason: 'License verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }

    // 3. Upsert provider_customer
    const email = args.providerMetadata?.email;
    const normalizedEmailHash = email ? hashForStorage(email) : undefined;
    const displayHints = email
      ? {
          emailPrefix: email.slice(0, 3) + '***',
          usernamePrefix: args.providerUsername?.slice(0, 3),
        }
      : undefined;

    let providerCustomerId: Id<'provider_customers'> | undefined;
    const existingPc = await ctx.db
      .query('provider_customers')
      .withIndex('by_provider_user', (q) =>
        q.eq('provider', args.provider).eq('providerUserId', args.providerUserId)
      )
      .first();

    if (existingPc) {
      providerCustomerId = existingPc._id;
      await ctx.db.patch(providerCustomerId, {
        normalizedEmailHash: normalizedEmailHash ?? existingPc.normalizedEmailHash,
        displayHints: displayHints ?? existingPc.displayHints,
        status: 'active',
        lastObservedAt: now,
        confidence: 'high',
        updatedAt: now,
      });
    } else {
      providerCustomerId = await ctx.db.insert('provider_customers', {
        provider: args.provider,
        providerUserId: args.providerUserId,
        normalizedEmailHash,
        displayHints,
        status: 'active',
        lastObservedAt: now,
        confidence: 'high',
        createdAt: now,
        updatedAt: now,
      });
    }

    // 4. Grant entitlements for each product and emit role sync jobs
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!profile) {
      throw new Error(`Creator profile not found: ${args.authUserId}`);
    }

    const subject = await ctx.db.get(args.subjectId);
    if (!subject) {
      throw new Error(`Subject not found: ${args.subjectId}`);
    }

    const duplicateBehavior = profile.policy?.duplicateVerificationBehavior ?? 'allow';
    const notifyChannelId = profile.policy?.duplicateVerificationNotifyChannelId;

    // Check for duplicate verification (user already owns product)
    const duplicateProductIds: string[] = [];
    for (const product of args.productsToGrant) {
      const existingForProduct = await ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
        )
        .filter((q) => q.eq(q.field('productId'), product.productId))
        .filter((q) => q.eq(q.field('status'), 'active'))
        .first();
      if (existingForProduct) {
        duplicateProductIds.push(product.productId);
      }
    }

    if (duplicateProductIds.length > 0) {
      if (duplicateBehavior === 'block') {
        return {
          success: false,
          externalAccountId,
          bindingId,
          entitlementIds: [],
          outboxJobIds: [],
          error: 'You already own this product.',
        };
      }
      if (duplicateBehavior === 'notify' && notifyChannelId) {
        const jobId = await ctx.db.insert('outbox_jobs', {
          authUserId: args.authUserId,
          jobType: 'creator_alert',
          payload: {
            channelId: notifyChannelId,
            message: `Duplicate verification: <@${subject.primaryDiscordUserId}> already owns product(s) ${duplicateProductIds.join(', ')}. Verification was allowed.`,
            alertType: 'duplicate_verification',
            productIds: duplicateProductIds,
            subjectId: args.subjectId,
          },
          status: 'pending',
          idempotencyKey: `dup_notify:${args.authUserId}:${args.subjectId}:${duplicateProductIds.join(',')}:${now}`,
          retryCount: 0,
          maxRetries: 3,
          createdAt: now,
          updatedAt: now,
        });
        // Continue with grant - creator_alert will be processed by bot
      }
    }

    const entitlementIds: Id<'entitlements'>[] = [];
    const outboxJobIds: Id<'outbox_jobs'>[] = [];

    for (const product of args.productsToGrant) {
      // Check for existing entitlement (idempotency)
      const existingEntitlement = await ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
        )
        .filter((q) => q.eq(q.field('sourceReference'), product.sourceReference))
        .first();

      let entitlementId: Id<'entitlements'>;
      if (existingEntitlement) {
        entitlementId = existingEntitlement._id;
        if (existingEntitlement.status !== 'active') {
          await ctx.db.patch(entitlementId, {
            status: 'active',
            revokedAt: undefined,
            updatedAt: now,
          });
          // Emit role sync for reactivated entitlement
          const jobId = await ctx.db.insert('outbox_jobs', {
            authUserId: args.authUserId,
            jobType: 'role_sync',
            payload: {
              subjectId: args.subjectId,
              entitlementId,
              discordUserId: subject.primaryDiscordUserId,
            },
            status: 'pending',
            idempotencyKey: `role_sync:${args.authUserId}:${args.subjectId}:${entitlementId}:${now}`,
            targetDiscordUserId: subject.primaryDiscordUserId,
            retryCount: 0,
            maxRetries: 5,
            createdAt: now,
            updatedAt: now,
          });
          outboxJobIds.push(jobId);
        }
      } else {
        // Create new entitlement
        const existingEntitlements = await ctx.db
          .query('entitlements')
          .withIndex('by_auth_user_subject', (q) =>
            q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
          )
          .collect();
        const policySnapshotVersion = existingEntitlements.length + 1;

        entitlementId = await ctx.db.insert('entitlements', {
          authUserId: args.authUserId,
          subjectId: args.subjectId,
          productId: product.productId,
          sourceProvider: args.provider,
          sourceReference: product.sourceReference,
          providerCustomerId,
          catalogProductId: product.catalogProductId,
          status: 'active',
          policySnapshotVersion,
          grantedAt: now,
          updatedAt: now,
        });

        // Emit role sync job
        const jobId = await ctx.db.insert('outbox_jobs', {
          authUserId: args.authUserId,
          jobType: 'role_sync',
          payload: {
            subjectId: args.subjectId,
            entitlementId,
            discordUserId: subject.primaryDiscordUserId,
          },
          status: 'pending',
          idempotencyKey: `role_sync:${args.authUserId}:${args.subjectId}:${entitlementId}:${now}`,
          targetDiscordUserId: subject.primaryDiscordUserId,
          retryCount: 0,
          maxRetries: 5,
          createdAt: now,
          updatedAt: now,
        });
        outboxJobIds.push(jobId);

        // Audit event
        await ctx.db.insert('audit_events', {
          authUserId: args.authUserId,
          eventType: 'entitlement.granted',
          actorType: 'system',
          subjectId: args.subjectId,
          entitlementId,
          metadata: {
            productId: product.productId,
            sourceProvider: args.provider,
            sourceReference: product.sourceReference,
            policySnapshotVersion,
            catalogProductId: product.catalogProductId,
          },
          correlationId: args.correlationId,
          createdAt: now,
        });
      }
      entitlementIds.push(entitlementId);
    }

    // Audit event for license verification
    await ctx.db.insert('audit_events', {
      authUserId: args.authUserId,
      eventType: 'binding.created',
      actorType: 'system',
      subjectId: args.subjectId,
      externalAccountId,
      metadata: {
        bindingId,
        provider: args.provider,
        providerUserId: args.providerUserId,
        productsGranted: args.productsToGrant.length,
        entitlementIds,
        correlationId: args.correlationId,
      },
      correlationId: args.correlationId,
      createdAt: now,
    });

    return {
      success: true,
      externalAccountId,
      bindingId,
      providerCustomerId,
      entitlementIds,
      outboxJobIds,
    };
  },
});
