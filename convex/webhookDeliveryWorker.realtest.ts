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
  it('includes a due failed retry when the pending backlog reaches the batch limit', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const dueRetryId = await t.run(async (ctx) => {
      const subscriptionId = await ctx.db.insert('webhook_subscriptions', {
        authUserId: AUTH_USER_ID,
        url: 'https://example.com/webhooks/backlog-test',
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
        resourceId: 'backlog-test',
        data: { ok: true },
        createdAt: now,
      });

      for (let index = 0; index < 20; index++) {
        await ctx.db.insert('webhook_deliveries', {
          authUserId: AUTH_USER_ID,
          subscriptionId,
          eventId,
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 5,
          createdAt: now,
          updatedAt: now,
        });
      }

      return await ctx.db.insert('webhook_deliveries', {
        authUserId: AUTH_USER_ID,
        subscriptionId,
        eventId,
        status: 'failed',
        attemptCount: 1,
        maxAttempts: 5,
        nextRetryAt: now - 1,
        createdAt: now,
        updatedAt: now,
      });
    });

    const deliveries = await t.run(async (ctx) =>
      ctx.runQuery(internal.webhookDeliveries.listPending, {})
    );

    expect(deliveries).toHaveLength(20);
    expect(deliveries.map((delivery) => delivery._id)).toContain(dueRetryId);
  });

  it('atomically claims a due delivery once', async () => {
    const t = makeTestConvex();
    const deliveryId = await seedFailedDelivery(t);

    const firstClaim = await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookDeliveries.markInProgress, { deliveryId })
    );
    const secondClaim = await t.run(async (ctx) =>
      ctx.runMutation(internal.webhookDeliveries.markInProgress, { deliveryId })
    );

    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);
    const delivery = await t.run(async (ctx) => await ctx.db.get(deliveryId));
    expect(delivery).toMatchObject({ status: 'in_progress', attemptCount: 1 });
  });

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
