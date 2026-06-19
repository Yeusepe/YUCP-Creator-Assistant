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

import { canReactivate } from '@yucp/shared/entitlement/service';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { mutation } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import { upsertLicenseSubjectLink } from './lib/licenseSubjectLink';
import { LicenseProviderV } from './lib/providers';
import { resolveRoleSyncDiscordUserId } from './lib/roleSyncIdentity';
import { buildRoleSyncIdempotencyKey, enqueueRoleSync } from './lib/roleSyncEnqueue';
import { upsertBuyerProviderLinkRecord } from './subjects';

// ============================================================================
// TYPES
// ============================================================================

const Provider = LicenseProviderV;

const ProductToGrant = v.object({
  productId: v.string(),
  sourceReference: v.string(),
  catalogProductId: v.optional(v.id('product_catalog')),
  providerTierRefs: v.optional(v.array(v.string())),
});

const LicenseSubjectLink = v.object({
  licenseSubject: v.string(),
  licenseKeyEncrypted: v.string(),
  providerProductId: v.optional(v.string()),
});

function buildExternalAccountProviderMetadata(
  providerMetadata:
    | {
        emailEncrypted?: string;
        avatarUrl?: string;
        profileUrl?: string;
        rawDataEncrypted?: string;
      }
    | undefined
) {
  if (!providerMetadata) {
    return undefined;
  }

  const value = {
    emailEncrypted: providerMetadata.emailEncrypted,
    avatarUrl: providerMetadata.avatarUrl,
    profileUrl: providerMetadata.profileUrl,
    rawDataEncrypted: providerMetadata.rawDataEncrypted,
  };

  return Object.values(value).some((entry) => entry !== undefined) ? value : undefined;
}

async function resolveVerificationActors(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    authUserId?: string;
    creatorAuthUserId?: string;
    buyerAuthUserId?: string;
    subjectId: Id<'subjects'>;
  }
) {
  const subject = await ctx.db.get(args.subjectId);
  if (!subject) {
    throw new ConvexError(`Subject not found: ${args.subjectId}`);
  }

  const hasLegacyIdentity = args.authUserId !== undefined;
  const hasExplicitIdentity =
    args.creatorAuthUserId !== undefined || args.buyerAuthUserId !== undefined;

  if (hasLegacyIdentity && hasExplicitIdentity) {
    throw new ConvexError(
      'Provide either authUserId or creatorAuthUserId/buyerAuthUserId, not both.'
    );
  }

  if (hasExplicitIdentity) {
    if (!args.creatorAuthUserId) {
      throw new ConvexError('Missing required field creatorAuthUserId in object');
    }
    if (!args.buyerAuthUserId) {
      throw new ConvexError('Missing required field buyerAuthUserId in object');
    }
    if (subject.authUserId !== args.buyerAuthUserId) {
      throw new ConvexError(
        `Subject ${args.subjectId} does not belong to buyer auth user ${args.buyerAuthUserId}`
      );
    }

    return {
      creatorAuthUserId: args.creatorAuthUserId,
      buyerAuthUserId: args.buyerAuthUserId,
      buyerSubjectId: args.subjectId,
      subject,
    };
  }

  if (!args.authUserId) {
    throw new ConvexError('Missing required field authUserId in object');
  }
  if (subject.authUserId && subject.authUserId !== args.authUserId) {
    throw new ConvexError(
      `Subject ${args.subjectId} does not belong to auth user ${args.authUserId}`
    );
  }

  return {
    creatorAuthUserId: args.authUserId,
    buyerAuthUserId: args.authUserId,
    buyerSubjectId: args.subjectId,
    subject,
  };
}

/**
 * Hash email for provider_customers normalizedEmailHash (SHA-256 hex)
 */
