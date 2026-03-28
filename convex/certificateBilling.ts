import { ConvexError, v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import {
  aggregateCertificateBillingBenefitEntitlements,
  type CertificateBillingCatalogBenefit,
  type CertificateBillingCatalogProduct,
  deriveCertificateBillingCapabilityKeys,
  deriveCertificateBillingFeatureFlags,
} from './lib/certificateBillingCatalog';
import {
  buildAuthUserWorkspaceKey,
  extractWorkspaceKeyFromMetadata,
  getCertificateBillingConfig,
  resolveWorkspaceKeys,
} from './lib/certificateBillingConfig';
import { projectWorkspaceCapabilities } from './lib/certificateCapabilityProjection';
import { createConvexLogger } from './lib/logger';
import { summarizeActiveCertificatesByDevice } from './yucpCertificates';

type BillingStatus = 'active' | 'grace' | 'inactive' | 'suspended';

type ProjectionBenefitGrant = {
  grantId: string;
  benefitId: string;
  benefitType: string;
  benefitMetadata: Record<string, string | number | boolean>;
};

type ProjectionMeter = {
  customerMeterId: string;
  meterId: string;
  consumedUnits: number;
  creditedUnits: number;
  balance: number;
};

type ProjectionSubscription = {
  subscriptionId: string;
  productId: string;
  status: string;
  recurringInterval: string;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  metadata: Record<string, string | number | boolean>;
};

const logger = createConvexLogger();

const resolveForAuthUserReturnValidator = v.object({
  billingEnabled: v.boolean(),
  workspaceKey: v.optional(v.string()),
  status: v.string(),
  allowEnrollment: v.boolean(),
  allowSigning: v.boolean(),
  planKey: v.optional(v.string()),
  productId: v.optional(v.string()),
  deviceCap: v.optional(v.number()),
  signQuotaPerPeriod: v.optional(v.number()),
  auditRetentionDays: v.optional(v.number()),
  supportTier: v.optional(v.string()),
  currentPeriodEnd: v.optional(v.number()),
  graceUntil: v.optional(v.number()),
  reason: v.optional(v.string()),
});

const shellBrandingReturnValidator = v.object({
  isPlus: v.boolean(),
  billingStatus: v.optional(v.string()),
});

const billingCapabilityStateValidator = v.object({
  capabilityKey: v.string(),
  status: v.string(),
});

const billingMeterStateValidator = v.object({
  meterId: v.string(),
  meterName: v.optional(v.string()),
  consumedUnits: v.number(),
  creditedUnits: v.number(),
  balance: v.number(),
});

const accountOverviewReturnValidator = v.object({
  workspaceKey: v.string(),
  creatorProfileId: v.optional(v.string()),
  billing: v.object({
    billingEnabled: v.boolean(),
    status: v.string(),
    allowEnrollment: v.boolean(),
    allowSigning: v.boolean(),
    planKey: v.optional(v.string()),
    productId: v.optional(v.string()),
    deviceCap: v.optional(v.number()),
    activeDeviceCount: v.number(),
    signQuotaPerPeriod: v.optional(v.number()),
    auditRetentionDays: v.optional(v.number()),
    supportTier: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    graceUntil: v.optional(v.number()),
    reason: v.optional(v.string()),
    capabilities: v.array(billingCapabilityStateValidator),
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
      displayBadge: v.optional(v.string()),
      deviceCap: v.number(),
      signQuotaPerPeriod: v.optional(v.number()),
      auditRetentionDays: v.number(),
      supportTier: v.string(),
      billingGraceDays: v.number(),
      capabilities: v.array(v.string()),
      meteredPrices: v.array(
        v.object({
          priceId: v.string(),
          meterId: v.string(),
          meterName: v.string(),
        })
      ),
    })
  ),
  meters: v.array(billingMeterStateValidator),
});

