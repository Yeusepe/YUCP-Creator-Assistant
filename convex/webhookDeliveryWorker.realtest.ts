import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

const AUTH_USER_ID = 'auth-webhook-delivery-worker';

async function seedFailedDelivery(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    attemptCount?: number;
    maxAttempts?: number;
    nextRetryAt?: number;
    status?: 'failed' | 'dead_letter';
  } = {}
) {
  const now = Date.now();
  return await t.run(async (ctx) => {
    const subscriptionId = await ctx.db.insert('webhook_subscriptions', {
      authUserId: AUTH_USER_ID,
      url: 'https://example.com/webhooks/retry-test',
      events: ['ping'],
      enabled: true,
      signingSecretEnc: 'invalid-ciphertext',
      signingSecretPrefix: 'whsec_test',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert('creator_events', {
      authUserId: AUTH_USER_ID,
      eventType: 'ping',
      resourceType: 'test',
      resourceId: 'retry-test',
      data: { ok: true },
      createdAt: now,
    });
    return await ctx.db.insert('webhook_deliveries', {
      authUserId: AUTH_USER_ID,
      subscriptionId,
      eventId,
      status: overrides.status ?? 'failed',
      attemptCount: overrides.attemptCount ?? 1,
      maxAttempts: overrides.maxAttempts ?? 5,
      nextRetryAt: overrides.nextRetryAt ?? now - 1,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('processWebhookDeliveries retry scheduling', () => {
  it('re-attempts a failed delivery whose retry time has elapsed', async () => {
    const t = makeTestConvex();
    const deliveryId = await seedFailedDelivery(t);

    const result = await t.action(internal.webhookDeliveryWorker.processWebhookDeliveries, {});

    expect(result).toMatchObject({ processed: 0, failed: 1 });
    const delivery = await t.run(async (ctx) => await ctx.db.get(deliveryId));
    expect(delivery).toMatchObject({
      status: 'failed',
      attemptCount: 2,
      lastError: 'Failed to decrypt signing secret',
    });
    expect(delivery?.nextRetryAt).toBeGreaterThan(Date.now());
  });

  it('does not retry a dead-lettered delivery at the max-attempt cap', async () => {
    const t = makeTestConvex();
    const deliveryId = await seedFailedDelivery(t, {
      attemptCount: 4,
      maxAttempts: 5,
    });

    await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookDeliveries.markFailed, { deliveryId })
    );

    const result = await t.action(internal.webhookDeliveryWorker.processWebhookDeliveries, {});

    expect(result).toEqual({ processed: 0, failed: 0, errors: [] });
    const delivery = await t.run(async (ctx) => await ctx.db.get(deliveryId));
    expect(delivery).toMatchObject({ status: 'dead_letter', attemptCount: 5 });
  });

  it('does not retry a failed delivery before its retry time', async () => {
    const t = makeTestConvex();
    const deliveryId = await seedFailedDelivery(t, { nextRetryAt: Date.now() + 60_000 });

    const result = await t.action(internal.webhookDeliveryWorker.processWebhookDeliveries, {});

    expect(result).toEqual({ processed: 0, failed: 0, errors: [] });
    const delivery = await t.run(async (ctx) => await ctx.db.get(deliveryId));
    expect(delivery).toMatchObject({ status: 'failed', attemptCount: 1 });
  });
});