async function hashForStorage(value: string): Promise<string> {
  const data = new TextEncoder().encode(value.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function normalizeProviderTierRefs(providerTierRefs: string[] | undefined): string[] | undefined {
  const normalized = Array.from(
    new Set(
      (providerTierRefs ?? [])
        .map((providerTierRef) => providerTierRef.trim())
        .filter((providerTierRef) => providerTierRef.length > 0)
    )
  );
  return normalized.length > 0 ? normalized : undefined;
}

function sourceReferencesForGrantIdentity(
  provider: Doc<'entitlements'>['sourceProvider'],
  sourceReference: string
): string[] {
  const trimmed = sourceReference.trim();
  if (!trimmed) {
    return [];
  }

  const references = new Set<string>([trimmed]);
  const [sourceProvider, externalOrderId] = trimmed.split(':');
  if (sourceProvider === provider && externalOrderId?.trim()) {
    references.add(externalOrderId.trim());
  }

  return Array.from(references);
}

async function findExistingEntitlementForGrant(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    authUserId: string;
    subjectId: Id<'subjects'>;
    productId: string;
    sourceReferences: string[];
  }
): Promise<Doc<'entitlements'> | null> {
  for (const sourceReference of args.sourceReferences) {
    const entitlement = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
      )
      .filter((q) => q.eq(q.field('productId'), args.productId))
      .filter((q) => q.eq(q.field('sourceReference'), sourceReference))
      .first();
    if (entitlement) {
      return entitlement;
    }
  }

  return null;
}

async function upsertLicenseVerificationEntitlementEvidence(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    authUserId: string;
    subjectId: Id<'subjects'>;
    provider: Doc<'entitlements'>['sourceProvider'];
    productId: string;
    catalogProductId?: Id<'product_catalog'>;
    sourceReference: string;
    providerTierRefs?: string[];
    observedAt: number;
  }
): Promise<Id<'entitlement_evidence'>> {
  const providerTierRefs = normalizeProviderTierRefs(args.providerTierRefs);
  const existing = await ctx.db
    .query('entitlement_evidence')
    .withIndex('by_source_reference', (q) =>
      q.eq('providerKey', args.provider).eq('sourceReference', args.sourceReference)
    )
    .filter((q) => q.eq(q.field('authUserId'), args.authUserId))
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      subjectId: args.subjectId,
      evidenceType: 'license_verification',
      status: 'active',
      productId: args.productId,
      catalogProductId: args.catalogProductId ?? existing.catalogProductId,
      providerTierRefs: providerTierRefs ?? existing.providerTierRefs,
      observedAt: args.observedAt,
      updatedAt: args.observedAt,
    });
    return existing._id;
  }

  return await ctx.db.insert('entitlement_evidence', {
    authUserId: args.authUserId,
    subjectId: args.subjectId,
    providerKey: args.provider,
    sourceReference: args.sourceReference,
    evidenceType: 'license_verification',
    status: 'active',
    productId: args.productId,
    catalogProductId: args.catalogProductId,
    providerTierRefs,
    observedAt: args.observedAt,
    createdAt: args.observedAt,
    updatedAt: args.observedAt,
  });
}

/**
 * Complete license verification - creates external_account, binding, provider_customer,
 * and grants entitlements for all products. Enqueues outbox jobs for role sync.
 */
