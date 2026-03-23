import { ConvexError, v } from 'convex/values';
import { type QueryCtx, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import {
  buildAuthUserWorkspaceKey,
  extractWorkspaceKeyFromMetadata,
  getCertificateBillingConfig,
  getPlanForProductId,
  resolveWorkspaceKeys,
} from './lib/certificateBillingConfig';
import { summarizeActiveCertificatesByDevice } from './yucpCertificates';

type BillingStatus = 'active' | 'grace' | 'inactive' | 'suspended';

const accountOverviewReturnValidator = v.object({
  workspaceKey: v.string(),
  creatorProfileId: v.optional(v.string()),
  billing: v.object({
    billingEnabled: v.boolean(),
    status: v.string(),
    allowEnrollment: v.boolean(),
    allowSigning: v.boolean(),
    planKey: v.optional(v.string()),
    deviceCap: v.optional(v.number()),
    activeDeviceCount: v.number(),
    signQuotaPerPeriod: v.optional(v.number()),
    auditRetentionDays: v.optional(v.number()),
    supportTier: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    graceUntil: v.optional(v.number()),
    reason: v.optional(v.string()),
  }),
  devices: v.array(
    v.object({
      certNonce: v.string(),
      devPublicKey: v.string(),
      publisherId: v.string(),
      publisherName: v.string(),
      issuedAt: v.number(),
      expiresAt: v.number(),
      status: v.string(),
    })
  ),
  availablePlans: v.array(
    v.object({
      planKey: v.string(),
      slug: v.string(),
      productId: v.string(),
      displayName: v.string(),
      description: v.optional(v.string()),
      highlights: v.array(v.string()),
      priority: v.number(),
      deviceCap: v.number(),
      signQuotaPerPeriod: v.optional(v.number()),
      auditRetentionDays: v.number(),
      supportTier: v.string(),
      billingGraceDays: v.number(),
    })
  ),
});

function compareBillingStatus(left: BillingStatus, right: BillingStatus): number {
  const order: Record<BillingStatus, number> = {
    active: 4,
    grace: 3,
    inactive: 2,
    suspended: 1,
  };
  return order[left] - order[right];
}

function selectWinningCertificateEntitlement<
  T extends {
    status: BillingStatus;
    deviceCap?: number;
    workspaceKey: string;
    allowEnrollment: boolean;
    allowSigning: boolean;
    planKey?: string;
    signQuotaPerPeriod?: number;
    auditRetentionDays?: number;
    supportTier?: string;
    currentPeriodEnd?: number;
    graceUntil?: number;
  },
>(entitlements: T[]): T | null {
  return (
    entitlements.sort((left, right) => {
      const statusDiff = compareBillingStatus(right.status, left.status);
      if (statusDiff !== 0) return statusDiff;
      return (right.deviceCap ?? 0) - (left.deviceCap ?? 0);
    })[0] ?? null
  );
}

function buildAvailablePlans(config: ReturnType<typeof getCertificateBillingConfig>) {
  return [...config.products]
    .sort((left, right) => right.priority - left.priority)
    .map((plan) => ({
      planKey: plan.planKey,
      slug: plan.slug,
      productId: plan.productId,
      displayName: plan.displayName,
      description: plan.description,
      highlights: plan.highlights,
      priority: plan.priority,
      deviceCap: plan.deviceCap,
      signQuotaPerPeriod: plan.signQuotaPerPeriod ?? undefined,
      auditRetentionDays: plan.auditRetentionDays,
      supportTier: plan.supportTier,
      billingGraceDays: plan.billingGraceDays,
    }));
}

async function buildAccountOverview(ctx: QueryCtx, authUserId: string) {
  const config = getCertificateBillingConfig();
  const creatorProfile = await ctx.db
    .query('creator_profiles')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
    .first();
  const workspaceKeys = resolveWorkspaceKeys(authUserId, creatorProfile?._id ?? null);
  const entitlements = await ctx.db
    .query('creator_billing_entitlements')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
    .collect();
  const certificateEntitlements = selectWinningCertificateEntitlement(
    entitlements.filter((entry) => workspaceKeys.includes(entry.workspaceKey))
  );
  const certificates = await ctx.db
    .query('yucp_certificates')
    .withIndex('by_yucp_user_id', (q) => q.eq('yucpUserId', authUserId))
    .collect();
  const devices = summarizeActiveCertificatesByDevice(certificates);
  const workspaceKey = certificateEntitlements?.workspaceKey ?? workspaceKeys[0];

  return {
    workspaceKey,
    creatorProfileId: creatorProfile?._id,
    billing: {
      billingEnabled: config.enabled,
      status:
        certificateEntitlements?.status ??
        (config.enabled ? ('inactive' as const) : ('unmanaged' as const)),
      allowEnrollment: certificateEntitlements?.allowEnrollment ?? !config.enabled,
      allowSigning: certificateEntitlements?.allowSigning ?? !config.enabled,
      planKey: certificateEntitlements?.planKey,
      deviceCap: certificateEntitlements?.deviceCap,
      activeDeviceCount: devices.length,
      signQuotaPerPeriod: certificateEntitlements?.signQuotaPerPeriod,
      auditRetentionDays: certificateEntitlements?.auditRetentionDays,
      supportTier: certificateEntitlements?.supportTier,
      currentPeriodEnd: certificateEntitlements?.currentPeriodEnd,
      graceUntil: certificateEntitlements?.graceUntil,
      reason:
        certificateEntitlements?.status === 'grace'
          ? 'Billing grace period active. Existing devices can continue signing, but new enrollment is blocked.'
          : certificateEntitlements
            ? undefined
            : config.enabled
              ? 'Certificate subscription required'
              : undefined,
    },
    devices: devices.map((device) => ({
      certNonce: device.certNonce,
      devPublicKey: device.devPublicKey,
      publisherId: device.publisherId,
      publisherName: device.publisherName,
      issuedAt: device.issuedAt,
      expiresAt: device.expiresAt,
      status: device.status,
    })),
    availablePlans: buildAvailablePlans(config),
  };
}

export const getAccountOverview = query({
  args: { apiSecret: v.string(), authUserId: v.string() },
  returns: accountOverviewReturnValidator,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await buildAccountOverview(ctx, args.authUserId);
  },
});

