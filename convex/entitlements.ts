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

import {
  calculateGracePeriodEnd,
  canReactivate,
  isEntitlementActive,
  mapReasonToStatus,
} from '@yucp/shared/entitlement/service';
import { sha256Hex } from '@yucp/shared/crypto';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import {
  ApiActorBindingV,
  requireDelegatedAuthUserActor,
  requireServiceActor,
} from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';
import { createConvexLogger } from './lib/logger';
import { ProviderV } from './lib/providers';
import { resolveRoleSyncDiscordUserId } from './lib/roleSyncIdentity';
import {
  buildRoleRemovalIdempotencyKey,
  buildRoleSyncIdempotencyKey,
  enqueueRoleRemoval,
  enqueueRoleSync,
} from './lib/roleSyncEnqueue';

// ============================================================================
// TYPES
// ============================================================================

/** Provider types for entitlements */
export const EntitlementProvider = ProviderV;

/** Entitlement status values */
export const EntitlementStatus = v.union(
  v.literal('active'),
  v.literal('revoked'),
  v.literal('expired'),
  v.literal('refunded'),
  v.literal('disputed')
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
  v.literal('policy_violation')
);

type EntitlementReaderCtx = MutationCtx | QueryCtx;
type EntitlementGrantOutcome = 'granted' | 'skipped' | 'error';
type EntitlementGrantReason =
  | 'created'
  | 'reactivated'
  | 'active_refreshed'
  | 'already_active'
  | 'active_product_exists'
  | 'source_provider_required'
  | 'provider_customer_missing'
  | 'source_provider_missing'
  | 'error';
type GrantExistingLookup =
  | {
      mode: 'sourceReference';
      sourceReferences?: string[];
      matchProduct?: boolean;
      matchProvider?: boolean;
    }
  | {
      mode: 'activeProduct';
    };
type GrantRoleSyncOptions =
  | {
      mode: 'none';
    }
  | {
      mode: 'primaryDiscordUserId' | 'roleSyncIdentity';
      lifecycleAt?: number | 'now';
      requireDiscordUserId: boolean;
      missingSubject: 'throw' | 'skip';
      skipDiscordUserIdPrefixes?: string[];
      enqueueOnActiveRefresh?: boolean;
    };
type GrantAuditOptions = {
  emitForNew?: boolean;
  emitForReactivated?: boolean;
  correlationId?: string;
};
type EntitlementEvidenceFunnelArgs = {
  authUserId: string;
  subjectId?: Id<'subjects'>;
  providerKey: Doc<'entitlement_evidence'>['providerKey'];
  providerConnectionId?: Id<'provider_connections'>;
  transactionId?: Id<'provider_transactions'>;
  membershipId?: Id<'provider_memberships'>;
  licenseId?: Id<'provider_licenses'>;
  sourceReference: string;
  evidenceType: string;
  status: Doc<'entitlement_evidence'>['status'];
  productId?: string;
  catalogProductId?: Id<'product_catalog'>;
  providerTierRefs?: string[];
  rawWebhookEventId?: Id<'webhook_events'>;
  metadata?: unknown;
  observedAt: number;
  createdAt?: number;
  updatedAt?: number;
  lookupFilters?: {
    authUserId?: boolean;
    subjectId?: boolean;
    productId?: boolean;
    evidenceType?: boolean;
  };
  patchEvidenceType?: boolean;
};
type GrantEntitlementFunnelArgs = {
  authUserId: string;
  subjectId: Id<'subjects'>;
  subject?: Doc<'subjects'>;
  productId: string;
  sourceProvider: Doc<'entitlements'>['sourceProvider'];
  sourceReference: string;
  providerCustomerId?: Id<'provider_customers'>;
  catalogProductId?: Id<'product_catalog'>;
  licenseSubject?: string;
  policySnapshotVersion: number;
  grantedAt?: number;
  now?: number;
  existingLookup: GrantExistingLookup;
  reactivation: {
    allowTerminal: boolean;
    refreshExistingFields?: boolean;
  };
  roleSync: GrantRoleSyncOptions;
  audit?: GrantAuditOptions;
  evidence?: EntitlementEvidenceFunnelArgs;
};
type GrantEntitlementFunnelResult = {
  entitlementId: Id<'entitlements'>;
  outcome: Exclude<EntitlementGrantOutcome, 'error'>;
  reason: EntitlementGrantReason;
  isNew: boolean;
  previousStatus?: Doc<'entitlements'>['status'];
  outboxJobIds: Id<'outbox_jobs'>[];
  evidenceId?: Id<'entitlement_evidence'>;
};

const entitlementGrantLogger = createConvexLogger();

const EntitlementReadFields = {
  _id: v.id('entitlements'),
  subjectId: v.id('subjects'),
  productId: v.string(),
  sourceProvider: EntitlementProvider,
  status: EntitlementStatus,
  grantedAt: v.number(),
  revokedAt: v.optional(v.number()),
};

const EntitlementReadRecord = v.object(EntitlementReadFields);
const InternalEntitlementReadRecord = v.object({
  ...EntitlementReadFields,
  authUserId: v.string(),
});

const ProductEntitlementReadRecord = v.object({
  ...EntitlementReadFields,
  catalogProductId: v.optional(v.id('product_catalog')),
});