const customerStateProjectionSubscriptionValidator = v.object({
  subscriptionId: v.string(),
  productId: v.string(),
  status: v.string(),
  recurringInterval: v.string(),
  currentPeriodStart: v.number(),
  currentPeriodEnd: v.number(),
  cancelAtPeriodEnd: v.boolean(),
  metadata: v.record(v.string(), v.union(v.string(), v.number(), v.boolean())),
});

const customerStateProjectionBenefitGrantValidator = v.object({
  grantId: v.string(),
  benefitId: v.string(),
  benefitType: v.string(),
  benefitMetadata: v.record(v.string(), v.union(v.string(), v.number(), v.boolean())),
});

const customerStateProjectionMeterValidator = v.object({
  customerMeterId: v.string(),
  meterId: v.string(),
  consumedUnits: v.number(),
  creditedUnits: v.number(),
  balance: v.number(),
});

const customerStateProjectionArgsValidator = {
  authUserId: v.string(),
  polarCustomerId: v.string(),
  customerEmail: v.string(),
  activeSubscriptions: v.array(customerStateProjectionSubscriptionValidator),
  grantedBenefits: v.array(customerStateProjectionBenefitGrantValidator),
  activeMeters: v.array(customerStateProjectionMeterValidator),
} as const;

const customerStateProjectionReturnValidator = v.object({
  updated: v.boolean(),
  workspaceCount: v.number(),
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

function isLiveBillingStatus(status: BillingStatus | string | undefined): boolean {
  return status === 'active' || status === 'grace';
}

async function listWorkspaceCapabilities(
  ctx: QueryCtx | MutationCtx,
  workspaceKey: string
): Promise<Array<{ capabilityKey: string; status: string }>> {
  const rows = await ctx.db
    .query('creator_billing_capabilities')
    .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', workspaceKey))
    .collect();
  return rows
    .map((row) => ({
      capabilityKey: row.capabilityKey,
      status: row.status,
    }))
    .sort((left, right) => left.capabilityKey.localeCompare(right.capabilityKey));
}

async function listWorkspaceMeters(
  ctx: QueryCtx,
  workspaceKey: string
): Promise<
  Array<{
    meterId: string;
    meterName?: string;
    consumedUnits: number;
    creditedUnits: number;
    balance: number;
  }>
> {
  const rows = await ctx.db
    .query('creator_billing_meters')
    .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', workspaceKey))
    .collect();
  return rows
    .map((row) => ({
      meterId: row.meterId,
      meterName: row.meterName,
      consumedUnits: row.consumedUnits,
      creditedUnits: row.creditedUnits,
      balance: row.balance,
    }))
    .sort((left, right) => left.meterId.localeCompare(right.meterId));
}

async function loadCatalog(ctx: QueryCtx | MutationCtx): Promise<{
  products: CertificateBillingCatalogProduct[];
  productsById: Map<string, CertificateBillingCatalogProduct>;
  benefitsById: Map<string, CertificateBillingCatalogBenefit>;
}> {
  const [productRows, benefitRows] = await Promise.all([
    ctx.db.query('creator_billing_catalog_products').collect(),
    ctx.db.query('creator_billing_catalog_benefits').collect(),
  ]);

  const products = productRows
    .map((row) => ({
      productId: row.productId,
      slug: row.slug,
      displayName: row.displayName,
      description: row.description,
      status: row.status,
      sortOrder: row.sortOrder,
      displayBadge: row.displayBadge,
      recurringInterval: row.recurringInterval,
      recurringPriceIds: [...row.recurringPriceIds],
      meteredPrices: row.meteredPrices.map((price) => ({ ...price })),
      benefitIds: [...row.benefitIds],
      highlights: [...row.highlights],
      metadata: { ...row.metadata },
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder);

  const benefitsById = new Map<string, CertificateBillingCatalogBenefit>(
    benefitRows.map((row) => {
      const metadata = { ...row.metadata };
      const featureFlags =
        row.featureFlags && typeof row.featureFlags === 'object'
          ? { ...row.featureFlags }
          : deriveCertificateBillingFeatureFlags(row.type, metadata);
      const capabilityKeys =
        Array.isArray(row.capabilityKeys) && row.capabilityKeys.length > 0
          ? [...row.capabilityKeys]
          : deriveCertificateBillingCapabilityKeys(featureFlags);

      return [
        row.benefitId,
        {
          benefitId: row.benefitId,
          type: row.type,
          description: row.description,
          metadata,
          featureFlags,
          capabilityKeys,
          capabilityKey: row.capabilityKey ?? capabilityKeys[0],
          deviceCap: row.deviceCap,
          signQuotaPerPeriod: row.signQuotaPerPeriod,
          auditRetentionDays: row.auditRetentionDays,
          supportTier: row.supportTier,
          tierRank: row.tierRank,
        },
      ];
    })
  );

  return {
    products,
    productsById: new Map(products.map((product) => [product.productId, product])),
    benefitsById,
  };
}

function requireEntitlementMetadata(
  _workspaceKey: string,
  _productId: string,
  entitlements: ReturnType<typeof aggregateCertificateBillingBenefitEntitlements>
) {
  if (
    entitlements.deviceCap === undefined ||
    entitlements.auditRetentionDays === undefined ||
    !entitlements.supportTier
  ) {
    return null;
  }

  return {
    deviceCap: entitlements.deviceCap,
    auditRetentionDays: entitlements.auditRetentionDays,
    supportTier: entitlements.supportTier,
  };
}

function listMissingEntitlementMetadataFields(
  entitlements: ReturnType<typeof aggregateCertificateBillingBenefitEntitlements>
) {
  const missingFields: string[] = [];
  if (entitlements.deviceCap === undefined) missingFields.push('device_cap');
  if (entitlements.auditRetentionDays === undefined) missingFields.push('audit_retention_days');
  if (!entitlements.supportTier) missingFields.push('support_tier');
  return missingFields;
}

function deriveCatalogBenefitsForProduct(
  product: CertificateBillingCatalogProduct,
  benefitsById: Map<string, CertificateBillingCatalogBenefit>,
  activeGrantedBenefitIds?: Set<string>
) {
  return product.benefitIds
    .filter((benefitId) => !activeGrantedBenefitIds || activeGrantedBenefitIds.has(benefitId))
    .map((benefitId) => benefitsById.get(benefitId))
    .filter((benefit): benefit is CertificateBillingCatalogBenefit => benefit !== undefined);
}

function buildAvailablePlans(
  products: CertificateBillingCatalogProduct[],
  benefitsById: Map<string, CertificateBillingCatalogBenefit>
) {
  return products
    .filter((product) => product.status === 'active')
    .map((product) => {
      const benefits = deriveCatalogBenefitsForProduct(product, benefitsById);
      const entitlements = aggregateCertificateBillingBenefitEntitlements(benefits);
      const required = requireEntitlementMetadata('catalog', product.productId, entitlements);
      if (!required) {
        logger.warn('Skipping certificate billing product with malformed metadata', {
          workspaceKey: 'catalog',
          productId: product.productId,
          missingFields: listMissingEntitlementMetadataFields(entitlements),
        });
        return null;
      }

      return {
        planKey: product.slug,
        slug: product.slug,
        productId: product.productId,
        displayName: product.displayName,
        description: product.description,
        highlights: product.highlights,
        priority: product.sortOrder,
        displayBadge: product.displayBadge,
        deviceCap: required.deviceCap,
        signQuotaPerPeriod: entitlements.signQuotaPerPeriod,
        auditRetentionDays: required.auditRetentionDays,
        supportTier: required.supportTier,
        billingGraceDays: 0,
        capabilities: entitlements.capabilityKeys,
        meteredPrices: product.meteredPrices,
      };
    })
    .filter((product): product is NonNullable<typeof product> => product !== null)
    .sort((left, right) => left.priority - right.priority);
}

function resolveCatalogProductForEntitlement(
  products: CertificateBillingCatalogProduct[],
  productsById: Map<string, CertificateBillingCatalogProduct>,
  entitlement:
    | {
        productId?: string;
        planKey?: string;
      }
    | null
    | undefined
): CertificateBillingCatalogProduct | null {
  const productId = entitlement?.productId?.trim();
  if (productId) {
    return productsById.get(productId) ?? null;
  }

  const planKey = entitlement?.planKey?.trim();
  if (!planKey) {
    return null;
  }

  return (
    products.find((product) => product.slug === planKey || product.productId === planKey) ?? null
  );
}

function selectWinningCertificateEntitlement<
  T extends {
    status: BillingStatus;
    deviceCap?: number;
    workspaceKey: string;
    allowEnrollment: boolean;
    allowSigning: boolean;
    planKey?: string;
    productId?: string;
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

async function syncWorkspaceCapabilities(
  ctx: MutationCtx,
  args: {
    workspaceKey: string;
    authUserId: string;
    creatorProfileId?: Id<'creator_profiles'>;
    planKey: string;
    productId?: string;
    capabilityBenefitIds: Map<string, string>;
    capabilityKeys: string[];
    status: BillingStatus;
    currentPeriodEnd?: number;
    graceUntil?: number;
  }
) {
  const now = Date.now();
  const desired = new Set(args.capabilityKeys);
  const existing = await ctx.db
    .query('creator_billing_capabilities')
    .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', args.workspaceKey))
    .collect();

  for (const row of existing) {
    if (!desired.has(row.capabilityKey)) {
      if (row.status !== 'inactive') {
        await ctx.db.patch(row._id, {
          status: 'inactive',
          currentPeriodEnd: args.currentPeriodEnd,
          graceUntil: args.graceUntil,
          updatedAt: now,
        });
      }
      continue;
    }

    await ctx.db.patch(row._id, {
      authUserId: args.authUserId,
      creatorProfileId: args.creatorProfileId,
      planKey: args.planKey,
      productId: args.productId,
      benefitId: args.capabilityBenefitIds.get(row.capabilityKey),
      status: args.status,
      currentPeriodEnd: args.currentPeriodEnd,
      graceUntil: args.graceUntil,
      updatedAt: now,
    });
    desired.delete(row.capabilityKey);
  }

  for (const capabilityKey of desired) {
    await ctx.db.insert('creator_billing_capabilities', {
      workspaceKey: args.workspaceKey,
      authUserId: args.authUserId,
      creatorProfileId: args.creatorProfileId,
      planKey: args.planKey,
      productId: args.productId,
      benefitId: args.capabilityBenefitIds.get(capabilityKey),
      capabilityKey,
      status: args.status,
      currentPeriodEnd: args.currentPeriodEnd,
      graceUntil: args.graceUntil,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function syncWorkspaceMeters(
  ctx: MutationCtx,
  args: {
    workspaceKey: string;
    authUserId: string;
    creatorProfileId?: Id<'creator_profiles'>;
    meterNameById: Map<string, string>;
    meters: ProjectionMeter[];
  }
) {
  const now = Date.now();
  const desired = new Map(args.meters.map((meter) => [meter.meterId, meter]));
  const existing = await ctx.db
    .query('creator_billing_meters')
    .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', args.workspaceKey))
    .collect();

  for (const row of existing) {
    const next = desired.get(row.meterId);
    if (!next) {
      await ctx.db.delete(row._id);
      continue;
    }

    await ctx.db.patch(row._id, {
      authUserId: args.authUserId,
      creatorProfileId: args.creatorProfileId,
      meterName: args.meterNameById.get(row.meterId) ?? row.meterName,
      consumedUnits: next.consumedUnits,
      creditedUnits: next.creditedUnits,
      balance: next.balance,
      updatedAt: now,
    });
    desired.delete(row.meterId);
  }

  for (const meter of desired.values()) {
    await ctx.db.insert('creator_billing_meters', {
      workspaceKey: args.workspaceKey,
      authUserId: args.authUserId,
      creatorProfileId: args.creatorProfileId,
      meterId: meter.meterId,
      meterName: args.meterNameById.get(meter.meterId),
      consumedUnits: meter.consumedUnits,
      creditedUnits: meter.creditedUnits,
      balance: meter.balance,
      createdAt: now,
      updatedAt: now,
    });
  }
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
  const storedCapabilities = await listWorkspaceCapabilities(ctx, workspaceKey);
  const storedMeters = await listWorkspaceMeters(ctx, workspaceKey);
  const { products, productsById, benefitsById } = await loadCatalog(ctx);
  const activeProduct = resolveCatalogProductForEntitlement(
    products,
    productsById,
    certificateEntitlements
  );
  const activeBenefits = activeProduct
    ? deriveCatalogBenefitsForProduct(activeProduct, benefitsById)
    : [];
  const activeEntitlements = aggregateCertificateBillingBenefitEntitlements(activeBenefits);
  const capabilities = projectWorkspaceCapabilities({
    includedCapabilityKeys: activeEntitlements.capabilityKeys,
    entitlementStatus: certificateEntitlements?.status,
    storedCapabilities,
  });
  const hasLiveAccess = isLiveBillingStatus(certificateEntitlements?.status);

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
      planKey: hasLiveAccess ? certificateEntitlements?.planKey : undefined,
      productId: hasLiveAccess ? certificateEntitlements?.productId : undefined,
      deviceCap: hasLiveAccess ? certificateEntitlements?.deviceCap : undefined,
      activeDeviceCount: devices.length,
      signQuotaPerPeriod: hasLiveAccess ? certificateEntitlements?.signQuotaPerPeriod : undefined,
      auditRetentionDays: hasLiveAccess ? certificateEntitlements?.auditRetentionDays : undefined,
      supportTier: hasLiveAccess ? certificateEntitlements?.supportTier : undefined,
      currentPeriodEnd: hasLiveAccess ? certificateEntitlements?.currentPeriodEnd : undefined,
      graceUntil: hasLiveAccess ? certificateEntitlements?.graceUntil : undefined,
      reason:
        certificateEntitlements?.allowSigning || !config.enabled
          ? undefined
          : 'Certificate subscription required',
      capabilities,
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
    availablePlans: buildAvailablePlans(products, benefitsById),
    meters: storedMeters,
  };
}

async function resolveProjectedCapabilitiesForAuthUser(
  ctx: QueryCtx,
  authUserId: string
): Promise<Array<{ capabilityKey: string; status: string }>> {
  const creatorProfile = await ctx.db
    .query('creator_profiles')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
    .first();
  const workspaceKeys = resolveWorkspaceKeys(authUserId, creatorProfile?._id ?? null);
  const entitlements = await ctx.db
    .query('creator_billing_entitlements')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
    .collect();
  const certificateEntitlement = selectWinningCertificateEntitlement(
    entitlements.filter((entry) => workspaceKeys.includes(entry.workspaceKey))
  );
  const workspaceKey = certificateEntitlement?.workspaceKey ?? workspaceKeys[0];
  const storedCapabilities = await listWorkspaceCapabilities(ctx, workspaceKey);
  const { productsById, benefitsById } = await loadCatalog(ctx);
  const activeProduct = resolveCatalogProductForEntitlement(
    [...productsById.values()],
    productsById,
    certificateEntitlement
  );
  const activeBenefits = activeProduct
    ? deriveCatalogBenefitsForProduct(activeProduct, benefitsById)
    : [];
  const activeEntitlements = aggregateCertificateBillingBenefitEntitlements(activeBenefits);

  return projectWorkspaceCapabilities({
    includedCapabilityKeys: activeEntitlements.capabilityKeys,
    entitlementStatus: certificateEntitlement?.status,
    storedCapabilities,
  });
}

async function resolveCertificateBillingForAuthUser(ctx: QueryCtx, authUserId: string) {
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
    .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
    .first();
  const workspaceKeys = resolveWorkspaceKeys(authUserId, creatorProfile?._id ?? null);
  const entitlements = await ctx.db
    .query('creator_billing_entitlements')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
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

  const winner = selectWinningCertificateEntitlement(matches);
  if (!winner) {
    return {
      billingEnabled: true,
      status: 'inactive',
      allowEnrollment: false,
      allowSigning: false,
      reason: 'Certificate subscription required',
    };
  }

  return {
    billingEnabled: true,
    workspaceKey: winner.workspaceKey,
    status: winner.status,
    allowEnrollment: winner.allowEnrollment,
    allowSigning: winner.allowSigning,
    planKey: isLiveBillingStatus(winner.status) ? winner.planKey : undefined,
    productId: isLiveBillingStatus(winner.status) ? winner.productId : undefined,
    deviceCap: isLiveBillingStatus(winner.status) ? winner.deviceCap : undefined,
    signQuotaPerPeriod:
      isLiveBillingStatus(winner.status) ? winner.signQuotaPerPeriod ?? undefined : undefined,
    auditRetentionDays: isLiveBillingStatus(winner.status) ? winner.auditRetentionDays : undefined,
    supportTier: isLiveBillingStatus(winner.status) ? winner.supportTier : undefined,
    currentPeriodEnd:
      isLiveBillingStatus(winner.status) ? winner.currentPeriodEnd ?? undefined : undefined,
    graceUntil: isLiveBillingStatus(winner.status) ? winner.graceUntil ?? undefined : undefined,
    reason: winner.allowSigning ? undefined : 'Certificate subscription required',
  };
}

async function projectCustomerStateIntoBilling(
  ctx: MutationCtx,
  args: {
    authUserId: string;
    polarCustomerId: string;
    customerEmail: string;
    activeSubscriptions: ProjectionSubscription[];
    grantedBenefits: ProjectionBenefitGrant[];
    activeMeters: ProjectionMeter[];
  }
) {
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
  const { productsById, benefitsById } = await loadCatalog(ctx);
  const activeGrantedBenefitIds = new Set(args.grantedBenefits.map((grant) => grant.benefitId));
  const meterNameById = new Map<string, string>();

  for (const product of productsById.values()) {
    for (const price of product.meteredPrices) {
      if (!meterNameById.has(price.meterId)) {
        meterNameById.set(price.meterId, price.meterName);
      }
    }
  }

  const activeByWorkspace = new Map<string, ProjectionSubscription[]>();
  for (const subscription of args.activeSubscriptions) {
    if (!productsById.has(subscription.productId)) {
      continue;
    }

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
  const existingByWorkspace = new Map(existingAccounts.map((entry) => [entry.workspaceKey, entry]));
  const projectedWorkspaceKeys = new Set<string>();

  for (const [workspaceKey, subscriptions] of activeByWorkspace.entries()) {
    const perProduct = subscriptions
      .map((subscription) => {
        const product = productsById.get(subscription.productId);
        if (!product) {
          return null;
        }

        const benefits = deriveCatalogBenefitsForProduct(
          product,
          benefitsById,
          activeGrantedBenefitIds.size > 0 ? activeGrantedBenefitIds : undefined
        );
        const entitlements = aggregateCertificateBillingBenefitEntitlements(benefits);
        const required = requireEntitlementMetadata(workspaceKey, product.productId, entitlements);
        if (!required) {
          logger.warn('Skipping projected certificate billing product with malformed metadata', {
            workspaceKey,
            productId: product.productId,
            missingFields: listMissingEntitlementMetadataFields(entitlements),
          });
          return null;
        }

        return {
          subscription,
          product,
          benefits,
          entitlements,
          required,
        };
      })
      .filter(
        (
          entry
        ): entry is {
          subscription: ProjectionSubscription;
          product: CertificateBillingCatalogProduct;
          benefits: CertificateBillingCatalogBenefit[];
          entitlements: ReturnType<typeof aggregateCertificateBillingBenefitEntitlements>;
          required: {
            deviceCap: number;
            auditRetentionDays: number;
            supportTier: string;
          };
        } => entry !== null
      )
      .sort((left, right) => {
        const leftRank = left.entitlements.tierRank ?? 0;
        const rightRank = right.entitlements.tierRank ?? 0;
        if (rightRank !== leftRank) {
          return rightRank - leftRank;
        }

        if (right.required.deviceCap !== left.required.deviceCap) {
          return right.required.deviceCap - left.required.deviceCap;
        }

        return left.product.sortOrder - right.product.sortOrder;
      });

    const winning = perProduct[0];
    if (!winning) {
      continue;
    }

    const projectedSubscriptions = perProduct.map((entry) => entry.subscription);
    const currentPeriodEnd = Math.max(
      ...projectedSubscriptions.map((subscription) => subscription.currentPeriodEnd)
    );
    const account = existingByWorkspace.get(workspaceKey);
    const planKey = winning.product.slug;
    projectedWorkspaceKeys.add(workspaceKey);
    const capabilityBenefitIds = new Map<string, string>();
    for (const benefit of winning.benefits) {
      for (const capabilityKey of benefit.capabilityKeys) {
        capabilityBenefitIds.set(capabilityKey, benefit.benefitId);
      }
    }

    if (account) {
      await ctx.db.patch(account._id, {
        creatorProfileId: creatorProfile?._id,
        polarCustomerId: args.polarCustomerId,
        polarExternalId: args.authUserId,
        workspaceKey,
        planKey,
        productId: winning.product.productId,
        status: 'active',
        customerEmail: args.customerEmail,
        currentPeriodEnd,
        graceUntil: undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('creator_billing_accounts', {
        workspaceKey,
        authUserId: args.authUserId,
        creatorProfileId: creatorProfile?._id,
        polarCustomerId: args.polarCustomerId,
        polarExternalId: args.authUserId,
        planKey,
        productId: winning.product.productId,
        status: 'active',
        customerEmail: args.customerEmail,
        currentPeriodEnd,
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
      planKey,
      productId: winning.product.productId,
      status: 'active' as BillingStatus,
      allowEnrollment: true,
      allowSigning: true,
      deviceCap: winning.required.deviceCap,
      signQuotaPerPeriod: winning.entitlements.signQuotaPerPeriod ?? undefined,
      auditRetentionDays: winning.required.auditRetentionDays,
      supportTier: winning.required.supportTier,
      currentPeriodEnd,
      graceUntil: undefined,
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

    await syncWorkspaceCapabilities(ctx, {
      workspaceKey,
      authUserId: args.authUserId,
      creatorProfileId: creatorProfile?._id,
      planKey,
      productId: winning.product.productId,
      capabilityBenefitIds,
      capabilityKeys: winning.entitlements.capabilityKeys,
      status: 'active',
      currentPeriodEnd,
    });

    await syncWorkspaceMeters(ctx, {
      workspaceKey,
      authUserId: args.authUserId,
      creatorProfileId: creatorProfile?._id,
      meterNameById,
      meters: args.activeMeters,
    });

    const existingSubscriptions = await ctx.db
      .query('creator_billing_subscriptions')
      .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', workspaceKey))
      .collect();
    await Promise.all(existingSubscriptions.map((entry) => ctx.db.delete(entry._id)));

    for (const subscription of projectedSubscriptions) {
      await ctx.db.insert('creator_billing_subscriptions', {
        workspaceKey,
        authUserId: args.authUserId,
        creatorProfileId: creatorProfile?._id,
        polarSubscriptionId: subscription.subscriptionId,
        polarProductId: subscription.productId,
        planKey,
        productId: subscription.productId,
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
    if (projectedWorkspaceKeys.has(existing.workspaceKey)) {
      continue;
    }

    await ctx.db.patch(existing._id, {
      status: 'inactive',
      currentPeriodEnd: undefined,
      graceUntil: undefined,
      updatedAt: now,
    });

    const entitlement = await ctx.db
      .query('creator_billing_entitlements')
      .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', existing.workspaceKey))
      .first();
    if (entitlement) {
      await ctx.db.patch(entitlement._id, {
        status: 'inactive',
        allowEnrollment: false,
        allowSigning: false,
        currentPeriodEnd: undefined,
        graceUntil: undefined,
        updatedAt: now,
      });
    }

    await syncWorkspaceCapabilities(ctx, {
      workspaceKey: existing.workspaceKey,
      authUserId: existing.authUserId,
      creatorProfileId: existing.creatorProfileId ?? undefined,
      planKey: existing.planKey ?? existing.productId ?? 'inactive',
      productId: existing.productId ?? undefined,
      capabilityBenefitIds: new Map(),
      capabilityKeys: [],
      status: 'inactive',
      currentPeriodEnd: existing.currentPeriodEnd ?? undefined,
    });

    const staleMeters = await ctx.db
      .query('creator_billing_meters')
      .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', existing.workspaceKey))
      .collect();
    await Promise.all(staleMeters.map((row) => ctx.db.delete(row._id)));

    const staleSubscriptions = await ctx.db
      .query('creator_billing_subscriptions')
      .withIndex('by_workspace_key', (q) => q.eq('workspaceKey', existing.workspaceKey))
      .collect();
    await Promise.all(staleSubscriptions.map((row) => ctx.db.delete(row._id)));
  }

  return { updated: true, workspaceCount: projectedWorkspaceKeys.size };
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

export const hasCapabilityForAuthUser = internalQuery({
  args: {
    authUserId: v.string(),
    capabilityKey: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const capabilities = await resolveProjectedCapabilitiesForAuthUser(ctx, args.authUserId);
    return capabilities.some(
      (row) =>
        row.capabilityKey === args.capabilityKey &&
        (row.status === 'active' || row.status === 'grace')
    );
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
  returns: resolveForAuthUserReturnValidator,
  handler: async (ctx, args) => await resolveCertificateBillingForAuthUser(ctx, args.authUserId),
});

export const getShellBrandingForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: shellBrandingReturnValidator,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const billing = await resolveCertificateBillingForAuthUser(ctx, args.authUserId);
    const billingStatus = billing.status || undefined;
    return {
      isPlus: billing.status === 'active' || billing.status === 'grace',
      billingStatus,
    };
  },
});

export const projectCustomerStateForApi = mutation({
  args: {
    apiSecret: v.string(),
    ...customerStateProjectionArgsValidator,
  },
  returns: customerStateProjectionReturnValidator,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await projectCustomerStateIntoBilling(ctx, args);
  },
});

export const projectCustomerStateChanged = internalMutation({
  args: customerStateProjectionArgsValidator,
  returns: customerStateProjectionReturnValidator,
  handler: async (ctx, args) => {
    const projected = await projectCustomerStateIntoBilling(ctx, args);
    await ctx.scheduler.runAfter(0, internal.certificateBillingSync.scheduleReconciliationTarget, {
      authUserId: args.authUserId,
      polarCustomerId: args.polarCustomerId,
      delayMs: 5 * 60 * 1000,
    });
    return projected;
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

    await ctx.scheduler.runAfter(0, internal.certificateBillingSync.ingestUsageEvent, args);
  },
});
