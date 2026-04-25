import { beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import { makeTestConvex, seedCreatorProfile, seedSubject } from './testHelpers';

const API_SECRET = 'test-secret';

describe('catalog tier entitlement resolution', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });

  it('resolves Jinxxy purchase fact version ids into active catalog tiers', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-jinxxy-tier';
    const buyerAuthUserId = 'buyer-jinxxy-tier';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-jinxxy-tier',
    });

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-creator-jinxxy-tier',
    });

    const catalogProductId = await t.run(async (ctx) => {
      return await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'local-jinxxy-product',
        provider: 'jinxxy',
        providerProductRef: 'product-1',
        displayName: 'Avatar Package',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const catalogTierId = await t.mutation(api.catalogTiers.upsertCatalogTier, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      provider: 'jinxxy',
      productId: 'local-jinxxy-product',
      catalogProductId,
      providerProductRef: 'product-1',
      providerTierRef: 'version-commercial',
      displayName: 'Commercial License',
      amountCents: 2500,
      currency: 'USD',
      status: 'active',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('purchase_facts', {
        authUserId: creatorAuthUserId,
        provider: 'jinxxy',
        externalOrderId: 'order-1',
        externalLineItemId: 'line-1',
        providerProductId: 'product-1',
        providerProductVersionId: 'version-commercial',
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: Date.now() - 60_000,
        subjectId: buyerSubjectId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await t.mutation(internal.backgroundSync.projectBackfilledPurchasesForProduct, {
      authUserId: creatorAuthUserId,
      productId: 'local-jinxxy-product',
      provider: 'jinxxy',
      providerProductRef: 'product-1',
    });

    const entitlement = await t.query(api.entitlements.getActiveEntitlement, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      subjectId: buyerSubjectId,
      productId: 'local-jinxxy-product',
    });

    expect(entitlement.found).toBe(true);
    if (!entitlement.entitlement) {
      throw new Error('Expected projected entitlement');
    }
    const tierIds = await t.query(api.catalogTiers.getActiveCatalogTierIdsForEntitlement, {
      apiSecret: API_SECRET,
      entitlementId: entitlement.entitlement._id,
    });

    expect(tierIds).toEqual([catalogTierId]);
  });

  it('resolves Gumroad purchase fact external variant ids into active catalog tiers', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-gumroad-tier';
    const buyerAuthUserId = 'buyer-gumroad-tier';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-gumroad-tier',
    });

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-creator-gumroad-tier',
    });

    const catalogProductId = await t.run(async (ctx) => {
      return await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'local-gumroad-product',
        provider: 'gumroad',
        providerProductRef: 'gumroad-product-1',
        displayName: 'Tiered Gumroad Membership',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const catalogTierId = await t.mutation(api.catalogTiers.upsertCatalogTier, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      productId: 'local-gumroad-product',
      catalogProductId,
      providerProductRef: 'gumroad-product-1',
      providerTierRef:
        'gumroad|product|17:gumroad-product-1|variant|4:tier|option|4:gold|recurrence|7:monthly',
      displayName: 'Gold Monthly',
      amountCents: 1500,
      currency: 'USD',
      status: 'active',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('purchase_facts', {
        authUserId: creatorAuthUserId,
        provider: 'gumroad',
        externalOrderId: 'sale-gumroad-tier',
        providerProductId: 'gumroad-product-1',
        externalVariantId:
          'gumroad|product|17:gumroad-product-1|variant|4:tier|option|4:gold|recurrence|7:monthly',
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: Date.now() - 60_000,
        subjectId: buyerSubjectId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never);
    });

    await t.mutation(internal.backgroundSync.projectBackfilledPurchasesForProduct, {
      authUserId: creatorAuthUserId,
      productId: 'local-gumroad-product',
      provider: 'gumroad',
      providerProductRef: 'gumroad-product-1',
    });

    const entitlement = await t.query(api.entitlements.getActiveEntitlement, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      subjectId: buyerSubjectId,
      productId: 'local-gumroad-product',
    });

    expect(entitlement.found).toBe(true);
    if (!entitlement.entitlement) {
      throw new Error('Expected projected entitlement');
    }

    const tierIds = await t.query(api.catalogTiers.getActiveCatalogTierIdsForEntitlement, {
      apiSecret: API_SECRET,
      entitlementId: entitlement.entitlement._id,
    });

    expect(tierIds).toEqual([catalogTierId]);
  });

  it('does not return archived catalog tiers as active entitlement tiers', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-archived-tier';
    const buyerAuthUserId = 'buyer-archived-tier';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-archived-tier',
    });

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-creator-archived-tier',
    });

    const catalogProductId = await t.run(async (ctx) => {
      return await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'local-jinxxy-archived-product',
        provider: 'jinxxy',
        providerProductRef: 'product-archived',
        displayName: 'Archived Avatar Package',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await t.mutation(api.catalogTiers.upsertCatalogTier, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      provider: 'jinxxy',
      productId: 'local-jinxxy-archived-product',
      catalogProductId,
      providerProductRef: 'product-archived',
      providerTierRef: 'version-archived',
      displayName: 'Archived License',
      amountCents: 2500,
      currency: 'USD',
      status: 'archived',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('purchase_facts', {
        authUserId: creatorAuthUserId,
        provider: 'jinxxy',
        externalOrderId: 'order-archived',
        externalLineItemId: 'line-archived',
        providerProductId: 'product-archived',
        providerProductVersionId: 'version-archived',
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: Date.now() - 60_000,
        subjectId: buyerSubjectId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await t.mutation(api.entitlements.grantEntitlement, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      subjectId: buyerSubjectId,
      productId: 'local-jinxxy-archived-product',
      evidence: {
        provider: 'jinxxy',
        sourceReference: 'jinxxy:order-archived:line-archived',
        purchasedAt: Date.now() - 60_000,
        rawEvidence: {},
      },
    });

    const entitlement = await t.query(api.entitlements.getActiveEntitlement, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      subjectId: buyerSubjectId,
      productId: 'local-jinxxy-archived-product',
    });

    expect(entitlement.found).toBe(true);
    if (!entitlement.entitlement) {
      throw new Error('Expected active entitlement');
    }

    const tierIds = await t.query(api.catalogTiers.getActiveCatalogTierIdsForEntitlement, {
      apiSecret: API_SECRET,
      entitlementId: entitlement.entitlement._id,
    });

    expect(tierIds).toEqual([]);
  });

  it('preserves existing optional catalog tier metadata when later upserts omit it', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-tier-metadata';

    const catalogProductId = await t.run(async (ctx) => {
      return await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'local-tier-metadata-product',
        provider: 'jinxxy',
        providerProductRef: 'product-tier-metadata',
        displayName: 'Metadata Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const catalogTierId = await t.mutation(api.catalogTiers.upsertCatalogTier, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      provider: 'jinxxy',
      productId: 'local-tier-metadata-product',
      catalogProductId,
      providerProductRef: 'product-tier-metadata',
      providerTierRef: 'version-vip',
      displayName: 'VIP License',
      description: 'Full commercial rights',
      amountCents: 9900,
      currency: 'USD',
      metadata: { provider: 'jinxxy', scope: 'vip' },
      status: 'active',
    });

    await t.mutation(api.catalogTiers.upsertCatalogTier, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      provider: 'jinxxy',
      productId: 'local-tier-metadata-product',
      catalogProductId,
      providerProductRef: 'product-tier-metadata',
      providerTierRef: 'version-vip',
      displayName: 'VIP License Updated',
      status: 'active',
    });

    const catalogTier = await t.query(api.catalogTiers.getCatalogTier, {
      apiSecret: API_SECRET,
      catalogTierId,
    });

    expect(catalogTier).toMatchObject({
      _id: catalogTierId,
      displayName: 'VIP License Updated',
      description: 'Full commercial rights',
      amountCents: 9900,
      currency: 'USD',
      metadata: { provider: 'jinxxy', scope: 'vip' },
    });
  });
});
