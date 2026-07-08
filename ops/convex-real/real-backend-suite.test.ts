import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { API_ACTOR_TTL_MS, parseApiActorPayload } from '@yucp/shared/apiActor';
import { sha256Hex } from '@yucp/shared/crypto';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import {
  getTestActorBindingForTest,
  makeRealConvex,
  type RealConvex,
  removeRealBackendEnv,
  resetTestActorBindingCacheForTest,
  restoreRealBackendTestSignal,
  waitFor,
} from './harness';

let t: RealConvex;

function unique(label: string): string {
  return `${label}-${Date.now()}-${crypto.randomUUID()}`;
}

async function seedSubject(
  input: {
    authUserId?: string;
    primaryDiscordUserId?: string;
    status?: 'active' | 'suspended' | 'quarantined' | 'deleted';
  } = {}
): Promise<Id<'subjects'>> {
  const now = Date.now();
  return await t.insert('subjects', {
    primaryDiscordUserId: input.primaryDiscordUserId ?? unique('discord'),
    status: input.status ?? 'active',
    authUserId: input.authUserId,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedCreatorProfile(input: {
  authUserId: string;
  ownerDiscordUserId?: string;
}): Promise<Id<'creator_profiles'>> {
  const now = Date.now();
  return await t.insert('creator_profiles', {
    authUserId: input.authUserId,
    name: 'Real Backend Test Creator',
    ownerDiscordUserId: input.ownerDiscordUserId ?? unique('creator-discord'),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
}

async function seedExternalAccount(input: {
  provider?: 'discord' | 'gumroad' | 'jinxxy' | 'lemonsqueezy' | 'payhip' | 'vrchat';
  providerUserId: string;
  emailHash?: string;
}): Promise<Id<'external_accounts'>> {
  const now = Date.now();
  return await t.insert('external_accounts', {
    provider: input.provider ?? 'discord',
    providerUserId: input.providerUserId,
    emailHash: input.emailHash,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
}

async function seedCatalogProduct(input: {
  authUserId: string;
  productId: string;
  provider: 'gumroad' | 'payhip';
  providerProductRef: string;
}): Promise<Id<'product_catalog'>> {
  const now = Date.now();
  return await t.insert('product_catalog', {
    authUserId: input.authUserId,
    productId: input.productId,
    provider: input.provider,
    providerProductRef: input.providerProductRef,
    displayName: 'Real Backend Product',
    status: 'active',
    supportsAutoDiscovery: true,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPurchaseFact(input: {
  authUserId: string;
  provider: 'gumroad' | 'payhip';
  providerProductId: string;
  externalOrderId: string;
  buyerEmailHash?: string;
  subjectId?: Id<'subjects'>;
}): Promise<Id<'purchase_facts'>> {
  const now = Date.now();
  return await t.insert('purchase_facts', {
    authUserId: input.authUserId,
    provider: input.provider,
    externalOrderId: input.externalOrderId,
    buyerEmailHash: input.buyerEmailHash,
    providerProductId: input.providerProductId,
    paymentStatus: 'paid',
    lifecycleStatus: 'active',
    purchasedAt: now - 60_000,
    subjectId: input.subjectId,
    createdAt: now,
    updatedAt: now,
  });
}

beforeAll(async () => {
  t = await makeRealConvex();
});

beforeEach(async () => {
  await t.clearAll();
});

afterEach(async () => {
  await t.clearAll();
});

describe('real Convex backend contracts', () => {
  test('test-only deployed helpers reject when the real-backend test signal is absent', async () => {
    await removeRealBackendEnv('IS_TEST');
    try {
      await expect(t.clearAll()).rejects.toThrow('testHelpersReal functions require IS_TEST=true');
    } finally {
      await restoreRealBackendTestSignal();
    }
  });

  test('real backend harness refreshes the signed service actor before expiry', async () => {
    const issuedAt = 1_700_000_000_000;
    resetTestActorBindingCacheForTest();

    const first = await getTestActorBindingForTest(issuedAt);
    const reused = await getTestActorBindingForTest(issuedAt + API_ACTOR_TTL_MS - 30_001);
    expect(reused).toEqual(first);

    const refreshed = await getTestActorBindingForTest(issuedAt + API_ACTOR_TTL_MS - 30_000);
    expect(refreshed).not.toEqual(first);

    const firstActor = parseApiActorPayload(first.payload);
    const refreshedActor = parseApiActorPayload(refreshed.payload);
    expect(firstActor?.expiresAt).toBe(issuedAt + API_ACTOR_TTL_MS);
    expect(refreshedActor?.expiresAt).toBe(issuedAt + 2 * API_ACTOR_TTL_MS - 30_000);
  });

  test('public manual-license bounds run through the deployed backend', async () => {
    const authUserId = unique('auth-manual-bounds');

    await expect(
      t.mutation(api.manualLicenses.bulkCreate, {
        apiSecret: t.apiSecret,
        authUserId,
        licenses: Array.from({ length: 101 }, (_, index) => ({
          licenseKeyHash: `${index}`.padStart(64, '0'),
          productId: `product-${index}`,
        })),
      })
    ).rejects.toThrow('Maximum of 100 licenses per bulk request');
  });

  test('raw seed helpers feed public subject and entitlement reads', async () => {
    const creatorAuthUserId = unique('creator-subject-contract');
    const buyerAuthUserId = unique('buyer-subject-contract');
    const discordUserId = unique('discord-contract');
    const subjectId = await seedSubject({
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: discordUserId,
    });
    const externalAccountId = await seedExternalAccount({
      provider: 'discord',
      providerUserId: discordUserId,
    });

    await t.mutation(api.bindings.activateBinding, {
      apiSecret: t.apiSecret,
      authUserId: creatorAuthUserId,
      subjectId,
      externalAccountId,
      bindingType: 'verification',
    });

    const entitlementId = await t.insert('entitlements', {
      authUserId: creatorAuthUserId,
      subjectId,
      productId: 'product-real-entitlement-contract',
      sourceProvider: 'gumroad',
      sourceReference: 'source-real-entitlement-contract',
      status: 'active',
      grantedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const resolved = await t.query(api.subjects.resolveSubjectForPublicApi, {
      apiSecret: t.apiSecret,
      authUserId: creatorAuthUserId,
      selector: { subjectId },
    });
    expect(resolved).toMatchObject({
      found: true,
      subject: {
        _id: subjectId,
        authUserId: buyerAuthUserId,
        primaryDiscordUserId: discordUserId,
        status: 'active',
      },
    });

    const entitlements = await t.query(api.entitlements.getEntitlementsBySubject, {
      apiSecret: t.apiSecret,
      authUserId: creatorAuthUserId,
      subjectId,
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]).toMatchObject({
      _id: entitlementId,
      subjectId,
      productId: 'product-real-entitlement-contract',
      sourceProvider: 'gumroad',
      status: 'active',
    });
    expect('sourceReference' in entitlements[0]).toBe(false);

    const withoutActor = await makeRealConvex({ injectActor: false });
    await expect(
      withoutActor.query(api.entitlements.getEntitlementsBySubject, {
        apiSecret: t.apiSecret,
        authUserId: creatorAuthUserId,
        subjectId,
      } as never)
    ).rejects.toThrow(/actor/);
  });

  test('internal backfill projection materializes entitlements and buyer links', async () => {
    const creatorAuthUserId = unique('creator-backfill');
    const buyerAuthUserId = unique('buyer-backfill');
    const buyerEmail = `${unique('buyer')}@example.com`;
    const buyerEmailHash = await sha256Hex(buyerEmail);
    const buyerSubjectId = await seedSubject({
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: unique('discord-backfill'),
    });

    await seedCreatorProfile({ authUserId: creatorAuthUserId });
    await seedCatalogProduct({
      authUserId: creatorAuthUserId,
      productId: 'gumroad-real-follow-up-product',
      provider: 'gumroad',
      providerProductRef: 'gumroad-real-follow-up-ref',
    });

    const syncResult = await t.mutation(api.identitySync.syncUserFromProvider, {
      apiSecret: t.apiSecret,
      authUserId: buyerAuthUserId,
      provider: 'gumroad',
      providerUserId: 'gumroad-real-backfill-buyer',
      username: 'Real Backfill Buyer',
      email: buyerEmail,
      discordUserId: unique('discord-backfill-sync'),
    });

    await t.mutation(api.bindings.activateBinding, {
      apiSecret: t.apiSecret,
      authUserId: buyerAuthUserId,
      subjectId: buyerSubjectId,
      externalAccountId: syncResult.externalAccountId,
      bindingType: 'verification',
    });

    await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: t.apiSecret,
      subjectId: buyerSubjectId,
      provider: 'gumroad',
      externalAccountId: syncResult.externalAccountId,
      verificationMethod: 'account_link',
    });

    await seedPurchaseFact({
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      providerProductId: 'gumroad-real-follow-up-ref',
      externalOrderId: 'historical-order',
      buyerEmailHash,
    });

    const projection = await t.mutation(
      internal.backgroundSync.projectBackfilledPurchasesForProduct,
      {
        authUserId: creatorAuthUserId,
        productId: 'gumroad-real-follow-up-product',
        provider: 'gumroad',
        providerProductRef: 'gumroad-real-follow-up-ref',
      }
    );

    expect(projection).toMatchObject({
      purchaseFactsFound: 1,
      linkedToSubject: 1,
      entitlementsGranted: 1,
      unresolved: 0,
    });

    const entitlement = await t.query(api.entitlements.getActiveEntitlement, {
      apiSecret: t.apiSecret,
      authUserId: creatorAuthUserId,
      subjectId: buyerSubjectId,
      productId: 'gumroad-real-follow-up-product',
    });
    expect(entitlement).toMatchObject({
      found: true,
      entitlement: expect.objectContaining({
        subjectId: buyerSubjectId,
        productId: 'gumroad-real-follow-up-product',
        sourceProvider: 'gumroad',
      }),
    });
  });

  test('webhook ingestion deduplicates concurrently on the real database', async () => {
    const authUserId = unique('auth-webhook-dedup');
    const providerEventId = unique('sale-real-dedup');
    const args = {
      apiSecret: t.apiSecret,
      authUserId,
      provider: 'gumroad' as const,
      providerEventId,
      eventType: 'sale',
      rawPayload: {},
      signatureValid: true,
      verificationMethod: 'hmac',
    };

    const results = await Promise.all([
      t.mutation(api.webhookIngestion.insertWebhookEvent, args),
      t.mutation(api.webhookIngestion.insertWebhookEvent, args),
      t.mutation(api.webhookIngestion.insertWebhookEvent, args),
    ]);

    expect(results.filter((result) => result.duplicate === false)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate === true)).toHaveLength(2);

    const events = await t.collect('webhook_events');
    expect(events).toHaveLength(1);
  });

  test('internal webhook processing updates persisted event state', async () => {
    const authUserId = unique('auth-webhook-processing');
    const insertResult = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: t.apiSecret,
      authUserId,
      provider: 'gumroad',
      providerEventId: unique('sale-process'),
      eventType: 'sale',
      rawPayload: {
        sale_id: 'sale-real-processing',
        product_id: 'prod-real-processing',
        email: 'buyer-real-processing@example.com',
      },
      signatureValid: true,
      verificationMethod: 'hmac',
    });

    const processResult = await t.mutation(internal.webhookProcessing.processWebhookEvent, {
      apiSecret: t.apiSecret,
      eventId: insertResult.eventId!,
    });

    expect(processResult).toMatchObject({ success: true });
    const event = await t.get(insertResult.eventId!);
    expect(event).toMatchObject({ status: 'processed' });

    const purchaseFacts = await t.collect('purchase_facts');
    expect(purchaseFacts).toHaveLength(1);
    expect(purchaseFacts[0]).toMatchObject({
      authUserId,
      provider: 'gumroad',
      externalOrderId: 'sale-real-processing',
    });
  });

  test('webhook delivery lifecycle runs through internal admin calls and public reads', async () => {
    const authUserId = unique('auth-webhook-delivery');
    const subscriptionId = await t.mutation(api.webhookSubscriptions.create, {
      apiSecret: t.apiSecret,
      authUserId,
      url: 'https://example.com/webhooks/yucp',
      events: ['ping'],
      signingSecretEnc: 'encrypted-secret',
      signingSecretPrefix: 'whsec_real',
    });

    const eventId = await t.mutation(internal.creatorEvents.emitEvent, {
      apiSecret: t.apiSecret,
      authUserId,
      eventType: 'ping',
      resourceType: 'ping',
      resourceId: 'first',
      data: { ok: true },
    });
    const fanoutCount = await t.mutation(internal.creatorEvents.fanOutToSubscriptions, {
      eventId,
      authUserId,
      eventType: 'ping',
    });
    expect(fanoutCount).toBe(1);

    const pendingForWorker = await t.query(internal.webhookDeliveries.listPending, {});
    expect(pendingForWorker).toHaveLength(1);

    const pendingList = await t.query(api.webhookDeliveries.listBySubscription, {
      apiSecret: t.apiSecret,
      authUserId,
      subscriptionId,
      status: 'pending',
      limit: 10,
    });
    expect(pendingList.deliveries).toHaveLength(1);

    const deliveryId = pendingList.deliveries[0]._id as Id<'webhook_deliveries'>;
    await t.mutation(internal.webhookDeliveries.markInProgress, { deliveryId });
    await t.mutation(internal.webhookDeliveries.markFailed, {
      deliveryId,
      lastHttpStatus: 503,
      lastError: 'temporary failure',
    });

    const failedList = await t.query(api.webhookDeliveries.listBySubscription, {
      apiSecret: t.apiSecret,
      authUserId,
      subscriptionId,
      status: 'failed',
    });
    expect(failedList.deliveries).toHaveLength(1);
    expect(failedList.deliveries[0]).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      lastHttpStatus: 503,
    });
  });

  test('real scheduler runs Payhip product projection without fake timers', async () => {
    const authUserId = unique('auth-payhip-scheduler');
    const subjectId = await seedSubject({
      authUserId,
      primaryDiscordUserId: unique('discord-payhip-scheduler'),
    });
    await seedCreatorProfile({ authUserId });
    await seedPurchaseFact({
      authUserId,
      provider: 'payhip',
      providerProductId: 'PAYHIPREAL',
      externalOrderId: 'payhip-real-order',
      subjectId,
    });

    await t.mutation(api.role_rules.addProductFromPayhip, {
      apiSecret: t.apiSecret,
      authUserId,
      permalink: 'PAYHIPREAL',
      displayName: 'Real Payhip Product',
    });

    await waitFor(
      async () => {
        const entitlements = await t.collect('entitlements');
        return entitlements.some(
          (entitlement) =>
            entitlement.authUserId === authUserId &&
            entitlement.productId === 'PAYHIPREAL' &&
            entitlement.sourceProvider === 'payhip'
        );
      },
      {
        description: 'Payhip scheduler projection to create an entitlement',
        timeoutMs: 30_000,
      }
    );
  });
});
