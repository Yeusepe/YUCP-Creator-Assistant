/**
 * Integration tests for Webhook Ingestion and Processing Pipeline
 *
 * Run with: npx vitest run --config convex/vitest.config.ts convex/webhooks.realtest.ts
 *
 * Security refs from plan.md:
 * - https://docs.convex.dev/testing/convex-test
 * - https://www.svix.com/resources/webhook-best-practices/receiving/
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { makeTestConvex, seedCreatorProfile, seedSubject } from './testHelpers';

const API_SECRET = 'test-secret';

async function getWebhookSecurityCounts(t: ReturnType<typeof makeTestConvex>) {
  return t.run(async (ctx) => ({
    webhookEvents: (await ctx.db.query('webhook_events').collect()).length,
    purchaseFacts: (await ctx.db.query('purchase_facts').collect()).length,
    entitlements: (await ctx.db.query('entitlements').collect()).length,
  }));
}

const BASE_WEBHOOK_ARGS = {
  apiSecret: API_SECRET,
  authUserId: 'auth-1',
  provider: 'gumroad',
  providerEventId: 'sale_abc',
  eventType: 'sale',
  rawPayload: {},
  signatureValid: true,
  verificationMethod: 'hmac',
} as const;

// ---------------------------------------------------------------------------
// insertWebhookEvent
// ---------------------------------------------------------------------------

describe('insertWebhookEvent', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });

  it('given valid event, when inserted, then stored with status=pending and returns success=true', async () => {
    const t = makeTestConvex();

    const result = await t.mutation(api.webhookIngestion.insertWebhookEvent, BASE_WEBHOOK_ARGS);

    expect(result.success).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.eventId).toBeTruthy();

    const events = await t.run(async (ctx) => ctx.db.query('webhook_events').collect());
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('pending');
    expect(events[0].signatureValid).toBe(true);
  });

  it('given same (authUserId, provider, providerEventId) inserted twice, then duplicate=true and only 1 record', async () => {
    const t = makeTestConvex();

    const first = await t.mutation(api.webhookIngestion.insertWebhookEvent, BASE_WEBHOOK_ARGS);
    const second = await t.mutation(api.webhookIngestion.insertWebhookEvent, BASE_WEBHOOK_ARGS);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.success).toBe(true);
    // duplicate response does not include an eventId
    expect(second.eventId).toBeUndefined();

    const events = await t.run(async (ctx) => ctx.db.query('webhook_events').collect());
    expect(events).toHaveLength(1);
  });

  it('given signatureValid=false, when inserted, then record is stored with signatureValid=false', async () => {
    const t = makeTestConvex();

    await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      ...BASE_WEBHOOK_ARGS,
      providerEventId: 'sale_invalid_sig',
      signatureValid: false,
    });

    const events = await t.run(async (ctx) => ctx.db.query('webhook_events').collect());
    expect(events).toHaveLength(1);
    expect(events[0].signatureValid).toBe(false);
    expect(events[0].status).toBe('pending');
  });

  it('given wrong apiSecret, when webhook inserted, then rejects and writes nothing', async () => {
    const t = makeTestConvex();
    const before = await getWebhookSecurityCounts(t);

    await expect(
      t.mutation(api.webhookIngestion.insertWebhookEvent, {
        ...BASE_WEBHOOK_ARGS,
        apiSecret: 'wrong-secret',
        providerEventId: 'sale_wrong_secret',
      })
    ).rejects.toThrow('Unauthorized');

    expect(await getWebhookSecurityCounts(t)).toEqual(before);
  });

  it('given same providerEventId in different tenants, then dedup remains tenant-scoped', async () => {
    const t = makeTestConvex();

    await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      ...BASE_WEBHOOK_ARGS,
      authUserId: 'auth-tenant-a',
      providerEventId: 'sale_tenant_scoped',
    });
    await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      ...BASE_WEBHOOK_ARGS,
      authUserId: 'auth-tenant-b',
      providerEventId: 'sale_tenant_scoped',
    });

    const events = await t.run(async (ctx) =>
      ctx.db
        .query('webhook_events')
        .withIndex('by_provider_event', (q) =>
          q.eq('provider', 'gumroad').eq('providerEventId', 'sale_tenant_scoped')
        )
        .collect()
    );

    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.authUserId))).toEqual(
      new Set(['auth-tenant-a', 'auth-tenant-b'])
    );
  });
});

// ---------------------------------------------------------------------------
// processWebhookEvent pipeline
// ---------------------------------------------------------------------------

describe('processWebhookEvent pipeline', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('given pending gumroad webhook event, when processed, then status becomes processed', async () => {
    const t = makeTestConvex();

    const insertResult = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: 'auth-creator-1',
      provider: 'gumroad',
      providerEventId: 'sale_process_1',
      eventType: 'sale',
      rawPayload: {
        sale_id: 'sale-001',
        product_id: 'prod-abc',
        email: 'buyer@example.com',
      },
      signatureValid: true,
      verificationMethod: 'hmac',
    });

    const eventId = insertResult.eventId!;
    expect(eventId).toBeTruthy();

    const processResult = await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookProcessing.processWebhookEvent, {
        apiSecret: API_SECRET,
        eventId,
      })
    );

    expect(processResult.success).toBe(true);
    expect(processResult.error).toBeUndefined();

    const event = (await t.run(async (ctx) => ctx.db.get(eventId))) as Doc<'webhook_events'> | null;
    expect(event?.status).toBe('processed');
  });

  it('given already-processed event, when processed again, then no duplicate purchase_facts created', async () => {
    const t = makeTestConvex();

    const insertResult = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: 'auth-creator-2',
      provider: 'gumroad',
      providerEventId: 'sale_process_2',
      eventType: 'sale',
      rawPayload: {
        sale_id: 'sale-002',
        product_id: 'prod-abc',
        email: 'buyer2@example.com',
      },
      signatureValid: true,
      verificationMethod: 'hmac',
    });

    const eventId = insertResult.eventId!;

    // First processing
    await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookProcessing.processWebhookEvent, {
        apiSecret: API_SECRET,
        eventId,
      })
    );

    const factsBefore = await t.run(async (ctx) => ctx.db.query('purchase_facts').collect());

    // Second processing of same event
    const reprocessResult = await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookProcessing.processWebhookEvent, {
        apiSecret: API_SECRET,
        eventId,
      })
    );

    expect(reprocessResult.success).toBe(true);

    const factsAfter = await t.run(async (ctx) => ctx.db.query('purchase_facts').collect());
    expect(factsAfter.length).toBe(factsBefore.length);
  });

  it('given event with unknown buyer email, when processed, then event completes without crash', async () => {
    const t = makeTestConvex();

    const insertResult = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: 'auth-creator-3',
      provider: 'gumroad',
      providerEventId: 'sale_unknown_buyer',
      eventType: 'sale',
      rawPayload: {
        sale_id: 'sale-003',
        product_id: 'prod-abc',
        email: 'nobody@totally-unknown-domain.invalid',
      },
      signatureValid: true,
      verificationMethod: 'hmac',
    });

    const eventId = insertResult.eventId!;

    const processResult = await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookProcessing.processWebhookEvent, {
        apiSecret: API_SECRET,
        eventId,
      })
    );

    expect(processResult.success).toBe(true);

    const event = (await t.run(async (ctx) => ctx.db.get(eventId))) as Doc<'webhook_events'> | null;
    expect(event?.status).toBe('processed');
    // No subject linked, purchase_fact exists but no entitlement
    const facts = await t.run(async (ctx) => ctx.db.query('purchase_facts').collect());
    expect(facts).toHaveLength(1);
    expect(facts[0].subjectId).toBeUndefined();
  });

  it('given tiered Gumroad sale payload, when processed, then the canonical tier ref is stored and resolves the matching catalog tier', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-creator-gumroad-tier-webhook';
    const buyerAuthUserId = 'auth-buyer-gumroad-tier-webhook';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-gumroad-tier-webhook',
    });

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-creator-gumroad-tier-webhook',
    });

    const syncResult = await t.mutation(api.identitySync.syncUserFromProvider, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      provider: 'gumroad',
      providerUserId: 'gumroad-tier-webhook-buyer',
      username: 'Tier Webhook Buyer',
      email: 'gumroad-tier-webhook@example.com',
      discordUserId: 'discord-gumroad-tier-webhook',
    });

    await t.mutation(api.bindings.activateBinding, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
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

    const catalogProductId = await t.run(async (ctx) =>
      ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'local-gumroad-tier-webhook-product',
        provider: 'gumroad',
        providerProductRef: 'gumroad-tier-webhook-product',
        displayName: 'Tier Webhook Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const catalogTierId = await t.mutation(api.catalogTiers.upsertCatalogTier, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      productId: 'local-gumroad-tier-webhook-product',
      catalogProductId,
      providerProductRef: 'gumroad-tier-webhook-product',
      providerTierRef:
        'gumroad|product|28:gumroad-tier-webhook-product|variant|4:tier|option|4:gold|recurrence|7:monthly',
      displayName: 'Gold Monthly',
      amountCents: 1500,
      currency: 'USD',
      status: 'active',
    });

    const insertResult = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      providerEventId: 'sale_tiered_webhook',
      eventType: 'sale',
      rawPayload: {
        sale_id: 'sale-tier-webhook',
        product_id: 'gumroad-tier-webhook-product',
        email: 'gumroad-tier-webhook@example.com',
        variants: 'Tier: Gold',
        recurrence: 'monthly',
        subscription_id: 'sub_123',
      },
      signatureValid: true,
      verificationMethod: 'hmac',
    });

    const processResult = await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookProcessing.processWebhookEvent, {
        apiSecret: API_SECRET,
        eventId: insertResult.eventId!,
      })
    );

    expect(processResult.success).toBe(true);

    const facts = await t.run(async (ctx) => ctx.db.query('purchase_facts').collect());
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      provider: 'gumroad',
      externalOrderId: 'sale-tier-webhook',
      externalVariantId:
        'gumroad|product|28:gumroad-tier-webhook-product|variant|4:tier|option|4:gold|recurrence|7:monthly',
      subjectId: buyerSubjectId,
    });

    const entitlement = await t.query(api.entitlements.getActiveEntitlement, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      subjectId: buyerSubjectId,
      productId: 'local-gumroad-tier-webhook-product',
    });

    expect(entitlement.found).toBe(true);
    if (!entitlement.entitlement) {
      throw new Error('Expected active entitlement');
    }

    const tierIds = await t.query(api.catalogTiers.getActiveCatalogTierIdsForEntitlement, {
      apiSecret: API_SECRET,
      entitlementId: entitlement.entitlement._id,
    });

    expect(tierIds).toEqual([catalogTierId]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it('given Gumroad webhook only exposes short_product_id, when processed, then tier refs still resolve', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-gumroad-short-product-tier';
    const buyerAuthUserId = 'buyer-gumroad-short-product-tier';
    const buyerEmail = 'gumroad-short-product-tier@example.com';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-gumroad-short-product-tier',
    });
    const providerProductRef = 'AbC123xY';

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-creator-gumroad-short-product-tier',
    });

    const syncResult = await t.mutation(api.identitySync.syncUserFromProvider, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      provider: 'gumroad',
      providerUserId: 'gumroad-short-product-tier-buyer',
      username: 'Short Product Buyer',
      email: buyerEmail,
      discordUserId: 'discord-gumroad-short-product-tier',
    });

    await t.mutation(api.bindings.activateBinding, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
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

    const catalogProductId = await t.run(async (ctx) =>
      ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'local-gumroad-short-product-tier',
        provider: 'gumroad',
        providerProductRef,
        displayName: 'Short Product Tier Webhook Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const catalogTierId = await t.mutation(api.catalogTiers.upsertCatalogTier, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      productId: 'local-gumroad-short-product-tier',
      catalogProductId,
      providerProductRef,
      providerTierRef:
        'gumroad|product|8:AbC123xY|variant|4:tier|option|4:gold|recurrence|7:monthly',
      displayName: 'Gold Monthly',
      amountCents: 1500,
      currency: 'USD',
      status: 'active',
    });

    const insertResult = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      providerEventId: 'sale_short_product_tiered_webhook',
      eventType: 'sale',
      rawPayload: {
        sale_id: 'sale-short-product-tier-webhook',
        short_product_id: providerProductRef,
        email: buyerEmail,
        variants: 'Tier: Gold',
        recurrence: 'monthly',
        subscription_id: 'sub_short_123',
      },
      signatureValid: true,
      verificationMethod: 'hmac',
    });

    const processResult = await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookProcessing.processWebhookEvent, {
        apiSecret: API_SECRET,
        eventId: insertResult.eventId!,
      })
    );

    expect(processResult.success).toBe(true);

    const facts = await t.run(async (ctx) => ctx.db.query('purchase_facts').collect());
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      provider: 'gumroad',
      externalOrderId: 'sale-short-product-tier-webhook',
      providerProductId: providerProductRef,
      externalVariantId:
        'gumroad|product|8:AbC123xY|variant|4:tier|option|4:gold|recurrence|7:monthly',
      subjectId: buyerSubjectId,
    });

    const entitlement = await t.query(api.entitlements.getActiveEntitlement, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      subjectId: buyerSubjectId,
      productId: 'local-gumroad-short-product-tier',
    });

    expect(entitlement.found).toBe(true);
    if (!entitlement.entitlement) {
      throw new Error('Expected active entitlement');
    }

    const tierIds = await t.query(api.catalogTiers.getActiveCatalogTierIdsForEntitlement, {
      apiSecret: API_SECRET,
      entitlementId: entitlement.entitlement._id,
    });

    expect(tierIds).toEqual([catalogTierId]);
  });

  it('given wrong apiSecret, when webhook processing is attempted, then pending event remains unchanged', async () => {
    const t = makeTestConvex();

    const insertResult = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: 'auth-creator-4',
      provider: 'gumroad',
      providerEventId: 'sale_process_wrong_secret',
      eventType: 'sale',
      rawPayload: {
        sale_id: 'sale-004',
        product_id: 'prod-abc',
        email: 'buyer4@example.com',
      },
      signatureValid: true,
      verificationMethod: 'hmac',
    });
    const eventId = insertResult.eventId!;
    const before = await getWebhookSecurityCounts(t);

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.webhookProcessing.processWebhookEvent, {
          apiSecret: 'wrong-secret',
          eventId,
        })
      )
    ).rejects.toThrow('Unauthorized');

    expect(
      (await t.run(async (ctx) => ctx.db.get(eventId))) as Doc<'webhook_events'> | null
    ).toMatchObject({ status: 'pending' });
    expect(await getWebhookSecurityCounts(t)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// webhook deduplication
// ---------------------------------------------------------------------------

describe('webhook deduplication', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });

  it('given same event sent 3 times concurrently, then only 1 record in DB', async () => {
    const t = makeTestConvex();

    const args = {
      apiSecret: API_SECRET,
      authUserId: 'auth-concurrent',
      provider: 'gumroad',
      providerEventId: 'sale_concurrent_dedup',
      eventType: 'sale',
      rawPayload: {},
      signatureValid: true,
      verificationMethod: 'hmac',
    } as const;

    await Promise.all([
      t.mutation(api.webhookIngestion.insertWebhookEvent, args),
      t.mutation(api.webhookIngestion.insertWebhookEvent, args),
      t.mutation(api.webhookIngestion.insertWebhookEvent, args),
    ]);

    const events = await t.run(async (ctx) => ctx.db.query('webhook_events').collect());
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// verificationMethod trust model
// ---------------------------------------------------------------------------

describe('verificationMethod trust model', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });

  it('given route-token event (signatureValid:false, verificationMethod:route-token), then getPendingWebhookEvents includes it', async () => {
    const t = makeTestConvex();

    const result = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: 'auth-gumroad-1',
      provider: 'gumroad',
      providerEventId: 'sale_route_token_1',
      eventType: 'sale',
      rawPayload: { sale_id: 'rt-001', product_id: 'prod-x' },
      signatureValid: false,
      verificationMethod: 'route-token',
    });

    expect(result.eventId).toBeTruthy();

    const pending = await t.run(async (ctx) =>
      ctx.runQuery(api.webhookIngestion.getPendingWebhookEvents, {
        apiSecret: API_SECRET,
        limit: 10,
      })
    );

    const ids = pending.map((e: { _id: string }) => e._id);
    expect(ids).toContain(result.eventId);
  });

  it('given unverified event (signatureValid:false, no verificationMethod), then getPendingWebhookEvents excludes it', async () => {
    const t = makeTestConvex();

    const result = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: 'auth-unverified-1',
      provider: 'gumroad',
      providerEventId: 'sale_unverified_1',
      eventType: 'sale',
      rawPayload: { sale_id: 'uv-001' },
      signatureValid: false,
    });

    expect(result.eventId).toBeTruthy();

    const pending = await t.run(async (ctx) =>
      ctx.runQuery(api.webhookIngestion.getPendingWebhookEvents, {
        apiSecret: API_SECRET,
        limit: 10,
      })
    );

    const ids = pending.map((e: { _id: string }) => e._id);
    expect(ids).not.toContain(result.eventId);
  });

  it('given route-token event, when processWebhookEvent is called, then it processes successfully', async () => {
    const t = makeTestConvex();

    const result = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: 'auth-gumroad-2',
      provider: 'gumroad',
      providerEventId: 'sale_route_token_process',
      eventType: 'sale',
      rawPayload: { sale_id: 'rt-proc-001', product_id: 'prod-y', email: 'buyer-rt@example.com' },
      signatureValid: false,
      verificationMethod: 'route-token',
    });

    const eventId = result.eventId!;

    const processResult = await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookProcessing.processWebhookEvent, {
        apiSecret: API_SECRET,
        eventId,
      })
    );

    expect(processResult.success).toBe(true);

    const event = (await t.run(async (ctx) => ctx.db.get(eventId))) as Doc<'webhook_events'> | null;
    expect(event?.status).toBe('processed');
  });

  it('given unverified event, when processWebhookEvent is called, then it throws', async () => {
    const t = makeTestConvex();

    const result = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: 'auth-unverified-2',
      provider: 'gumroad',
      providerEventId: 'sale_unverified_process',
      eventType: 'sale',
      rawPayload: { sale_id: 'uv-proc-001' },
      signatureValid: false,
    });

    const eventId = result.eventId!;

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.webhookProcessing.processWebhookEvent, {
          apiSecret: API_SECRET,
          eventId,
        })
      )
    ).rejects.toThrow();
  });

  it('given route-token event processed, when resetWebhookForReprocessing is called, then succeeds', async () => {
    const t = makeTestConvex();

    const result = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: 'auth-gumroad-3',
      provider: 'gumroad',
      providerEventId: 'sale_route_token_reset',
      eventType: 'sale',
      rawPayload: {
        sale_id: 'rt-reset-001',
        product_id: 'prod-reset',
        email: 'buyer-reset@example.com',
      },
      signatureValid: false,
      verificationMethod: 'route-token',
    });

    const eventId = result.eventId!;

    // Process it first
    await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookProcessing.processWebhookEvent, {
        apiSecret: API_SECRET,
        eventId,
      })
    );

    const processed = (await t.run(async (ctx) =>
      ctx.db.get(eventId)
    )) as Doc<'webhook_events'> | null;
    expect(processed?.status).toBe('processed');

    // Now reset for reprocessing
    await t.run(async (ctx) =>
      ctx.runMutation(api.webhookIngestion.resetWebhookForReprocessing, {
        apiSecret: API_SECRET,
        eventId,
      })
    );

    const reset = (await t.run(async (ctx) => ctx.db.get(eventId))) as Doc<'webhook_events'> | null;
    expect(reset?.status).toBe('pending');
  });
});