type LegacyEntitlementReadDoc = Omit<Doc<'entitlements'>, 'catalogProductId' | 'revokedAt'> & {
  catalogProductId?: unknown;
  revokedAt?: unknown;
};

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function normalizeEntitlementReadRecord(entitlement: LegacyEntitlementReadDoc) {
  const revokedAt = optionalNumber(entitlement.revokedAt);

  return {
    _id: entitlement._id,
    subjectId: entitlement.subjectId,
    productId: entitlement.productId,
    sourceProvider: entitlement.sourceProvider,
    status: entitlement.status,
    grantedAt: entitlement.grantedAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

function normalizeInternalEntitlementReadRecord(entitlement: LegacyEntitlementReadDoc) {
  return {
    ...normalizeEntitlementReadRecord(entitlement),
    authUserId: entitlement.authUserId,
  };
}

async function normalizeProductEntitlementReadRecord(
  ctx: EntitlementReaderCtx,
  entitlement: LegacyEntitlementReadDoc
) {
  let catalogProductId: Id<'product_catalog'> | undefined;
  if (typeof entitlement.catalogProductId === 'string') {
    try {
      const product = await ctx.db.get(entitlement.catalogProductId as Id<'product_catalog'>);
      if (product) {
        catalogProductId = product._id;
      }
    } catch {
      catalogProductId = undefined;
    }
  }

  return {
    ...normalizeEntitlementReadRecord(entitlement),
    ...(catalogProductId ? { catalogProductId } : {}),
  };
}

async function requireActiveSubject(
  ctx: EntitlementReaderCtx,
  subjectId: Id<'subjects'>
): Promise<Doc<'subjects'>> {
  const subject = await ctx.db.get(subjectId);
  if (!subject) {
    throw new ConvexError('Subject not found');
  }
  if (subject.status !== 'active') {
    throw new ConvexError(`Subject is not active: ${subject.status}`);
  }
  return subject;
}

async function logEntitlementGrantAttempt(params: {
  provider: string;
  outcome: EntitlementGrantOutcome;
  reason: string;
  authUserId: string;
  subjectId?: Id<'subjects'>;
  productId?: string;
  entitlementId?: Id<'entitlements'>;
}): Promise<void> {
  const metadata = {
    event: 'entitlement_grant',
    provider: params.provider,
    outcome: params.outcome,
    reason: params.reason,
    authUserIdHash: await sha256Hex(params.authUserId),
    subjectIdHash: params.subjectId ? await sha256Hex(params.subjectId) : undefined,
    productIdHash: params.productId ? await sha256Hex(params.productId) : undefined,
    ...(params.reason === 'created' && params.entitlementId
      ? { entitlementId: params.entitlementId }
      : {}),
  };

  if (params.outcome === 'error') {
    entitlementGrantLogger.error('entitlement_grant', metadata);
    return;
  }

  entitlementGrantLogger.info('entitlement_grant', metadata);
}

export async function recordEntitlementGrantSkipped(params: {
  provider: string;
  reason: EntitlementGrantReason | string;
  authUserId: string;
  subjectId?: Id<'subjects'>;
  productId?: string;
  entitlementId?: Id<'entitlements'>;
}): Promise<void> {
  await logEntitlementGrantAttempt({
    provider: params.provider,
    outcome: 'skipped',
    reason: params.reason,
    authUserId: params.authUserId,
    subjectId: params.subjectId,
    productId: params.productId,
    entitlementId: params.entitlementId,
  });
}

function requireSourceProvider(sourceProvider: unknown): string {
  const provider = typeof sourceProvider === 'string' ? sourceProvider.trim() : '';
  if (!provider) {
    throw new ConvexError('source_provider_required');
  }
  return provider;
}

async function findExistingEntitlementInFunnel(
  ctx: MutationCtx,
  args: {
    authUserId: string;
    subjectId: Id<'subjects'>;
    productId: string;
    sourceProvider: string;
    sourceReference: string;
    lookup: GrantExistingLookup;
  }
): Promise<Doc<'entitlements'> | null> {
  if (args.lookup.mode === 'activeProduct') {
    return await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
      )
      .filter((q) => q.eq(q.field('productId'), args.productId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();
  }

  const sourceReferences = args.lookup.sourceReferences ?? [args.sourceReference];
  for (const sourceReference of sourceReferences) {
    let query = ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
      )
      .filter((q) => q.eq(q.field('sourceReference'), sourceReference));

    if (args.lookup.matchProduct) {
      query = query.filter((q) => q.eq(q.field('productId'), args.productId));
    }
    if (args.lookup.matchProvider) {
      query = query.filter((q) => q.eq(q.field('sourceProvider'), args.sourceProvider));
    }

    const entitlement = await query.first();
    if (entitlement) {
      return entitlement;
    }
  }

  return null;
}

function buildExistingEntitlementRefreshPatch(
  existingEntitlement: Doc<'entitlements'>,
  args: GrantEntitlementFunnelArgs
): Partial<Doc<'entitlements'>> {
  if (!args.reactivation.refreshExistingFields) {
    return {};
  }

  const refreshPatch: Partial<Doc<'entitlements'>> = {};
  if (existingEntitlement.sourceReference !== args.sourceReference) {
    refreshPatch.sourceReference = args.sourceReference;
  }
  if (args.licenseSubject && !existingEntitlement.licenseSubject) {
    refreshPatch.licenseSubject = args.licenseSubject;
  }
  if (
    args.providerCustomerId &&
    existingEntitlement.providerCustomerId !== args.providerCustomerId
  ) {
    refreshPatch.providerCustomerId = args.providerCustomerId;
  }
  if (args.catalogProductId && existingEntitlement.catalogProductId !== args.catalogProductId) {
    refreshPatch.catalogProductId = args.catalogProductId;
  }

  return refreshPatch;
}

function resolveGrantRoleSyncLifecycleAt(
  roleSync: GrantRoleSyncOptions,
  now: number
): number | undefined {
  if (roleSync.mode === 'none') {
    return undefined;
  }
  return roleSync.lifecycleAt === 'now' ? now : roleSync.lifecycleAt;
}

async function enqueueGrantRoleSyncFromFunnel(
  ctx: MutationCtx,
  args: {
    authUserId: string;
    subjectId: Id<'subjects'>;
    entitlementId: Id<'entitlements'>;
    subject?: Doc<'subjects'>;
    roleSync: GrantRoleSyncOptions;
    now: number;
  }
): Promise<Id<'outbox_jobs'> | undefined> {
  if (args.roleSync.mode === 'none') {
    return undefined;
  }

  const subject = args.subject ?? (await ctx.db.get(args.subjectId));
  if (!subject && args.roleSync.missingSubject === 'throw') {
    throw new Error(`Subject not found: ${args.subjectId}`);
  }

  let discordUserId =
    args.roleSync.mode === 'roleSyncIdentity'
      ? resolveRoleSyncDiscordUserId(subject ?? {})
      : subject?.primaryDiscordUserId;

  if (
    discordUserId &&
    args.roleSync.skipDiscordUserIdPrefixes?.some((prefix) => discordUserId?.startsWith(prefix))
  ) {
    discordUserId = undefined;
  }

  if (!discordUserId && args.roleSync.requireDiscordUserId) {
    return undefined;
  }

  const lifecycleAt = resolveGrantRoleSyncLifecycleAt(args.roleSync, args.now);
  return await enqueueRoleSync(ctx, {
    authUserId: args.authUserId,
    subjectId: args.subjectId,
    entitlementId: args.entitlementId,
    discordUserId,
    idempotencyKey: buildRoleSyncIdempotencyKey({
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      entitlementId: args.entitlementId,
      ...(lifecycleAt !== undefined ? { lifecycle: { kind: 'grant', at: lifecycleAt } } : {}),
    }),
  });
}

export async function upsertEntitlementEvidenceFromFunnel(
  ctx: MutationCtx,
  args: EntitlementEvidenceFunnelArgs
): Promise<Id<'entitlement_evidence'>> {
  let query = ctx.db
    .query('entitlement_evidence')
    .withIndex('by_source_reference', (q) =>
      q.eq('providerKey', args.providerKey).eq('sourceReference', args.sourceReference)
    );

  if (args.lookupFilters?.authUserId) {
    query = query.filter((q) => q.eq(q.field('authUserId'), args.authUserId));
  }
  if (args.lookupFilters?.subjectId) {
    query = query.filter((q) => q.eq(q.field('subjectId'), args.subjectId));
  }
  if (args.lookupFilters?.productId) {
    query = query.filter((q) => q.eq(q.field('productId'), args.productId));
  }
  if (args.lookupFilters?.evidenceType) {
    query = query.filter((q) => q.eq(q.field('evidenceType'), args.evidenceType));
  }

  const existing = await query.first();
  const now = Date.now();
  const updatedAt = args.updatedAt ?? now;

  if (existing) {
    await ctx.db.patch(existing._id, {
      subjectId: args.subjectId ?? existing.subjectId,
      providerConnectionId: args.providerConnectionId ?? existing.providerConnectionId,
      transactionId: args.transactionId ?? existing.transactionId,
      membershipId: args.membershipId ?? existing.membershipId,
      licenseId: args.licenseId ?? existing.licenseId,
      ...(args.patchEvidenceType ? { evidenceType: args.evidenceType } : {}),
      status: args.status,
      productId: args.productId ?? existing.productId,
      catalogProductId: args.catalogProductId ?? existing.catalogProductId,
      providerTierRefs: args.providerTierRefs ?? existing.providerTierRefs,
      rawWebhookEventId: args.rawWebhookEventId ?? existing.rawWebhookEventId,
      metadata: args.metadata ?? existing.metadata,
      observedAt: args.observedAt,
      updatedAt,
    });
    return existing._id;
  }

  return await ctx.db.insert('entitlement_evidence', {
    authUserId: args.authUserId,
    subjectId: args.subjectId,
    providerKey: args.providerKey,
    providerConnectionId: args.providerConnectionId,
    transactionId: args.transactionId,
    membershipId: args.membershipId,
    licenseId: args.licenseId,
    sourceReference: args.sourceReference,
    evidenceType: args.evidenceType,
    status: args.status,
    productId: args.productId,
    catalogProductId: args.catalogProductId,
    providerTierRefs: args.providerTierRefs,
    rawWebhookEventId: args.rawWebhookEventId,
    metadata: args.metadata,
    observedAt: args.observedAt,
    createdAt: args.createdAt ?? now,
    updatedAt,
  });
}

export async function grantEntitlementFromFunnel(
  ctx: MutationCtx,
  args: GrantEntitlementFunnelArgs
): Promise<GrantEntitlementFunnelResult> {
  const now = args.now ?? Date.now();
  let provider = args.sourceProvider;

  try {
    provider = requireSourceProvider(args.sourceProvider);
    const existingEntitlement = await findExistingEntitlementInFunnel(ctx, {
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      productId: args.productId,
      sourceProvider: provider,
      sourceReference: args.sourceReference,
      lookup: args.existingLookup,
    });

    if (existingEntitlement) {
      const outboxJobIds: Id<'outbox_jobs'>[] = [];
      const previousStatus = existingEntitlement.status;
      const refreshPatch = buildExistingEntitlementRefreshPatch(existingEntitlement, args);
      const hasRefreshPatch = Object.keys(refreshPatch).length > 0;
      let evidenceId: Id<'entitlement_evidence'> | undefined;

      if (
        isEntitlementActive(existingEntitlement.status as Parameters<typeof isEntitlementActive>[0])
      ) {
        if (hasRefreshPatch) {
          await ctx.db.patch(existingEntitlement._id, {
            ...refreshPatch,
            updatedAt: now,
          });
        }

        if (args.evidence) {
          evidenceId = await upsertEntitlementEvidenceFromFunnel(ctx, args.evidence);
        }

        const shouldEnqueueRoleSync =
          args.roleSync.mode !== 'none' &&
          (hasRefreshPatch || args.roleSync.enqueueOnActiveRefresh === true);
        if (shouldEnqueueRoleSync) {
          const outboxJobId = await enqueueGrantRoleSyncFromFunnel(ctx, {
            authUserId: args.authUserId,
            subjectId: args.subjectId,
            entitlementId: existingEntitlement._id,
            subject: args.subject,
            roleSync: args.roleSync,
            now,
          });
          if (outboxJobId) {
            outboxJobIds.push(outboxJobId);
          }
        }

        const reason =
          args.existingLookup.mode === 'activeProduct'
            ? 'active_product_exists'
            : hasRefreshPatch || outboxJobIds.length > 0
              ? 'active_refreshed'
              : 'already_active';
        const outcome = reason === 'active_refreshed' ? 'granted' : 'skipped';
        await logEntitlementGrantAttempt({
          provider,
          outcome,
          reason,
          authUserId: args.authUserId,
          subjectId: args.subjectId,
          productId: args.productId,
          entitlementId: existingEntitlement._id,
        });

        return {
          entitlementId: existingEntitlement._id,
          outcome,
          reason,
          isNew: false,
          previousStatus: undefined,
          outboxJobIds,
          evidenceId,
        };
      }

      if (!args.reactivation.allowTerminal) {
        if (!canReactivate(existingEntitlement.status as Parameters<typeof canReactivate>[0])) {
          throw new ConvexError('Cannot reactivate a refunded or disputed entitlement');
        }
      }

      await ctx.db.patch(existingEntitlement._id, {
        ...refreshPatch,
        status: 'active',
        revokedAt: undefined,
        updatedAt: now,
        ...(args.reactivation.refreshExistingFields
          ? { licenseSubject: args.licenseSubject ?? existingEntitlement.licenseSubject }
          : {}),
      });

      const outboxJobId = await enqueueGrantRoleSyncFromFunnel(ctx, {
        authUserId: args.authUserId,
        subjectId: args.subjectId,
        entitlementId: existingEntitlement._id,
        subject: args.subject,
        roleSync: args.roleSync,
        now,
      });
      if (outboxJobId) {
        outboxJobIds.push(outboxJobId);
      }

      if (args.audit?.emitForReactivated) {
        await createAuditEvent(ctx, {
          authUserId: args.authUserId,
          eventType: 'entitlement.granted',
          subjectId: args.subjectId,
          entitlementId: existingEntitlement._id,
          metadata: {
            productId: args.productId,
            sourceProvider: provider,
            sourceReference: args.sourceReference,
            reactivated: true,
            previousStatus,
          },
          correlationId: args.audit.correlationId,
        });
      }

      if (args.evidence) {
        evidenceId = await upsertEntitlementEvidenceFromFunnel(ctx, args.evidence);
      }

      await logEntitlementGrantAttempt({
        provider,
        outcome: 'granted',
        reason: 'reactivated',
        authUserId: args.authUserId,
        subjectId: args.subjectId,
        productId: args.productId,
        entitlementId: existingEntitlement._id,
      });

      return {
        entitlementId: existingEntitlement._id,
        outcome: 'granted',
        reason: 'reactivated',
        isNew: false,
        previousStatus,
        outboxJobIds,
        evidenceId,
      };
    }

    const entitlementId = await ctx.db.insert('entitlements', {
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      productId: args.productId,
      sourceProvider: provider,
      sourceReference: args.sourceReference,
      licenseSubject: args.licenseSubject,
      providerCustomerId: args.providerCustomerId,
      catalogProductId: args.catalogProductId,
      status: 'active',
      policySnapshotVersion: args.policySnapshotVersion,
      grantedAt: args.grantedAt ?? now,
      updatedAt: now,
    });

    const outboxJobIds: Id<'outbox_jobs'>[] = [];
    const outboxJobId = await enqueueGrantRoleSyncFromFunnel(ctx, {
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      entitlementId,
      subject: args.subject,
      roleSync: args.roleSync,
      now,
    });
    if (outboxJobId) {
      outboxJobIds.push(outboxJobId);
    }

    if (args.audit?.emitForNew) {
      await createAuditEvent(ctx, {
        authUserId: args.authUserId,
        eventType: 'entitlement.granted',
        subjectId: args.subjectId,
        entitlementId,
        metadata: {
          productId: args.productId,
          sourceProvider: provider,
          sourceReference: args.sourceReference,
          policySnapshotVersion: args.policySnapshotVersion,
          catalogProductId: args.catalogProductId,
        },
        correlationId: args.audit.correlationId,
      });
    }

    const evidenceId = args.evidence
      ? await upsertEntitlementEvidenceFromFunnel(ctx, args.evidence)
      : undefined;

    await logEntitlementGrantAttempt({
      provider,
      outcome: 'granted',
      reason: 'created',
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      productId: args.productId,
      entitlementId,
    });

    return {
      entitlementId,
      outcome: 'granted',
      reason: 'created',
      isNew: true,
      previousStatus: undefined,
      outboxJobIds,
      evidenceId,
    };
  } catch (err) {
    const reason =
      err instanceof ConvexError && typeof err.data === 'string' ? err.data : 'unexpected_error';
    await logEntitlementGrantAttempt({
      provider,
      outcome: 'error',
      reason,
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      productId: args.productId,
    });
    throw err;
  }
}

async function listActiveEntitlementsForActiveSubjects(
  ctx: EntitlementReaderCtx,
  authUserId: string,
  limit: number
): Promise<Array<Doc<'entitlements'>>> {
  const activeEntitlements = await ctx.db
    .query('entitlements')
    .withIndex('by_auth_user_status', (q) => q.eq('authUserId', authUserId).eq('status', 'active'))
    .take(limit);
  const activeSubjectIds = new Map<string, boolean>();
  const filtered: Array<Doc<'entitlements'>> = [];

  for (const entitlement of activeEntitlements) {
    let isActive = activeSubjectIds.get(entitlement.subjectId);
    if (isActive === undefined) {
      const subject = await ctx.db.get(entitlement.subjectId);
      isActive = subject?.status === 'active';
      activeSubjectIds.set(entitlement.subjectId, isActive);
    }

    if (isActive) {
      filtered.push(entitlement);
    }
  }

  return filtered;
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
    actor: ApiActorBindingV,
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    includeInactive: v.optional(v.boolean()),
  },
  returns: v.array(EntitlementReadRecord),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    let query = ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
      );

    if (!args.includeInactive) {
      query = query.filter((q) => q.eq(q.field('status'), 'active'));
    }

    const entitlements = await query.order('desc').take(1000);
    return entitlements.map((entitlement) => normalizeEntitlementReadRecord(entitlement));
  },
});

