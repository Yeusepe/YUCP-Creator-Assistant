/**
 * Integration tests for Webhook Ingestion and Processing Pipeline
 *
 * Run with: npx vitest run --config convex/vitest.config.ts convex/webhooks.realtest.ts
 *
 * Security refs from plan.md:
 * - https://docs.convex.dev/testing/convex-test
 * - https://www.svix.com/resources/webhook-best-practices/receiving/
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

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

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
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

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event?.status).toBe('processed');
    // No subject linked — purchase_fact exists but no entitlement
    const facts = await t.run(async (ctx) => ctx.db.query('purchase_facts').collect());
    expect(facts).toHaveLength(1);
    expect(facts[0].subjectId).toBeUndefined();
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

    expect(await t.run(async (ctx) => ctx.db.get(eventId))).toMatchObject({ status: 'pending' });
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
      ctx.runQuery(internal.webhookIngestion.getPendingWebhookEvents, {
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
      ctx.runQuery(internal.webhookIngestion.getPendingWebhookEvents, {
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

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
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
      rawPayload: { sale_id: 'rt-reset-001', product_id: 'prod-reset', email: 'buyer-reset@example.com' },
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

    const processed = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(processed?.status).toBe('processed');

    // Now reset for reprocessing
    await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookIngestion.resetWebhookForReprocessing, {
        apiSecret: API_SECRET,
        eventId,
      })
    );

    const reset = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(reset?.status).toBe('pending');
  });
});
