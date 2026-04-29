import { sha256Hex } from '@yucp/shared/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import { makeTestConvex, seedCreatorProfile, seedSubject } from './testHelpers';

const API_SECRET = 'test-secret';

describe('gumroad external storefront backfill', () => {
  let t: ReturnType<typeof makeTestConvex> | null = null;

  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    if (t) {
      await t.finishAllScheduledFunctions(() => {
        vi.runAllTimers();
      });
      t = null;
    }
    vi.useRealTimers();
  });

  it('projects account-link backfill purchases into entitlements when the purchase fact uses Gumroad’s canonical product id', async () => {
    t = makeTestConvex();
    const creatorAuthUserId = 'creator-external-storefront';
    const buyerAuthUserId = 'buyer-external-storefront';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-external-storefront',
    });
    const buyerEmail = 'external-storefront-buyer@example.com';
    const buyerEmailHash = await sha256Hex(buyerEmail);
    const canonicalProductId = 'QAJc7ErxdAC815P5P8R89g==';
    const localProductId = 'gumroad-external-storefront-product';
    const storefrontUrl =
      'https://quaggycharr.gumroad.com/l/Fluffgan?layout=profile&recommended_by=library';
    const normalizedStorefrontUrl = storefrontUrl.toLowerCase().trim();
    const storefrontUrlHash = await sha256Hex(normalizedStorefrontUrl);

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-creator-external-storefront',
    });

    const catalogProductId = await t.run(async (ctx) => {
      return ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: localProductId,
        provider: 'gumroad',
        providerProductRef: canonicalProductId,
        displayName: 'External Storefront Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('catalog_product_links', {
        catalogProductId,
        provider: 'gumroad',
        originalUrl: storefrontUrl,
        normalizedUrl: normalizedStorefrontUrl,
        urlHash: storefrontUrlHash,
        linkKind: 'direct_product',
        status: 'active',
        submittedByAuthUserId: creatorAuthUserId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const syncResult = await t.mutation(api.identitySync.syncUserFromProvider, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      provider: 'gumroad',
      providerUserId: 'gumroad-external-storefront-buyer',
      username: 'External Storefront Buyer',
      email: buyerEmail,
      discordUserId: 'discord-external-storefront',
    });

    await t.mutation(api.bindings.activateBinding, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      subjectId: buyerSubjectId,
      externalAccountId: syncResult.externalAccountId,
      bindingType: 'verification',
    });

    await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId: buyerSubjectId,
      provider: 'gumroad',
      externalAccountId: syncResult.externalAccountId,
      verificationMethod: 'account_link',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('purchase_facts', {
        authUserId: creatorAuthUserId,
        provider: 'gumroad',
        externalOrderId: 'sale-external-storefront',
        buyerEmailHash,
        providerProductId: canonicalProductId,
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: Date.now() - 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const projection = await t.mutation(
      internal.backgroundSync.projectBackfilledPurchasesForProduct,
      {
        authUserId: creatorAuthUserId,
        productId: localProductId,
        provider: 'gumroad',
        providerProductRef: canonicalProductId,
      }
    );

    expect(projection).toMatchObject({
      purchaseFactsFound: 1,
      linkedToSubject: 1,
      entitlementsGranted: 1,
      unresolved: 0,
    });

    const entitlement = await t.query(api.entitlements.getActiveEntitlement, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      subjectId: buyerSubjectId,
      productId: localProductId,
    });

    expect(entitlement).toMatchObject({
      found: true,
      entitlement: expect.objectContaining({
        authUserId: creatorAuthUserId,
        subjectId: buyerSubjectId,
        productId: localProductId,
        sourceProvider: 'gumroad',
        sourceReference: 'gumroad:sale-external-storefront',
      }),
    });
  });

  it('preserves Gumroad tier refs through backfill ingestion so tier-aware entitlement resolution matches catalog', async () => {
    t = makeTestConvex();
    const creatorAuthUserId = 'creator-gumroad-tier-backfill';
    const buyerAuthUserId = 'buyer-gumroad-tier-backfill';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-gumroad-tier-backfill',
    });
    const buyerEmail = 'gumroad-tier-backfill@example.com';
    const buyerEmailHash = await sha256Hex(buyerEmail);
    const canonicalProductId = 'gumroad-tiered-product';
    const localProductId = 'local-gumroad-tiered-product';
    const providerTierRef =
      'gumroad|product|22:gumroad-tiered-product|variant|4:tier|option|4:gold|recurrence|7:monthly';

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-creator-gumroad-tier-backfill',
    });

    const catalogProductId = await t.run(async (ctx) => {
      return ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: localProductId,
        provider: 'gumroad',
        providerProductRef: canonicalProductId,
        displayName: 'Tiered Gumroad Product',
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
      productId: localProductId,
      catalogProductId,
      providerProductRef: canonicalProductId,
      providerTierRef,
      displayName: 'Gold Monthly',
      amountCents: 1500,
      currency: 'USD',
      status: 'active',
    });

    const syncResult = await t.mutation(api.identitySync.syncUserFromProvider, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      provider: 'gumroad',
      providerUserId: 'gumroad-tier-backfill-buyer',
      username: 'Tier Backfill Buyer',
      email: buyerEmail,
      discordUserId: 'discord-gumroad-tier-backfill',
    });

    await t.mutation(api.bindings.activateBinding, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      subjectId: buyerSubjectId,
      externalAccountId: syncResult.externalAccountId,
      bindingType: 'verification',
    });

    await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId: buyerSubjectId,
      provider: 'gumroad',
      externalAccountId: syncResult.externalAccountId,
      verificationMethod: 'account_link',
    });

    await t.mutation(api.backgroundSync.ingestBackfillPurchaseFactsBatch, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      purchases: [
        {
          authUserId: creatorAuthUserId,
          provider: 'gumroad',
          externalOrderId: 'sale-tier-backfill',
          buyerEmailHash,
          providerProductId: canonicalProductId,
          externalVariantId: providerTierRef,
          paymentStatus: 'paid',
          lifecycleStatus: 'active',
          purchasedAt: Date.now() - 60_000,
        } as never,
      ],
    });

    const projection = await t.mutation(
      internal.backgroundSync.projectBackfilledPurchasesForProduct,
      {
        authUserId: creatorAuthUserId,
        productId: localProductId,
        provider: 'gumroad',
        providerProductRef: canonicalProductId,
      }
    );

    expect(projection).toMatchObject({
      purchaseFactsFound: 1,
      linkedToSubject: 1,
      entitlementsGranted: 1,
      unresolved: 0,
    });

    const purchaseFacts = await t.run(async (ctx) => ctx.db.query('purchase_facts').collect());
    expect(purchaseFacts[0]).toMatchObject({
      provider: 'gumroad',
      externalOrderId: 'sale-tier-backfill',
      externalVariantId: providerTierRef,
    });

    const entitlement = await t.query(api.entitlements.getActiveEntitlement, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      subjectId: buyerSubjectId,
      productId: localProductId,
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

  it('enriches existing backfill purchase facts with Gumroad tier refs on rerun', async () => {
    t = makeTestConvex();
    const creatorAuthUserId = 'creator-gumroad-tier-enrichment';
    const providerTierRef =
      'gumroad|product|22:gumroad-tiered-product|variant|4:tier|option|4:gold|recurrence|7:monthly';

    await t.run(async (ctx) => {
      await ctx.db.insert('purchase_facts', {
        authUserId: creatorAuthUserId,
        provider: 'gumroad',
        externalOrderId: 'sale-tier-enrichment',
        providerProductId: 'gumroad-tiered-product',
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: Date.now() - 60_000,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
      } as never);
    });

    const result = await t.mutation(api.backgroundSync.ingestBackfillPurchaseFactsBatch, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      purchases: [
        {
          authUserId: creatorAuthUserId,
          provider: 'gumroad',
          externalOrderId: 'sale-tier-enrichment',
          providerProductId: 'gumroad-tiered-product',
          externalVariantId: providerTierRef,
          paymentStatus: 'paid',
          lifecycleStatus: 'active',
          purchasedAt: Date.now() - 60_000,
        } as never,
      ],
    });

    expect(result).toMatchObject({
      inserted: 0,
      skipped: 1,
    });

    const purchaseFacts = await t.run(async (ctx) => ctx.db.query('purchase_facts').collect());
    expect(purchaseFacts).toHaveLength(1);
    expect(purchaseFacts[0]).toMatchObject({
      externalOrderId: 'sale-tier-enrichment',
      externalVariantId: providerTierRef,
    });
  });
});