export const completeLicenseVerification = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.optional(v.string()),
    creatorAuthUserId: v.optional(v.string()),
    buyerAuthUserId: v.optional(v.string()),
    subjectId: v.id('subjects'),
    provider: Provider,
    providerUserId: v.string(),
    providerUsername: v.optional(v.string()),
    providerMetadata: v.optional(
      v.object({
        emailEncrypted: v.optional(v.string()),
        emailHash: v.optional(v.string()),
        avatarUrl: v.optional(v.string()),
        profileUrl: v.optional(v.string()),
        rawDataEncrypted: v.optional(v.string()),
      })
    ),
    productsToGrant: v.array(ProductToGrant),
    licenseSubjectLink: v.optional(LicenseSubjectLink),
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
    const { creatorAuthUserId, buyerAuthUserId, buyerSubjectId, subject } =
      await resolveVerificationActors(ctx, args);
    const externalAccountProviderMetadata = buildExternalAccountProviderMetadata(
      args.providerMetadata
    );
    const externalAccountEmailHash = args.providerMetadata?.emailHash;

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
        emailHash: externalAccountEmailHash ?? existingAccount.emailHash,
        providerMetadata: externalAccountProviderMetadata ?? existingAccount.providerMetadata,
        lastValidatedAt: now,
        status: 'active',
        updatedAt: now,
      });
    } else {
      externalAccountId = await ctx.db.insert('external_accounts', {
        provider: args.provider,
        providerUserId: args.providerUserId,
        providerUsername: args.providerUsername,
        emailHash: externalAccountEmailHash,
        providerMetadata: externalAccountProviderMetadata,
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
        q.eq('authUserId', buyerAuthUserId).eq('subjectId', buyerSubjectId)
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
        authUserId: buyerAuthUserId,
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: buyerSubjectId,
        reason: 'License verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }

    await upsertBuyerProviderLinkRecord(ctx, {
      subjectId: buyerSubjectId,
      provider: args.provider,
      externalAccountId,
      verificationMethod: 'account_link',
    });

    // 3. Upsert provider_customer
    const normalizedEmailHash = args.providerMetadata?.emailHash;
    const displayHints = args.providerUsername
      ? { usernamePrefix: args.providerUsername.slice(0, 3) }
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
      .withIndex('by_auth_user', (q) => q.eq('authUserId', creatorAuthUserId))
      .first();
    if (!profile) {
      throw new Error(`Creator profile not found: ${creatorAuthUserId}`);
    }

    if (args.licenseSubjectLink) {
      await upsertLicenseSubjectLink(ctx, {
        authUserId: buyerAuthUserId,
        licenseSubject: args.licenseSubjectLink.licenseSubject,
        provider: args.provider,
        licenseKeyEncrypted: args.licenseSubjectLink.licenseKeyEncrypted,
        providerProductId: args.licenseSubjectLink.providerProductId,
      });
    }

    const duplicateBehavior = profile.policy?.duplicateVerificationBehavior ?? 'allow';
    const notifyChannelId = profile.policy?.duplicateVerificationNotifyChannelId;

    // Check for duplicate verification (user already owns product)
    const duplicateProductIds: string[] = [];
    for (const product of args.productsToGrant) {
      const sourceReferences = sourceReferencesForGrantIdentity(args.provider, product.sourceReference);
      const existingForGrant = await findExistingEntitlementForGrant(ctx, {
        authUserId: creatorAuthUserId,
        subjectId: buyerSubjectId,
        productId: product.productId,
        sourceReferences,
      });
      if (existingForGrant?.status === 'active') {
        continue;
      }

      const existingForProduct = await ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', buyerSubjectId)
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
        const _jobId = await ctx.db.insert('outbox_jobs', {
          authUserId: creatorAuthUserId,
          jobType: 'creator_alert',
          payload: {
            channelId: notifyChannelId,
            message: `Duplicate verification: <@${subject.primaryDiscordUserId}> already owns product(s) ${duplicateProductIds.join(', ')}. Verification was allowed.`,
            alertType: 'duplicate_verification',
            productIds: duplicateProductIds,
            subjectId: buyerSubjectId,
          },
          status: 'pending',
          idempotencyKey: `dup_notify:${creatorAuthUserId}:${buyerSubjectId}:${duplicateProductIds.join(',')}`,
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
      const existingEntitlement = await findExistingEntitlementForGrant(ctx, {
        authUserId: creatorAuthUserId,
        subjectId: buyerSubjectId,
        productId: product.productId,
        sourceReferences: sourceReferencesForGrantIdentity(args.provider, product.sourceReference),
      });

      let entitlementId: Id<'entitlements'>;
      if (existingEntitlement) {
        entitlementId = existingEntitlement._id;
        const refreshPatch: {
          sourceReference?: string;
          licenseSubject?: string;
          providerCustomerId?: Id<'provider_customers'>;
          catalogProductId?: Id<'product_catalog'>;
        } = {};
        if (existingEntitlement.sourceReference !== product.sourceReference) {
          refreshPatch.sourceReference = product.sourceReference;
        }
        if (args.licenseSubjectLink?.licenseSubject && !existingEntitlement.licenseSubject) {
          refreshPatch.licenseSubject = args.licenseSubjectLink.licenseSubject;
        }
        if (providerCustomerId && existingEntitlement.providerCustomerId !== providerCustomerId) {
          refreshPatch.providerCustomerId = providerCustomerId;
        }
        if (product.catalogProductId && existingEntitlement.catalogProductId !== product.catalogProductId) {
          refreshPatch.catalogProductId = product.catalogProductId;
        }

        if (existingEntitlement.status !== 'active') {
          if (!canReactivate(existingEntitlement.status as Parameters<typeof canReactivate>[0])) {
            throw new ConvexError('Cannot reactivate a refunded or disputed entitlement');
          }
          await ctx.db.patch(entitlementId, {
            ...refreshPatch,
            status: 'active',
            revokedAt: undefined,
            updatedAt: now,
            // Backfill the canonical license subject if this grant carries one and the
            // existing row predates the field, so forensics can resolve the license.
            licenseSubject:
              args.licenseSubjectLink?.licenseSubject ?? existingEntitlement.licenseSubject,
          });
          // Emit role sync for reactivated entitlement
          const discordUserId = resolveRoleSyncDiscordUserId(subject);
          if (discordUserId) {
            const jobId = await enqueueRoleSync(ctx, {
              authUserId: creatorAuthUserId,
              subjectId: buyerSubjectId,
              entitlementId,
              discordUserId,
              idempotencyKey: buildRoleSyncIdempotencyKey({
                authUserId: creatorAuthUserId,
                subjectId: buyerSubjectId,
                entitlementId,
                lifecycle: { kind: 'grant', at: now },
              }),
            });
            outboxJobIds.push(jobId);
          }
        } else if (Object.keys(refreshPatch).length > 0) {
          await ctx.db.patch(entitlementId, {
            ...refreshPatch,
            updatedAt: now,
          });
        }
      } else {
        // Create new entitlement
        const existingEntitlements = await ctx.db
          .query('entitlements')
          .withIndex('by_auth_user_subject', (q) =>
            q.eq('authUserId', creatorAuthUserId).eq('subjectId', buyerSubjectId)
          )
          .collect();
        const policySnapshotVersion = existingEntitlements.length + 1;

        entitlementId = await ctx.db.insert('entitlements', {
          authUserId: creatorAuthUserId,
          subjectId: buyerSubjectId,
          productId: product.productId,
          sourceProvider: args.provider,
          sourceReference: product.sourceReference,
          licenseSubject: args.licenseSubjectLink?.licenseSubject,
          providerCustomerId,
          catalogProductId: product.catalogProductId,
          status: 'active',
          policySnapshotVersion,
          grantedAt: now,
          updatedAt: now,
        });

        // Emit role sync job
        const discordUserId = resolveRoleSyncDiscordUserId(subject);
        if (discordUserId) {
          const jobId = await enqueueRoleSync(ctx, {
            authUserId: creatorAuthUserId,
            subjectId: buyerSubjectId,
            entitlementId,
            discordUserId,
            idempotencyKey: buildRoleSyncIdempotencyKey({
              authUserId: creatorAuthUserId,
              subjectId: buyerSubjectId,
              entitlementId,
              lifecycle: { kind: 'grant', at: now },
            }),
          });
          outboxJobIds.push(jobId);
        }

        // Audit event
        await ctx.db.insert('audit_events', {
          authUserId: creatorAuthUserId,
          eventType: 'entitlement.granted',
          actorType: 'system',
          subjectId: buyerSubjectId,
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
      await upsertLicenseVerificationEntitlementEvidence(ctx, {
        authUserId: creatorAuthUserId,
        subjectId: buyerSubjectId,
        provider: args.provider,
        productId: product.productId,
        catalogProductId: product.catalogProductId,
        sourceReference: product.sourceReference,
        providerTierRefs: product.providerTierRefs,
        observedAt: now,
      });
    }

    // Audit event for license verification
    await ctx.db.insert('audit_events', {
      authUserId: buyerAuthUserId,
      eventType: 'binding.created',
      actorType: 'system',
      subjectId: buyerSubjectId,
      externalAccountId,
      metadata: {
        bindingId,
        provider: args.provider,
        providerUserId: args.providerUserId,
        productsGranted: args.productsToGrant.length,
        entitlementIds,
        creatorAuthUserId,
        buyerAuthUserId,
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
