/**
 * Integration tests for Webhook Ingestion and Processing Pipeline
 *
 * Run with: npx vitest run --config convex/vitest.config.ts convex/webhooks.realtest.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'test-secret';

const BASE_WEBHOOK_ARGS = {
  apiSecret: API_SECRET,
  authUserId: 'auth-1',
  provider: 'gumroad',
  providerEventId: 'sale_abc',
  eventType: 'sale',
  rawPayload: {},
  signatureValid: true,
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
