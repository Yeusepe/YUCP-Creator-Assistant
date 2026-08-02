import { sha256Hex } from '@yucp/shared/crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import { makeTestConvex, seedCreatorProfile, seedSubject } from './testHelpers';

const API_SECRET = 'test-secret';

async function seedCatalogProduct(
  t: ReturnType<typeof makeTestConvex>,
  args: {
    authUserId: string;
    productId: string;
    provider: 'gumroad';
    providerProductRef: string;
    displayName: string;
  }
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('product_catalog', {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: args.provider,
      providerProductRef: args.providerProductRef,
      displayName: args.displayName,
      status: 'active',
      supportsAutoDiscovery: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedPurchaseFact(
  t: ReturnType<typeof makeTestConvex>,
  args: {
    authUserId: string;
    provider: 'gumroad';
    providerProductId: string;
    externalOrderId: string;
    buyerEmailHash: string;
  }
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('purchase_facts', {
      authUserId: args.authUserId,
      provider: args.provider,
      externalOrderId: args.externalOrderId,
      buyerEmailHash: args.buyerEmailHash,
      providerProductId: args.providerProductId,
      paymentStatus: 'paid',
      lifecycleStatus: 'active',
      purchasedAt: Date.now() - 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function expectProjectedEntitlement(
  t: ReturnType<typeof makeTestConvex>,
  args: {
    creatorAuthUserId: string;
    buyerAuthUserId: string;
    subjectId: string;
    providerProductRef: string;
    productId: string;
    expectedProviderUserId: string;
  }
) {
  const projection = await t.mutation(
    internal.backgroundSync.projectBackfilledPurchasesForProduct,
    {
      authUserId: args.creatorAuthUserId,
      productId: args.productId,
      provider: 'gumroad',
      providerProductRef: args.providerProductRef,
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
    authUserId: args.creatorAuthUserId,
    subjectId: args.subjectId as never,
    productId: args.productId,
  });

  expect(entitlement).toMatchObject({
    found: true,
    entitlement: expect.objectContaining({
      subjectId: args.subjectId,
      productId: args.productId,
      sourceProvider: 'gumroad',
    }),
  });
  const entitlementId = entitlement.entitlement?._id ?? null;
  const storedEntitlement = entitlementId
    ? await t.run(async (ctx) => ctx.db.get(entitlementId))
    : null;
  expect(storedEntitlement).toMatchObject({
    authUserId: args.creatorAuthUserId,
    sourceReference: 'gumroad:historical-order',
  });

  const links = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
    apiSecret: API_SECRET,
    authUserId: args.buyerAuthUserId,
  });

  expect(links).toEqual([
    expect.objectContaining({
      provider: 'gumroad',
      providerUserId: args.expectedProviderUserId,
      status: 'active',
    }),
  ]);
}

describe('buyer-link backfill symmetry', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });

  it('projects later Gumroad backfill purchases through a direct license-created buyer link', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-direct-symmetry';
    const buyerAuthUserId = 'buyer-direct-symmetry';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-direct-symmetry',
    });
    const buyerEmailHash = await sha256Hex('direct-buyer@example.com');

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-creator-direct-symmetry',
    });
    await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId: 'gumroad-direct-follow-up-product',
      provider: 'gumroad',
      providerProductRef: 'gumroad-direct-follow-up-ref',
      displayName: 'Direct Follow-up Product',
    });

    await t.mutation(api.licenseVerification.completeLicenseVerification, {
      apiSecret: API_SECRET,
      creatorAuthUserId,
      buyerAuthUserId,
      subjectId: buyerSubjectId,
      provider: 'gumroad',
      providerUserId: 'gumroad-direct-buyer',
      providerUsername: 'Direct Buyer',
      providerMetadata: {
        emailHash: buyerEmailHash,
        emailEncrypted: 'enc-direct-buyer-email',
      },
      productsToGrant: [
        {
          productId: 'gumroad-direct-initial-product',
          sourceReference: 'gumroad:direct-initial-order',
        },
      ],
    } as never);

    await seedPurchaseFact(t, {
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      providerProductId: 'gumroad-direct-follow-up-ref',
      externalOrderId: 'historical-order',
      buyerEmailHash,
    });

    await expectProjectedEntitlement(t, {
      creatorAuthUserId,
      buyerAuthUserId,
      subjectId: buyerSubjectId,
      providerProductRef: 'gumroad-direct-follow-up-ref',
      productId: 'gumroad-direct-follow-up-product',
      expectedProviderUserId: 'gumroad-direct-buyer',
    });
  });

  it('projects later Gumroad backfill purchases through an account-link-created buyer link', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-account-link-symmetry';
    const buyerAuthUserId = 'buyer-account-link-symmetry';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-account-link-symmetry',
    });
    const buyerEmail = 'account-link-buyer@example.com';
    const buyerEmailHash = await sha256Hex(buyerEmail);

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-creator-account-link-symmetry',
    });
    await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId: 'gumroad-account-link-follow-up-product',
      provider: 'gumroad',
      providerProductRef: 'gumroad-account-link-follow-up-ref',
      displayName: 'Account-link Follow-up Product',
    });

    const syncResult = await t.mutation(api.identitySync.syncUserFromProvider, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      provider: 'gumroad',
      providerUserId: 'gumroad-account-link-buyer',
      username: 'Account Link Buyer',
      email: buyerEmail,
      discordUserId: 'discord-account-link-symmetry',
    });

    expect(syncResult.subjectId).toBe(buyerSubjectId);

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

    await seedPurchaseFact(t, {
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      providerProductId: 'gumroad-account-link-follow-up-ref',
      externalOrderId: 'historical-order',
      buyerEmailHash,
    });

    await expectProjectedEntitlement(t, {
      creatorAuthUserId,
      buyerAuthUserId,
      subjectId: buyerSubjectId,
      providerProductRef: 'gumroad-account-link-follow-up-ref',
      productId: 'gumroad-account-link-follow-up-product',
      expectedProviderUserId: 'gumroad-account-link-buyer',
    });
  });

  it('projects a high-volume product through bounded continuation pages', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-bounded-backfill';
    const productId = 'bounded-backfill-product';
    const providerProductRef = 'bounded-backfill-provider-product';
    const subjectId = await seedSubject(t, {
      authUserId: 'buyer-bounded-backfill',
      primaryDiscordUserId: 'discord-bounded-backfill',
    });

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-creator-bounded-backfill',
    });
    await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId,
      provider: 'gumroad',
      providerProductRef,
      displayName: 'Bounded Backfill Product',
    });
    await t.run(async (ctx) => {
      for (let index = 0; index < 3; index++) {
        await ctx.db.insert('purchase_facts', {
          authUserId: creatorAuthUserId,
          provider: 'gumroad',
          externalOrderId: `bounded-order-${index}`,
          providerProductId: providerProductRef,
          paymentStatus: 'paid',
          lifecycleStatus: 'active',
          purchasedAt: Date.now() - 60_000,
          subjectId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });

    const firstPage = await t.mutation(
      internal.backgroundSync.projectBackfilledPurchasesForProduct,
      {
        authUserId: creatorAuthUserId,
        productId,
        provider: 'gumroad',
        providerProductRef,
        limit: 2,
      }
    );

    expect(firstPage).toMatchObject({ purchaseFactsFound: 2, isDone: false });

    const secondPage = await t.mutation(
      internal.backgroundSync.projectBackfilledPurchasesForProduct,
      {
        authUserId: creatorAuthUserId,
        productId,
        provider: 'gumroad',
        providerProductRef,
        cursor: firstPage.continueCursor,
        limit: 2,
      }
    );

    expect(secondPage).toMatchObject({ purchaseFactsFound: 1, isDone: true });
    const entitlements = await t.run(async (ctx) =>
      ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', subjectId)
        )
        .collect()
    );
    expect(entitlements).toHaveLength(3);
  });
});