/**
 * Get all entitlements for a product within a tenant.
 * Useful for product-level analytics and role assignment.
 */
export const getEntitlementsByProduct = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    productId: v.string(),
    includeInactive: v.optional(v.boolean()),
  },
  returns: v.array(ProductEntitlementReadRecord),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    let query = ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_product', (q) =>
        q.eq('authUserId', args.authUserId).eq('productId', args.productId)
      );

    if (!args.includeInactive) {
      query = query.filter((q) => q.eq(q.field('status'), 'active'));
    }

    const entitlements = await query.order('desc').take(1000);
    return await Promise.all(
      entitlements.map((entitlement) => normalizeProductEntitlementReadRecord(ctx, entitlement))
    );
  },
});

/**
 * Get the active entitlement for a subject and product.
 * Returns null if no active entitlement exists.
 */
export const getActiveEntitlement = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    productId: v.string(),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      entitlement: EntitlementReadRecord,
    }),
    v.object({
      found: v.literal(false),
      entitlement: v.null(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const subject = await ctx.db.get(args.subjectId);
    const entitlement = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
      )
      .filter((q) => q.eq(q.field('productId'), args.productId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    if (!entitlement || subject?.status !== 'active') {
      return { found: false as const, entitlement: null };
    }

    return {
      found: true as const,
      entitlement: normalizeEntitlementReadRecord(entitlement),
    };
  },
});

/**
 * Stats overview for bot /yucp stats.
 */
export const getStatsOverview = query({
  args: { apiSecret: v.string(), actor: ApiActorBindingV, authUserId: v.string() },
  returns: v.object({
    totalVerified: v.number(),
    totalProducts: v.number(),
    recentGrantsCount: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const activeEntitlements = await listActiveEntitlementsForActiveSubjects(
      ctx,
      args.authUserId,
      1000
    );
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
 * Extended stats overview with 24h, 7d, 30d verification counts.
 */
export const getStatsOverviewExtended = query({
  args: { apiSecret: v.string(), actor: ApiActorBindingV, authUserId: v.string() },
  returns: v.object({
    totalVerified: v.number(),
    totalProducts: v.number(),
    recent24h: v.number(),
    recent7d: v.number(),
    recent30d: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const activeEntitlements = await listActiveEntitlementsForActiveSubjects(
      ctx,
      args.authUserId,
      1000
    );
    const uniqueSubjects = new Set(activeEntitlements.map((e) => e.subjectId));
    const uniqueProducts = new Set(activeEntitlements.map((e) => e.productId));
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const recent24h = activeEntitlements.filter((e) => e.grantedAt >= oneDayAgo).length;
    const recent7d = activeEntitlements.filter((e) => e.grantedAt >= sevenDaysAgo).length;
    const recent30d = activeEntitlements.filter((e) => e.grantedAt >= thirtyDaysAgo).length;
    return {
      totalVerified: uniqueSubjects.size,
      totalProducts: uniqueProducts.size,
      recent24h,
      recent7d,
      recent30d,
    };
  },
});

/**
 * Verified users for tenant (paginated, for /yucp stats verified).
 */
export const getVerifiedUsersPaginated = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
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
      })
    ),
    nextCursor: v.optional(v.string()),
    totalCount: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const limit = Math.min(args.limit ?? 25, 50);
    const activeEntitlements = await listActiveEntitlementsForActiveSubjects(
      ctx,
      args.authUserId,
      5000
    ); // cap to prevent OOM; pagination handles larger sets
    const bySubject = new Map<string, { productIds: Set<string> }>();
    for (const e of activeEntitlements) {
      const existing = bySubject.get(e.subjectId);
      if (existing) {
        existing.productIds.add(e.productId);
      } else {
        bySubject.set(e.subjectId, { productIds: new Set([e.productId]) });
      }
    }
    const subjectIds = Array.from(bySubject.keys()).sort();
    const totalCount = subjectIds.length;
    const cursorIndex = args.cursor ? subjectIds.indexOf(args.cursor) : -1;
    const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const slice = subjectIds.slice(start, start + limit);
    const users: Array<{
      subjectId: Id<'subjects'>;
      discordUserId: string;
      displayName?: string;
      productCount: number;
    }> = [];
    for (const sid of slice) {
      const subject = await ctx.db.get(sid as Id<'subjects'>);
      const data = bySubject.get(sid);
      if (!data) {
        continue;
      }
      if (subject?.status === 'active') {
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
    return { users, nextCursor, totalCount };
  },
});

/**
 * Product verification counts for /yucp stats products.
 */
export const getProductStats = query({
  args: { apiSecret: v.string(), actor: ApiActorBindingV, authUserId: v.string() },
  returns: v.array(
    v.object({
      productId: v.string(),
      verifiedCount: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const activeEntitlements = await listActiveEntitlementsForActiveSubjects(
      ctx,
      args.authUserId,
      5000
    ); // cap to prevent OOM
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
    actor: ApiActorBindingV,
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    productId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const subject = await ctx.db.get(args.subjectId);
    if (subject?.status !== 'active') {
      return false;
    }
    const entitlement = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
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
    actor: ApiActorBindingV,
    entitlementId: v.id('entitlements'),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      entitlement: EntitlementReadRecord,
    }),
    v.object({
      found: v.literal(false),
      entitlement: v.null(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['entitlements:service']);
    const entitlement = await ctx.db.get(args.entitlementId);

    if (!entitlement) {
      return { found: false as const, entitlement: null };
    }

    return {
      found: true as const,
      entitlement: normalizeEntitlementReadRecord(entitlement),
    };
  },
});

/**
 * Internal (ungated) variant of getEntitlement for the role-sync Workpool
 * action, which runs inside Convex and cannot pass the API secret/service actor.
 * Not client-callable. Returns the normalized read record (incl. status,
 * productId) or null.
 */
export const getEntitlementInternal = internalQuery({
  args: {
    entitlementId: v.id('entitlements'),
  },
  returns: v.union(InternalEntitlementReadRecord, v.null()),
  handler: async (ctx, args) => {
    const entitlement = await ctx.db.get(args.entitlementId);
    if (!entitlement) {
      return null;
    }
    return normalizeInternalEntitlementReadRecord(entitlement);
  },
});

/**
 * Get entitlements by provider customer.
 * Used for purchaser memory lookup to find supported products.
 */
export const getEntitlementsByProviderCustomer = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    providerCustomerId: v.id('provider_customers'),
  },
  returns: v.array(EntitlementReadRecord),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_provider_customer', (q) => q.eq('providerCustomerId', args.providerCustomerId))
      .filter((q) => q.eq(q.field('authUserId'), args.authUserId))
      .collect();

    return entitlements.map((entitlement) => normalizeEntitlementReadRecord(entitlement));
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
    actor: ApiActorBindingV,
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    productId: v.string(),
    evidence: ProviderEvidence,
    catalogProductId: v.optional(v.id('product_catalog')),
    correlationId: v.optional(v.string()),
  },
  returns: GrantResult,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const now = Date.now();
    const subject = await requireActiveSubject(ctx, args.subjectId);

    // Validate purchasedAt timestamp if provided
    if (args.evidence.purchasedAt !== undefined) {
      if (args.evidence.purchasedAt > now + 5 * 60 * 1000) {
        throw new ConvexError('purchasedAt cannot be more than 5 minutes in the future');
      }
    }

    if (args.evidence.amount !== undefined) {
      if (args.evidence.amount < 0) throw new ConvexError('amount cannot be negative');
      if (args.evidence.amount > 999999.99)
        throw new ConvexError('amount exceeds maximum allowed value');
    }
    const evidenceMetadata =
      args.evidence.amount !== undefined || args.evidence.currency !== undefined
        ? {
            amount: args.evidence.amount,
            currency: args.evidence.currency,
          }
        : undefined;

    // Get creator profile for policy snapshot
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!profile) {
      throw new Error(`Creator profile not found: ${args.authUserId}`);
    }

    const policySnapshotVersion = await getPolicySnapshotVersion(ctx, args.authUserId);
    const grantResult = await grantEntitlementFromFunnel(ctx, {
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      subject,
      productId: args.productId,
      sourceProvider: args.evidence.provider,
      sourceReference: args.evidence.sourceReference,
      providerCustomerId: args.evidence.providerCustomerId,
      catalogProductId: args.catalogProductId,
      policySnapshotVersion,
      grantedAt: args.evidence.purchasedAt ?? now,
      now,
      existingLookup: { mode: 'sourceReference' },
      reactivation: { allowTerminal: false },
      roleSync: {
        mode: 'primaryDiscordUserId',
        lifecycleAt: now,
        requireDiscordUserId: false,
        missingSubject: 'throw',
      },
      evidence: {
        authUserId: args.authUserId,
        subjectId: args.subjectId,
        providerKey: args.evidence.provider,
        sourceReference: args.evidence.sourceReference,
        evidenceType: 'provider_evidence',
        status: 'active',
        productId: args.productId,
        catalogProductId: args.catalogProductId,
        metadata: evidenceMetadata,
        observedAt: args.evidence.purchasedAt ?? now,
        createdAt: now,
        updatedAt: now,
        lookupFilters: {
          authUserId: true,
          subjectId: true,
          productId: true,
          evidenceType: true,
        },
      },
      audit: {
        emitForNew: true,
        emitForReactivated: true,
        correlationId: args.correlationId,
      },
    });

    return {
      success: true,
      entitlementId: grantResult.entitlementId,
      isNew: grantResult.isNew,
      previousStatus: grantResult.previousStatus,
      outboxJobId: grantResult.outboxJobIds[0],
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
    actor: ApiActorBindingV,
    authUserId: v.string(),
    entitlementId: v.id('entitlements'),
    reason: RevocationReason,
    details: v.optional(v.string()),
    correlationId: v.optional(v.string()),
  },
  returns: RevokeResult,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const now = Date.now();

    const entitlement = await ctx.db.get(args.entitlementId);
    if (!entitlement) {
      throw new Error(`Entitlement not found: ${args.entitlementId}`);
    }

    if (entitlement.authUserId !== args.authUserId) {
      throw new ConvexError('Unauthorized: not the owner');
    }

    const previousStatus = entitlement.status;

    // Don't revoke if already in a terminal state
    if (!isEntitlementActive(previousStatus as Parameters<typeof isEntitlementActive>[0])) {
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
      entitlement.authUserId,
      entitlement.subjectId,
      entitlement.productId,
      args.entitlementId,
      args.correlationId,
      now
    );

    // Create audit event
    await createAuditEvent(ctx, {
      authUserId: entitlement.authUserId,
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
 * Revoke an active entitlement by its sourceReference.
 * Used by reconciliation paths that discover a refunded/cancelled record and need to
 * revoke an existing entitlement without knowing its document ID.
 */
export const revokeEntitlementBySourceRef = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    sourceReference: v.string(),
    reason: v.optional(RevocationReason),
    correlationId: v.optional(v.string()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const now = Date.now();

    const entitlement = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
      )
      .filter((q) => q.eq(q.field('sourceReference'), args.sourceReference))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    if (!entitlement) return { success: false };

    const newStatus = args.reason ? mapReasonToStatus(args.reason) : 'refunded';

    await ctx.db.patch(entitlement._id, {
      status: newStatus,
      revokedAt: now,
      updatedAt: now,
    });

    await emitRoleRemovalJobs(
      ctx,
      args.authUserId,
      args.subjectId,
      entitlement.productId,
      entitlement._id,
      args.correlationId,
      now
    );

    await createAuditEvent(ctx, {
      authUserId: args.authUserId,
      eventType: 'entitlement.revoked',
      subjectId: args.subjectId,
      entitlementId: entitlement._id,
      metadata: {
        productId: entitlement.productId,
        reason: args.reason ?? 'refunded',
        sourceReference: args.sourceReference,
        previousStatus: 'active',
        newStatus,
      },
      correlationId: args.correlationId,
    });

    return { success: true };
  },
});

