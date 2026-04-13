import { convexTest } from 'convex-test';
import type { Id } from './_generated/dataModel';
import schema from './schema';

export type ConvexTestInstance = ReturnType<typeof convexTest>;

export function makeTestConvex() {
  // import.meta.glob is a Vite-specific API required by convex-test.
  // The `any` cast avoids needing vite/client types in this package.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return convexTest(schema, (import.meta as any).glob('./**/*.ts'));
}

// ---------------------------------------------------------------------------
// Seed helpers, insert minimal valid records and return their IDs.
// All required (non-optional) fields are included; optional fields may be
// passed via the `overrides` parameter.
// ---------------------------------------------------------------------------

export async function seedSubject(
  t: ConvexTestInstance,
  overrides: {
    primaryDiscordUserId?: string;
    status?: 'active' | 'suspended' | 'quarantined' | 'deleted';
    authUserId?: string;
    displayName?: string;
    avatarUrl?: string;
  } = {}
): Promise<Id<'subjects'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('subjects', {
      primaryDiscordUserId: overrides.primaryDiscordUserId ?? `discord-test-${Date.now()}`,
      status: overrides.status ?? 'active',
      authUserId: overrides.authUserId,
      displayName: overrides.displayName,
      avatarUrl: overrides.avatarUrl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

export async function seedCreatorProfile(
  t: ConvexTestInstance,
  overrides: {
    authUserId?: string;
    name?: string;
    ownerDiscordUserId?: string;
    status?: 'active' | 'suspended' | 'quarantined' | 'deleted';
  } = {}
): Promise<Id<'creator_profiles'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('creator_profiles', {
      authUserId: overrides.authUserId ?? `auth-test-${Date.now()}`,
      name: overrides.name ?? 'Test Creator',
      ownerDiscordUserId: overrides.ownerDiscordUserId ?? `discord-creator-${Date.now()}`,
      status: overrides.status ?? 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

export async function seedEntitlement(
  t: ConvexTestInstance,
  subjectId: Id<'subjects'>,
  overrides: {
    authUserId?: string;
    productId?: string;
    sourceProvider?: string;
    sourceReference?: string;
    status?: 'active' | 'revoked' | 'expired' | 'refunded' | 'disputed';
  } = {}
): Promise<Id<'entitlements'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('entitlements', {
      authUserId: overrides.authUserId ?? `auth-test-${Date.now()}`,
      subjectId,
      productId: overrides.productId ?? `product-test-${Date.now()}`,
      sourceProvider: (overrides.sourceProvider as any) ?? 'gumroad',
      sourceReference: overrides.sourceReference ?? `ref-${Date.now()}`,
      status: overrides.status ?? 'active',
      grantedAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

export async function seedGuildLink(
  t: ConvexTestInstance,
  overrides: {
    authUserId?: string;
    discordGuildId?: string;
    installedByAuthUserId?: string;
    botPresent?: boolean;
    status?: 'active' | 'uninstalled' | 'suspended';
  } = {}
): Promise<Id<'guild_links'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('guild_links', {
      authUserId: overrides.authUserId ?? `auth-test-${Date.now()}`,
      discordGuildId: overrides.discordGuildId ?? `guild-${Date.now()}`,
      installedByAuthUserId: overrides.installedByAuthUserId ?? `auth-installer-${Date.now()}`,
      botPresent: overrides.botPresent ?? true,
      status: overrides.status ?? 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

export async function seedRoleRule(
  t: ConvexTestInstance,
  guildLinkId: Id<'guild_links'>,
  overrides: {
    authUserId?: string;
    guildId?: string;
    productId?: string;
    verifiedRoleId?: string;
    removeOnRevoke?: boolean;
    priority?: number;
    enabled?: boolean;
  } = {}
): Promise<Id<'role_rules'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('role_rules', {
      authUserId: overrides.authUserId ?? `auth-test-${Date.now()}`,
      guildId: overrides.guildId ?? `guild-${Date.now()}`,
      guildLinkId,
      productId: overrides.productId ?? `product-${Date.now()}`,
      verifiedRoleId: overrides.verifiedRoleId ?? `role-${Date.now()}`,
      removeOnRevoke: overrides.removeOnRevoke ?? true,
      priority: overrides.priority ?? 0,
      enabled: overrides.enabled ?? true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

export async function seedCertificateBillingCatalog(
  t: ConvexTestInstance,
  input: {
    productId?: string;
    slug?: string;
    displayName?: string;
    description?: string;
    sortOrder?: number;
    recurringInterval?: string;
    recurringPriceIds?: string[];
    displayBadge?: string;
    highlights?: string[];
    meteredPrices?: Array<{
      priceId: string;
      meterId: string;
      meterName: string;
    }>;
    benefitId?: string;
    benefitType?: string;
    benefitDescription?: string;
    benefitMetadata?: Record<string, string | number | boolean>;
    featureFlags?: Record<string, string | number | boolean>;
    capabilityKeys?: string[];
    capabilityKey?: string;
    deviceCap?: number;
    signQuotaPerPeriod?: number;
    auditRetentionDays?: number;
    supportTier?: string;
    tierRank?: number;
    metadata?: Record<string, string | number | boolean>;
  } = {}
): Promise<{ productId: string; benefitId: string }> {
  const now = Date.now();
  const productId = input.productId ?? 'prod_test_certificate';
  const benefitId = input.benefitId ?? 'benefit_test_certificate';

  await t.run(async (ctx) => {
    await ctx.db.insert('creator_billing_catalog_products', {
      productId,
      slug: input.slug ?? 'test-certificate',
      displayName: input.displayName ?? 'Test Certificate',
      description: input.description ?? 'Test certificate billing product',
      status: 'active',
      sortOrder: input.sortOrder ?? 1,
      displayBadge: input.displayBadge,
      recurringInterval: input.recurringInterval ?? 'month',
      recurringPriceIds: input.recurringPriceIds ?? ['price_test_certificate_monthly'],
      meteredPrices: input.meteredPrices ?? [],
      benefitIds: [benefitId],
      highlights: input.highlights ?? ['Test certificate plan'],
      metadata: {
        yucp_domain: 'certificate_billing',
        ...(input.metadata ?? {}),
      },
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert('creator_billing_catalog_benefits', {
      benefitId,
      type: input.benefitType ?? 'feature_flag',
      description: input.benefitDescription ?? 'Test certificate features',
      metadata: input.benefitMetadata ?? {},
      featureFlags: input.featureFlags ?? {},
      capabilityKeys: input.capabilityKeys ?? [],
      capabilityKey: input.capabilityKey,
      deviceCap: input.deviceCap,
      signQuotaPerPeriod: input.signQuotaPerPeriod,
      auditRetentionDays: input.auditRetentionDays,
      supportTier: input.supportTier,
      tierRank: input.tierRank,
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });

  return { productId, benefitId };
}