export const getOverviewForAuthUser = internalQuery({
  args: { authUserId: v.string() },
  returns: accountOverviewReturnValidator,
  handler: async (ctx, args) => {
    return await buildAccountOverview(ctx, args.authUserId);
  },
});

export const revokeOwnedCertificate = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    certNonce: v.string(),
    reason: v.string(),
  },
  returns: v.object({ revoked: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const cert = await ctx.db
      .query('yucp_certificates')
      .withIndex('by_cert_nonce', (q) => q.eq('certNonce', args.certNonce))
      .first();

    if (!cert) {
      throw new ConvexError('Certificate not found');
    }
    if (cert.yucpUserId !== args.authUserId) {
      throw new ConvexError('Unauthorized: certificate does not belong to this user');
    }

    await ctx.db.patch(cert._id, {
      status: 'revoked',
      revocationReason: args.reason,
      revokedAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { revoked: true };
  },
});

export const resolveForAuthUser = internalQuery({
  args: { authUserId: v.string() },
  returns: v.object({
    billingEnabled: v.boolean(),
    workspaceKey: v.optional(v.string()),
    status: v.string(),
    allowEnrollment: v.boolean(),
    allowSigning: v.boolean(),
    planKey: v.optional(v.string()),
    deviceCap: v.optional(v.number()),
    signQuotaPerPeriod: v.optional(v.number()),
    auditRetentionDays: v.optional(v.number()),
    supportTier: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    graceUntil: v.optional(v.number()),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const config = getCertificateBillingConfig();
    if (!config.enabled) {
      return {
        billingEnabled: false,
        status: 'unmanaged',
        allowEnrollment: true,
        allowSigning: true,
        reason: undefined,
      };
    }

    const creatorProfile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    const workspaceKeys = resolveWorkspaceKeys(args.authUserId, creatorProfile?._id ?? null);
    const entitlements = await ctx.db
      .query('creator_billing_entitlements')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    const matches = entitlements.filter((entry) => workspaceKeys.includes(entry.workspaceKey));
    if (matches.length === 0) {
      return {
        billingEnabled: true,
        status: 'inactive',
        allowEnrollment: false,
        allowSigning: false,
        reason: 'Certificate subscription required',
      };
    }

    const winner = matches.sort((left, right) => {
      const statusDiff = compareBillingStatus(right.status, left.status);
      if (statusDiff !== 0) return statusDiff;
      return (right.deviceCap ?? 0) - (left.deviceCap ?? 0);
    })[0];

    return {
      billingEnabled: true,
      workspaceKey: winner.workspaceKey,
      status: winner.status,
      allowEnrollment: winner.allowEnrollment,
      allowSigning: winner.allowSigning,
      planKey: winner.planKey,
      deviceCap: winner.deviceCap,
      signQuotaPerPeriod: winner.signQuotaPerPeriod ?? undefined,
      auditRetentionDays: winner.auditRetentionDays,
      supportTier: winner.supportTier,
      currentPeriodEnd: winner.currentPeriodEnd ?? undefined,
      graceUntil: winner.graceUntil ?? undefined,
      reason:
        winner.status === 'grace'
          ? 'Billing grace period active. Existing devices can continue signing, but new enrollment is blocked.'
          : winner.allowSigning
            ? undefined
            : 'Certificate subscription required',
    };
  },
});

export const projectCustomerStateChanged = internalMutation({
  args: {
    authUserId: v.string(),
    polarCustomerId: v.string(),
    customerEmail: v.string(),
    activeSubscriptions: v.array(
      v.object({
        subscriptionId: v.string(),
        productId: v.string(),
        status: v.string(),
        recurringInterval: v.string(),
        currentPeriodStart: v.number(),
        currentPeriodEnd: v.number(),
        cancelAtPeriodEnd: v.boolean(),
        metadata: v.record(v.string(), v.union(v.string(), v.number(), v.boolean())),
      })
    ),
  },
  returns: v.object({
    updated: v.boolean(),
    workspaceCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const config = getCertificateBillingConfig();
    if (!config.enabled) {
      return { updated: false, workspaceCount: 0 };
    }

    const now = Date.now();
    const creatorProfile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    const defaultWorkspaceKey = creatorProfile?._id
      ? `creator-profile:${creatorProfile._id}`
      : buildAuthUserWorkspaceKey(args.authUserId);

    const activeByWorkspace = new Map<
      string,
      Array<{
        subscriptionId: string;
        productId: string;
        status: string;
        recurringInterval: string;
        currentPeriodStart: number;
        currentPeriodEnd: number;
        cancelAtPeriodEnd: boolean;
        metadata: Record<string, string | number | boolean>;
      }>
    >();

    for (const subscription of args.activeSubscriptions) {
      const plan = getPlanForProductId(config, subscription.productId);
      if (!plan) continue;
      const workspaceKey = extractWorkspaceKeyFromMetadata(
        subscription.metadata,
        defaultWorkspaceKey
      );
      const entries = activeByWorkspace.get(workspaceKey) ?? [];
      entries.push(subscription);
      activeByWorkspace.set(workspaceKey, entries);
    }

    const existingAccounts = await ctx.db
      .query('creator_billing_accounts')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();
    const existingByWorkspace = new Map(
      existingAccounts.map((entry) => [entry.workspaceKey, entry])
    );

    for (const [workspaceKey, subscriptions] of activeByWorkspace.entries()) {
      const matchingPlans = subscriptions
        .map((subscription) => ({
          subscription,
          plan: getPlanForProductId(config, subscription.productId),
        }))
        .filter(
          (
            entry
          ): entry is {
            subscription: (typeof subscriptions)[number];
            plan: NonNullable<ReturnType<typeof getPlanForProductId>>;
          } => entry.plan !== null
        )
        .sort((left, right) => right.plan.priority - left.plan.priority);

      const winningPlan = matchingPlans[0]?.plan;
      if (!winningPlan) continue;

      const account = existingByWorkspace.get(workspaceKey);
      const currentPeriodEnd = Math.max(
        ...subscriptions.map((subscription) => subscription.currentPeriodEnd)
      );
      const graceUntil = currentPeriodEnd + winningPlan.billingGraceDays * 24 * 60 * 60 * 1000;

      if (account) {
        await ctx.db.patch(account._id, {
          creatorProfileId: creatorProfile?._id,
          polarCustomerId: args.polarCustomerId,
          polarExternalId: args.authUserId,
          workspaceKey,
          planKey: winningPlan.planKey,
          status: 'active',
          customerEmail: args.customerEmail,
          currentPeriodEnd,
          graceUntil,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('creator_billing_accounts', {
          workspaceKey,
          authUserId: args.authUserId,
          creatorProfileId: creatorProfile?._id,
          polarCustomerId: args.polarCustomerId,
          polarExternalId: args.authUserId,
          planKey: winningPlan.planKey,
          status: 'active',
          customerEmail: args.customerEmail,
          currentPeriodEnd,
          graceUntil,
          createdAt: now,
          updatedAt: now,
        });
      }

      const entitlement = await ctx.db
        .query('creator_billing_entitlements')
        .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', workspaceKey))
        .first();

      const entitlementPatch = {
        authUserId: args.authUserId,
        creatorProfileId: creatorProfile?._id,
        workspaceKey,
        planKey: winningPlan.planKey,
        status: 'active' as BillingStatus,
        allowEnrollment: true,
        allowSigning: true,
        deviceCap: winningPlan.deviceCap,
        signQuotaPerPeriod: winningPlan.signQuotaPerPeriod ?? undefined,
        auditRetentionDays: winningPlan.auditRetentionDays,
        supportTier: winningPlan.supportTier,
        currentPeriodEnd,
        graceUntil,
        updatedAt: now,
      };

      if (entitlement) {
        await ctx.db.patch(entitlement._id, entitlementPatch);
      } else {
        await ctx.db.insert('creator_billing_entitlements', {
          ...entitlementPatch,
          createdAt: now,
        });
      }

      const existingSubscriptions = await ctx.db
        .query('creator_billing_subscriptions')
        .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', workspaceKey))
        .collect();
      await Promise.all(existingSubscriptions.map((entry) => ctx.db.delete(entry._id)));

      for (const subscription of subscriptions) {
        await ctx.db.insert('creator_billing_subscriptions', {
          workspaceKey,
          authUserId: args.authUserId,
          creatorProfileId: creatorProfile?._id,
          polarSubscriptionId: subscription.subscriptionId,
          polarProductId: subscription.productId,
          planKey: winningPlan.planKey,
          status: subscription.status,
          recurringInterval: subscription.recurringInterval,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          metadataJson: JSON.stringify(subscription.metadata),
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    for (const existing of existingAccounts) {
      if (activeByWorkspace.has(existing.workspaceKey)) continue;

      const graceDays = existing.planKey
        ? (config.products.find((plan) => plan.planKey === existing.planKey)?.billingGraceDays ?? 3)
        : 3;
      const graceUntil =
        Math.max(existing.currentPeriodEnd ?? now, now) + graceDays * 24 * 60 * 60 * 1000;
      const nextStatus: BillingStatus = graceUntil > now ? 'grace' : 'suspended';

      await ctx.db.patch(existing._id, {
        status: nextStatus,
        graceUntil,
        updatedAt: now,
      });

      const entitlement = await ctx.db
        .query('creator_billing_entitlements')
        .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', existing.workspaceKey))
        .first();

      if (entitlement) {
        await ctx.db.patch(entitlement._id, {
          status: nextStatus,
          allowEnrollment: false,
          allowSigning: nextStatus === 'grace',
          graceUntil,
          updatedAt: now,
        });
      }
    }

    return { updated: true, workspaceCount: activeByWorkspace.size };
  },
});

export const recordSigningUsage = internalMutation({
  args: {
    authUserId: v.string(),
    workspaceKey: v.string(),
    certNonce: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('creator_billing_usage_events', {
      workspaceKey: args.workspaceKey,
      authUserId: args.authUserId,
      eventType: 'signature.recorded',
      quantity: 1,
      certNonce: args.certNonce,
      createdAt: Date.now(),
    });
  },
});