/**
 * Revoke every active entitlement from one provider source reference.
 *
 * Source references can legitimately fan out to multiple buyer subjects, such as a
 * reusable manual license. Callers use this shared lifecycle path so entitlement
 * revocation, role removal, and audit records remain consistent.
 */
export const ACTIVE_ENTITLEMENT_SOURCE_REVOCATION_BATCH_SIZE = 100;

export async function revokeActiveEntitlementsBySourceReference(
  ctx: MutationCtx,
  params: {
    authUserId: string;
    sourceProvider: Doc<'entitlements'>['sourceProvider'];
    sourceReference: string;
    reason: Parameters<typeof mapReasonToStatus>[0];
    details?: string;
    correlationId?: string;
    now?: number;
  }
): Promise<{ revokedCount: number; outboxJobIds: Id<'outbox_jobs'>[]; hasMore: boolean }> {
  const now = params.now ?? Date.now();
  const newStatus = mapReasonToStatus(params.reason);
  const entitlements = await ctx.db
    .query('entitlements')
    .withIndex('by_auth_user_source_provider_reference_status', (q) =>
      q
        .eq('authUserId', params.authUserId)
        .eq('sourceProvider', params.sourceProvider)
        .eq('sourceReference', params.sourceReference)
        .eq('status', 'active')
    )
    .take(ACTIVE_ENTITLEMENT_SOURCE_REVOCATION_BATCH_SIZE);
  const outboxJobIds: Id<'outbox_jobs'>[] = [];

  for (const entitlement of entitlements) {
    await ctx.db.patch(entitlement._id, {
      status: newStatus,
      revokedAt: now,
      updatedAt: now,
    });

    outboxJobIds.push(
      ...(await emitRoleRemovalJobs(
        ctx,
        entitlement.authUserId,
        entitlement.subjectId,
        entitlement.productId,
        entitlement._id,
        params.correlationId,
        now
      ))
    );

    await createAuditEvent(ctx, {
      authUserId: entitlement.authUserId,
      eventType: 'entitlement.revoked',
      subjectId: entitlement.subjectId,
      entitlementId: entitlement._id,
      metadata: {
        productId: entitlement.productId,
        reason: params.reason,
        details: params.details,
        sourceReference: params.sourceReference,
        previousStatus: entitlement.status,
        newStatus,
      },
      correlationId: params.correlationId,
    });
  }

  return {
    revokedCount: entitlements.length,
    outboxJobIds,
    hasMore: entitlements.length === ACTIVE_ENTITLEMENT_SOURCE_REVOCATION_BATCH_SIZE,
  };
}

