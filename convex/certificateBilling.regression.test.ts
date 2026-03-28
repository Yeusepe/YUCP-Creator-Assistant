import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import { buildCreatorProfileWorkspaceKey } from './lib/certificateBillingConfig';
import { makeTestConvex, seedCertificateBillingCatalog, seedCreatorProfile } from './testHelpers';

const originalConvexApiSecret = process.env.CONVEX_API_SECRET;
const originalPolarAccessToken = process.env.POLAR_ACCESS_TOKEN;
const originalPolarWebhookSecret = process.env.POLAR_WEBHOOK_SECRET;

async function seedBillingCatalog(t: ReturnType<typeof makeTestConvex>) {
  const now = Date.now();

  await t.run(async (ctx) => {
    await ctx.db.insert('creator_billing_catalog_products', {
      productId: 'prod_starter',
      slug: 'starter',
      displayName: 'Starter',
      description: 'Entry tier',
      status: 'active',
      sortOrder: 1,
      displayBadge: undefined,
      recurringInterval: 'month',
      recurringPriceIds: ['price_starter_monthly'],
      meteredPrices: [],
      benefitIds: ['benefit_starter_limits'],
      highlights: ['Up to 2 signing devices'],
      metadata: {
        yucp_domain: 'certificate_billing',
      },
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('creator_billing_catalog_products', {
      productId: 'prod_broken',
      slug: 'broken',
      displayName: 'Broken',
      description: 'Malformed tier',
      status: 'active',
      sortOrder: 2,
      displayBadge: undefined,
      recurringInterval: 'month',
      recurringPriceIds: ['price_broken_monthly'],
      meteredPrices: [],
      benefitIds: ['benefit_broken_limits'],
      highlights: ['Broken plan'],
      metadata: {
        yucp_domain: 'certificate_billing',
      },
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('creator_billing_catalog_benefits', {
      benefitId: 'benefit_starter_limits',
      type: 'custom',
      description: 'Starter limits',
      metadata: {
        device_cap: 2,
        audit_retention_days: 30,
        support_tier: 'standard',
        tier_rank: 1,
      },
      featureFlags: {},
      capabilityKeys: [],
      capabilityKey: undefined,
      deviceCap: 2,
      signQuotaPerPeriod: undefined,
      auditRetentionDays: 30,
      supportTier: 'standard',
      tierRank: 1,
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('creator_billing_catalog_benefits', {
      benefitId: 'benefit_broken_limits',
      type: 'custom',
      description: 'Broken limits',
      metadata: {
        device_cap: 10,
        audit_retention_days: 90,
        tier_rank: 2,
      },
      featureFlags: {},
      capabilityKeys: [],
      capabilityKey: undefined,
      deviceCap: 10,
      signQuotaPerPeriod: undefined,
      auditRetentionDays: 90,
      supportTier: undefined,
      tierRank: 2,
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('certificateBilling regressions', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-convex-secret';
    process.env.POLAR_ACCESS_TOKEN = 'test-polar-access-token';
    process.env.POLAR_WEBHOOK_SECRET = 'test-polar-webhook-secret';
  });

  afterEach(() => {
    process.env.CONVEX_API_SECRET = originalConvexApiSecret;
    process.env.POLAR_ACCESS_TOKEN = originalPolarAccessToken;
    process.env.POLAR_WEBHOOK_SECRET = originalPolarWebhookSecret;
    vi.restoreAllMocks();
  });

  it('skips malformed catalog rows when building available plans', async () => {
    const t = makeTestConvex();
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedBillingCatalog(t);

    const overview = await t.query(api.certificateBilling.getAccountOverview, {
      apiSecret: 'test-convex-secret',
      authUserId: 'creator-auth-user-1',
    });

    expect(overview.availablePlans).toHaveLength(1);
    expect(overview.availablePlans[0]).toMatchObject({
      planKey: 'starter',
      slug: 'starter',
      productId: 'prod_starter',
    });
    expect(warningSpy).toHaveBeenCalled();
  });

  it('skips malformed projected products and persists the stable plan key', async () => {
    const t = makeTestConvex();
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedBillingCatalog(t);

    const authUserId = 'creator-auth-user-2';
    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId,
      name: 'Projection Creator',
    });
    const workspaceKey = buildCreatorProfileWorkspaceKey(creatorProfileId);
    const now = Date.now();

    await t.mutation(api.certificateBilling.projectCustomerStateForApi, {
      apiSecret: 'test-convex-secret',
      authUserId,
      polarCustomerId: 'polar-customer-1',
      customerEmail: 'creator@example.com',
      activeSubscriptions: [
        {
          subscriptionId: 'sub_broken',
          productId: 'prod_broken',
          status: 'active',
          recurringInterval: 'month',
          currentPeriodStart: now,
          currentPeriodEnd: now + 86_400_000,
          cancelAtPeriodEnd: false,
          metadata: {
            workspace_key: workspaceKey,
          },
        },
        {
          subscriptionId: 'sub_starter',
          productId: 'prod_starter',
          status: 'active',
          recurringInterval: 'month',
          currentPeriodStart: now,
          currentPeriodEnd: now + 86_400_000,
          cancelAtPeriodEnd: false,
          metadata: {
            workspace_key: workspaceKey,
          },
        },
      ],
      grantedBenefits: [],
      activeMeters: [],
    });

    const state = await t.run(async (ctx) => {
      const account = await ctx.db
        .query('creator_billing_accounts')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
        .first();
      const entitlement = await ctx.db
        .query('creator_billing_entitlements')
        .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', workspaceKey))
        .first();
      const subscriptions = await ctx.db
        .query('creator_billing_subscriptions')
        .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', workspaceKey))
        .collect();

      return { account, entitlement, subscriptions };
    });

    expect(state.account).toMatchObject({
      workspaceKey,
      planKey: 'starter',
      productId: 'prod_starter',
      status: 'active',
    });
    expect(state.entitlement).toMatchObject({
      workspaceKey,
      planKey: 'starter',
      productId: 'prod_starter',
      status: 'active',
    });
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions.map((entry) => entry.planKey)).toEqual(['starter']);
    expect(warningSpy).toHaveBeenCalled();
  });

  it('resolves Polar catalog capabilities for legacy entitlement rows that only persisted planKey', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-auth-user-legacy-plan-key';
    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId,
      name: 'Legacy Plan Key Creator',
    });
    const workspaceKey = buildCreatorProfileWorkspaceKey(creatorProfileId);
    const now = Date.now();

    await seedCertificateBillingCatalog(t, {
      productId: 'prod_creator_suite',
      slug: 'creator-suite',
      displayName: 'Creator Suite',
      benefitMetadata: {
        coupling_traceability: true,
        device_cap: 3,
        audit_retention_days: 30,
        support_tier: 'standard',
        tier_rank: 1,
      },
      featureFlags: {
        coupling_traceability: true,
      },
      capabilityKeys: ['coupling_traceability'],
      capabilityKey: 'coupling_traceability',
      deviceCap: 3,
      auditRetentionDays: 30,
      supportTier: 'standard',
      tierRank: 1,
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('creator_billing_entitlements', {
        workspaceKey,
        authUserId,
        creatorProfileId,
        planKey: 'creator-suite',
        status: 'active',
        allowEnrollment: true,
        allowSigning: true,
        deviceCap: 3,
        auditRetentionDays: 30,
        supportTier: 'standard',
        currentPeriodEnd: now + 86_400_000,
        createdAt: now,
        updatedAt: now,
      });
    });

    const hasCapability = await t.query(api.certificateBilling.hasCapabilityForAuthUser, {
      authUserId,
      capabilityKey: 'coupling_traceability',
    });

    expect(hasCapability).toBe(true);
  });

  it('hides stale renewal and limit fields from the overview when a workspace becomes inactive', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-auth-user-inactive-cleanup';
    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId,
      name: 'Inactive Cleanup Creator',
    });
    const workspaceKey = buildCreatorProfileWorkspaceKey(creatorProfileId);
    const now = Date.now();

    await seedCertificateBillingCatalog(t, {
      productId: 'prod_creator_suite_plus',
      slug: 'creator-suite-plus',
      displayName: 'Creator Suite+',
      benefitMetadata: {
        device_cap: 3,
        audit_retention_days: 30,
        support_tier: 'standard',
        tier_rank: 1,
      },
      deviceCap: 3,
      auditRetentionDays: 30,
      supportTier: 'standard',
      tierRank: 1,
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('creator_billing_accounts', {
        workspaceKey,
        authUserId,
        creatorProfileId,
        polarCustomerId: 'polar-customer-inactive-cleanup',
        polarExternalId: authUserId,
        planKey: 'creator-suite-plus',
        productId: 'prod_creator_suite_plus',
        status: 'active',
        customerEmail: 'cleanup@example.com',
        currentPeriodEnd: now + 86_400_000,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('creator_billing_entitlements', {
        workspaceKey,
        authUserId,
        creatorProfileId,
        planKey: 'creator-suite-plus',
        productId: 'prod_creator_suite_plus',
        status: 'active',
        allowEnrollment: true,
        allowSigning: true,
        deviceCap: 3,
        signQuotaPerPeriod: 1000,
        auditRetentionDays: 30,
        supportTier: 'standard',
        currentPeriodEnd: now + 86_400_000,
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.mutation(api.certificateBilling.projectCustomerStateForApi, {
      apiSecret: 'test-convex-secret',
      authUserId,
      polarCustomerId: 'polar-customer-inactive-cleanup',
      customerEmail: 'cleanup@example.com',
      activeSubscriptions: [],
      grantedBenefits: [],
      activeMeters: [],
    });

    const state = await t.run(async (ctx) => {
      const account = await ctx.db
        .query('creator_billing_accounts')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
        .first();
      const entitlement = await ctx.db
        .query('creator_billing_entitlements')
        .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', workspaceKey))
        .first();

      return { account, entitlement };
    });
    const overview = await t.query(api.certificateBilling.getAccountOverview, {
      apiSecret: 'test-convex-secret',
      authUserId,
    });

    expect(state.account).toMatchObject({
      workspaceKey,
      status: 'inactive',
    });
    expect(state.account?.currentPeriodEnd).toBeUndefined();
    expect(state.entitlement).toMatchObject({
      workspaceKey,
      status: 'inactive',
      allowEnrollment: false,
      allowSigning: false,
    });
    expect(state.entitlement?.currentPeriodEnd).toBeUndefined();
    expect(overview.billing).toMatchObject({
      status: 'inactive',
      allowEnrollment: false,
      allowSigning: false,
      activeDeviceCount: 0,
      reason: 'Certificate subscription required',
    });
    expect(overview.billing.planKey).toBeUndefined();
    expect(overview.billing.productId).toBeUndefined();
    expect(overview.billing.deviceCap).toBeUndefined();
    expect(overview.billing.signQuotaPerPeriod).toBeUndefined();
    expect(overview.billing.auditRetentionDays).toBeUndefined();
    expect(overview.billing.supportTier).toBeUndefined();
    expect(overview.billing.currentPeriodEnd).toBeUndefined();
  });
});