/**
 * Revoke one bounded page of entitlements created by a reusable manual license.
 *
 * A license can have many redemptions, so each transaction handles only one
 * page and schedules another one when active rows remain. Re-running a page is
 * safe because only still-active entitlements are selected.
 */
export const revokeManualLicenseEntitlementCascadeChunk = internalMutation({
  args: {
    authUserId: v.string(),
    sourceReference: v.string(),
    details: v.optional(v.string()),
    correlationId: v.string(),
    revokedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const { hasMore } = await revokeActiveEntitlementsBySourceReference(ctx, {
      authUserId: args.authUserId,
      sourceProvider: 'manual',
      sourceReference: args.sourceReference,
      reason: 'manual',
      details: args.details,
      correlationId: args.correlationId,
      now: args.revokedAt,
    });

    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.entitlements.revokeManualLicenseEntitlementCascadeChunk, args);
    }
  },
});

/**
 * Revoke all entitlements for a subject in a tenant.
 * Used when user disconnects their last account - no remaining proof of ownership.
 */
export const revokeAllEntitlementsForSubject = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    subjectId: v.id('subjects'),
  },
  returns: v.object({
    revokedCount: v.number(),
    outboxJobIds: v.array(v.id('outbox_jobs')),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const now = Date.now();
    const outboxJobIds: Id<'outbox_jobs'>[] = [];

    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
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
        args.authUserId,
        args.subjectId,
        entitlement.productId,
        entitlement._id,
        'disconnect:all',
        now
      );
      outboxJobIds.push(...jobIds);

      await createAuditEvent(ctx, {
        authUserId: args.authUserId,
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
    actor: ApiActorBindingV,
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    provider: v.string(),
  },
  returns: v.object({
    revokedCount: v.number(),
    outboxJobIds: v.array(v.id('outbox_jobs')),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const now = Date.now();
    const outboxJobIds: Id<'outbox_jobs'>[] = [];

    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
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
        args.authUserId,
        args.subjectId,
        entitlement.productId,
        entitlement._id,
        `disconnect:${args.provider}`,
        now
      );
      outboxJobIds.push(...jobIds);

      await createAuditEvent(ctx, {
        authUserId: args.authUserId,
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
    actor: ApiActorBindingV,
    authUserId: v.string(),
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
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .first();

    if (!subject) {
      return { success: false, reason: 'not_found', revokedCount: 0 };
    }

    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', subject._id)
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
        args.authUserId,
        subject._id,
        args.productId,
        ent._id,
        `unverify:${Date.now()}`,
        now
      );

      await createAuditEvent(ctx, {
        authUserId: args.authUserId,
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
    actor: ApiActorBindingV,
    authUserId: v.string(),
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
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const now = Date.now();

    const entitlement = await ctx.db.get(args.entitlementId);
    if (!entitlement) {
      throw new Error(`Entitlement not found: ${args.entitlementId}`);
    }

    if (entitlement.authUserId !== args.authUserId) {
      throw new ConvexError('Unauthorized: not the owner');
    }

    // Update entitlement with fresh evidence
    await ctx.db.patch(args.entitlementId, {
      providerCustomerId: args.evidence.providerCustomerId ?? entitlement.providerCustomerId,
      updatedAt: now,
    });

    // Create audit event
    await createAuditEvent(ctx, {
      authUserId: entitlement.authUserId,
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
    actor: ApiActorBindingV,
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    providerCustomerId: v.id('provider_customers'),
    products: v.array(
      v.object({
        productId: v.string(),
        catalogProductId: v.optional(v.id('product_catalog')),
        sourceReference: v.string(),
        purchasedAt: v.optional(v.number()),
      })
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
    await requireServiceActor(args.actor, ['entitlements:service']);
    const now = Date.now();
    const entitlementIds: Id<'entitlements'>[] = [];
    let grantedCount = 0;
    let skippedCount = 0;

    // Get creator profile for policy snapshot
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!profile) {
      throw new Error(`Creator profile not found: ${args.authUserId}`);
    }

    const policySnapshotVersion = await getPolicySnapshotVersion(ctx, args.authUserId);

    // Resolve the actual provider from the provider_customer record
    const providerCustomerDoc = await ctx.db.get(args.providerCustomerId);
    const sourceProvider = providerCustomerDoc?.provider?.trim();

    for (const product of args.products) {
      if (!providerCustomerDoc) {
        await recordEntitlementGrantSkipped({
          provider: '',
          reason: 'provider_customer_missing',
          authUserId: args.authUserId,
          subjectId: args.subjectId,
          productId: product.productId,
        });
        skippedCount++;
        continue;
      }
      if (!sourceProvider) {
        await recordEntitlementGrantSkipped({
          provider: '',
          reason: 'source_provider_missing',
          authUserId: args.authUserId,
          subjectId: args.subjectId,
          productId: product.productId,
        });
        skippedCount++;
        continue;
      }

      const grantResult = await grantEntitlementFromFunnel(ctx, {
        authUserId: args.authUserId,
        subjectId: args.subjectId,
        productId: product.productId,
        sourceProvider,
        sourceReference: product.sourceReference,
        providerCustomerId: args.providerCustomerId,
        catalogProductId: product.catalogProductId,
        policySnapshotVersion,
        grantedAt: product.purchasedAt ?? now,
        now,
        existingLookup: { mode: 'activeProduct' },
        reactivation: { allowTerminal: true },
        roleSync: {
          mode: 'primaryDiscordUserId',
          lifecycleAt: now,
          requireDiscordUserId: false,
          missingSubject: 'throw',
        },
      });

      if (grantResult.outcome === 'skipped') {
        skippedCount++;
        continue;
      }

      entitlementIds.push(grantResult.entitlementId);
      grantedCount++;
    }

    // Create single audit event for batch
    if (grantedCount > 0) {
      await createAuditEvent(ctx, {
        authUserId: args.authUserId,
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
    actor: ApiActorBindingV,
    authUserId: v.string(),
    discordUserId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    jobsCreated: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    // Find subject
    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .first();

    if (!subject) {
      return { success: false, jobsCreated: 0 };
    }
    if (subject.status !== 'active') {
      throw new ConvexError(`Subject is not active: ${subject.status}`);
    }

    // Find active entitlements
    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', subject._id)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    let jobsCreated = 0;
    // Refresh is an explicit "re-apply my roles now" action. Use a unique
    // idempotency key per refresh so it always creates fresh, executable work
    // instead of deduping against a prior completed/dead-lettered job (which
    // would leave a verified-but-roleless user stuck).
    const correlationId = `refresh:${Date.now()}`;

    for (const ent of entitlements) {
      await enqueueRoleSync(ctx, {
        authUserId: args.authUserId,
        subjectId: subject._id,
        entitlementId: ent._id,
        discordUserId: subject.primaryDiscordUserId,
        idempotencyKey: `role_sync:${args.authUserId}:${subject._id}:${ent._id}:${correlationId}`,
      });
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
    actor: ApiActorBindingV,
    authUserId: v.string(),
    expirationThreshold: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
    expiredCount: v.number(),
    entitlementIds: v.array(v.id('entitlements')),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const now = Date.now();
    const entitlementIds: Id<'entitlements'>[] = [];
    let expiredCount = 0;

    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!profile) {
      throw new Error(`Creator profile not found: ${args.authUserId}`);
    }

    const { gracePeriodHours } = profile.policy ?? {};
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
      .withIndex('by_auth_user_status', (q) =>
        q.eq('authUserId', args.authUserId).eq('status', 'active')
      )
      .collect();

    for (const entitlement of activeEntitlements) {
      const computedExpiresAt = calculateGracePeriodEnd(entitlement.grantedAt, gracePeriodHours);
      if (computedExpiresAt === null) {
        continue;
      }
      const expiresAt = entitlement.expiresAt ?? computedExpiresAt;

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
          entitlement.authUserId,
          entitlement.subjectId,
          entitlement.productId,
          entitlement._id,
          undefined,
          now
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
async function getPolicySnapshotVersion(ctx: MutationCtx, authUserId: string): Promise<number> {
  // Simple hash-based versioning
  // Count existing entitlements to get a rough version number
  const existingEntitlements = await ctx.db
    .query('entitlements')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
    .collect();

  // Use the count as a simple version increment
  // In production, you'd want a proper policy version field on the tenant
  return existingEntitlements.length + 1;
}

/**
 * Emit a role sync job to the outbox.
 */
async function emitRoleSyncJob(
  ctx: MutationCtx,
  authUserId: string,
  subjectId: Id<'subjects'>,
  entitlementId: Id<'entitlements'>,
  _correlationId?: string,
  lifecycleAt?: number
): Promise<Id<'outbox_jobs'>> {
  const subject = await ctx.db.get(subjectId);
  if (!subject) {
    throw new Error(`Subject not found: ${subjectId}`);
  }

  const idempotencyKey = buildRoleSyncIdempotencyKey({
    authUserId,
    subjectId,
    entitlementId,
    ...(lifecycleAt !== undefined ? { lifecycle: { kind: 'grant', at: lifecycleAt } } : {}),
  });

  return enqueueRoleSync(ctx, {
    authUserId,
    subjectId,
    entitlementId,
    discordUserId: subject.primaryDiscordUserId,
    idempotencyKey,
  });
}

/**
 * Emit role removal jobs for all guilds with role rules for this product.
 */
async function emitRoleRemovalJobs(
  ctx: MutationCtx,
  authUserId: string,
  subjectId: Id<'subjects'>,
  productId: string,
  entitlementId: Id<'entitlements'>,
  _correlationId?: string,
  lifecycleAt?: number
): Promise<Id<'outbox_jobs'>[]> {
  const outboxJobIds: Id<'outbox_jobs'>[] = [];

  // Find all role rules for this product
  const roleRules = await ctx.db
    .query('role_rules')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
    .filter((q) => q.eq(q.field('productId'), productId))
    .filter((q) => q.eq(q.field('enabled'), true))
    .filter((q) => q.eq(q.field('removeOnRevoke'), true))
    .collect();

  // Get subject for Discord user ID
  const subject = await ctx.db.get(subjectId);

  for (const rule of roleRules) {
    const roleIds = rule.verifiedRoleIds ?? (rule.verifiedRoleId ? [rule.verifiedRoleId] : []);

    for (const roleId of roleIds) {
      const idempotencyKey = buildRoleRemovalIdempotencyKey({
        authUserId,
        subjectId,
        guildId: rule.guildId,
        productId,
        roleId,
        entitlementId,
        ...(lifecycleAt !== undefined ? { lifecycle: { kind: 'revoke', at: lifecycleAt } } : {}),
      });

      outboxJobIds.push(
        await enqueueRoleRemoval(ctx, {
          authUserId,
          subjectId,
          entitlementId,
          guildId: rule.guildId,
          roleId,
          discordUserId: subject?.primaryDiscordUserId,
          idempotencyKey,
        })
      );
    }
  }

  return outboxJobIds;
}

/**
 * Create an audit event.
 */
async function createAuditEvent(
  ctx: MutationCtx,
  params: {
    authUserId: string;
    eventType: 'entitlement.granted' | 'entitlement.revoked' | 'discord.role.sync.requested';
    subjectId?: Id<'subjects'>;
    entitlementId?: Id<'entitlements'>;
    metadata?: Record<string, unknown>;
    correlationId?: string;
  }
): Promise<void> {
  await ctx.db.insert('audit_events', {
    authUserId: params.authUserId,
    eventType: params.eventType,
    actorType: 'system',
    subjectId: params.subjectId,
    entitlementId: params.entitlementId,
    metadata: params.metadata,
    correlationId: params.correlationId,
    createdAt: Date.now(),
  });
}

// ============================================================================
// PUBLIC API QUERIES
// ============================================================================

export const listByAuthUser = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    subjectId: v.optional(v.string()),
    productId: v.optional(v.string()),
    status: v.optional(v.string()),
    sourceProvider: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    let all = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.subjectId) {
      all = all.filter((e) => String(e.subjectId) === args.subjectId);
    }
    if (args.productId) {
      all = all.filter((e) => e.productId === args.productId);
    }
    if (args.status) {
      all = all.filter((e) => e.status === args.status);
    }
    if (args.sourceProvider) {
      all = all.filter((e) => e.sourceProvider === args.sourceProvider);
    }

    const limit = Math.min(args.limit ?? 50, 100);
    let startIndex = 0;
    if (args.cursor) {
      const idx = all.findIndex((item) => String(item._id) === args.cursor);
      if (idx !== -1) startIndex = idx + 1;
    }
    const page = all.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < all.length;
    // Project: strip tenantId (deprecated), providerCustomerId (internal), and policySnapshotVersion (internal)
    const data = page.map((e) => ({
      id: e._id,
      subjectId: e.subjectId,
      productId: e.productId,
      sourceProvider: e.sourceProvider,
      sourceReference: e.sourceReference,
      catalogProductId: e.catalogProductId,
      status: e.status,
      grantedAt: e.grantedAt,
      revokedAt: e.revokedAt,
      expiresAt: e.expiresAt,
      updatedAt: e.updatedAt,
    }));
    return {
      data,
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    };
  },
});

export const getByIdForAuthUser = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    entitlementId: v.id('entitlements'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const e = await ctx.db.get(args.entitlementId);
    if (!e || e.authUserId !== args.authUserId) return null;
    // Project: strip tenantId (deprecated), providerCustomerId (internal), and policySnapshotVersion (internal)
    return {
      id: e._id,
      subjectId: e.subjectId,
      productId: e.productId,
      sourceProvider: e.sourceProvider,
      sourceReference: e.sourceReference,
      catalogProductId: e.catalogProductId,
      status: e.status,
      grantedAt: e.grantedAt,
      revokedAt: e.revokedAt,
      expiresAt: e.expiresAt,
      updatedAt: e.updatedAt,
    };
  },
});
