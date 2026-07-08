import {
  type ApiActorBinding,
  createApiActorBinding,
  createServiceApiActor,
} from '@yucp/shared/apiActor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { makeTestConvex, seedEntitlement, seedSubject } from './testHelpers';

const API_SECRET = 'test-secret';
const INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

const originalConvexApiSecret = process.env.CONVEX_API_SECRET;
const originalInternalServiceAuthSecret = process.env.INTERNAL_SERVICE_AUTH_SECRET;

function restoreEnv() {
  if (originalConvexApiSecret === undefined) {
    delete process.env.CONVEX_API_SECRET;
  } else {
    process.env.CONVEX_API_SECRET = originalConvexApiSecret;
  }

  if (originalInternalServiceAuthSecret === undefined) {
    delete process.env.INTERNAL_SERVICE_AUTH_SECRET;
  } else {
    process.env.INTERNAL_SERVICE_AUTH_SECRET = originalInternalServiceAuthSecret;
  }
}

async function createDelegatedActor(): Promise<ApiActorBinding> {
  return await createApiActorBinding(
    createServiceApiActor({
      service: 'convex-contract-test',
      scopes: ['creator:delegate'],
      now: Date.now(),
    }),
    INTERNAL_SERVICE_AUTH_SECRET
  );
}

async function seedExternalAccount(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    provider?: Doc<'external_accounts'>['provider'];
    providerUserId?: string;
  } = {}
): Promise<Id<'external_accounts'>> {
  return await t.run(async (ctx) =>
    ctx.db.insert('external_accounts', {
      provider: overrides.provider ?? 'discord',
      providerUserId: overrides.providerUserId ?? `provider-user-${Date.now()}`,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
}

async function seedCreatorScopedSubject(
  t: ReturnType<typeof makeTestConvex>,
  input: {
    authUserId: string;
    buyerAuthUserId: string;
    primaryDiscordUserId: string;
  }
): Promise<Id<'subjects'>> {
  const subjectId = await seedSubject(t, {
    authUserId: input.buyerAuthUserId,
    primaryDiscordUserId: input.primaryDiscordUserId,
  });
  const externalAccountId = await seedExternalAccount(t, {
    provider: 'discord',
    providerUserId: input.primaryDiscordUserId,
  });

  await t.mutation(api.bindings.activateBinding, {
    apiSecret: API_SECRET,
    authUserId: input.authUserId,
    subjectId,
    externalAccountId,
    bindingType: 'verification',
  });

  return subjectId;
}

describe('api to Convex boundary contract realtests', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    process.env.INTERNAL_SERVICE_AUTH_SECRET = INTERNAL_SERVICE_AUTH_SECRET;
  });

  afterEach(() => {
    restoreEnv();
  });

  describe('manual license contracts', () => {
    it('pins create arg names and return shape', async () => {
      const t = makeTestConvex();
      const tWithoutInjectedActor = makeTestConvex({ injectActor: false });
      const actor = await createDelegatedActor();
      const authUserId = 'auth-manual-contract-create';
      const productId = 'product-manual-contract-create';
      const licenseKeyHash = 'a'.repeat(64);
      const expiresAt = Date.now() + 60_000;

      const result = await t.mutation(api.manualLicenses.create, {
        apiSecret: API_SECRET,
        authUserId,
        licenseKeyHash,
        productId,
        maxUses: 3,
        expiresAt,
      });

      expect(Object.keys(result)).toEqual(['licenseId']);
      expect(result.licenseId).toBeTruthy();

      const validation = await t.query(api.manualLicenses.validateByHash, {
        apiSecret: API_SECRET,
        authUserId,
        licenseKeyHash,
        productId,
      });

      expect(validation).toEqual({
        valid: true,
        licenseId: result.licenseId,
        status: 'active',
        currentUses: 0,
        maxUses: 3,
        expiresAt,
      });

      await expect(
        tWithoutInjectedActor.mutation(api.manualLicenses.create, {
          apiSecret: API_SECRET,
          authUserId,
          licenseKeyHash: 'b'.repeat(64),
          productId,
        } as never)
      ).rejects.toThrow(/actor/);

      await expect(
        tWithoutInjectedActor.mutation(api.manualLicenses.create, {
          actor,
          authUserId,
          licenseKeyHash: 'c'.repeat(64),
          productId,
        } as never)
      ).rejects.toThrow(/apiSecret/);

      await expect(
        t.mutation(api.manualLicenses.create, {
          apiSecret: API_SECRET,
          authUserId,
          hashedKey: 'd'.repeat(64),
          productId,
        } as never)
      ).rejects.toThrow(/licenseKeyHash/);

      await expect(
        t.mutation(api.manualLicenses.create, {
          apiSecret: API_SECRET,
          authUserId,
          licenseKeyHash: 'e'.repeat(64),
        } as never)
      ).rejects.toThrow(/productId/);
    });

    it('pins bulkCreate nested arg names and result shape', async () => {
      const t = makeTestConvex();
      const authUserId = 'auth-manual-contract-bulk';

      const result = await t.mutation(api.manualLicenses.bulkCreate, {
        apiSecret: API_SECRET,
        authUserId,
        licenses: [
          {
            licenseKeyHash: '1'.repeat(64),
            productId: 'product-manual-contract-bulk-1',
          },
          {
            licenseKeyHash: '2'.repeat(64),
            productId: 'product-manual-contract-bulk-2',
            maxUses: 2,
          },
        ],
      });

      expect(Object.keys(result).sort()).toEqual(['created', 'licenseIds']);
      expect(result.created).toBe(2);
      expect(result.licenseIds).toHaveLength(2);
      expect(result.licenseIds.every((licenseId) => typeof licenseId === 'string')).toBe(true);

      await expect(
        t.mutation(api.manualLicenses.bulkCreate, {
          apiSecret: API_SECRET,
          authUserId,
          licenses: [
            {
              hashedKey: '3'.repeat(64),
              productId: 'product-manual-contract-bulk-3',
            },
          ],
        } as never)
      ).rejects.toThrow(/licenseKeyHash/);

      await expect(
        t.mutation(api.manualLicenses.bulkCreate, {
          apiSecret: API_SECRET,
          licenses: [
            {
              licenseKeyHash: '4'.repeat(64),
              productId: 'product-manual-contract-bulk-4',
            },
          ],
        } as never)
      ).rejects.toThrow(/authUserId/);
    });

    it('pins validateByHash canonical and deprecated hash fields', async () => {
      const t = makeTestConvex();
      const authUserId = 'auth-manual-contract-validate';
      const productId = 'product-manual-contract-validate';
      const licenseKeyHash = '5'.repeat(64);

      const created = await t.mutation(api.manualLicenses.create, {
        apiSecret: API_SECRET,
        authUserId,
        licenseKeyHash,
        productId,
      });

      // licenseKeyHash is canonical. hashedKey is deprecated and accepted only by validateByHash.
      const canonical = await t.query(api.manualLicenses.validateByHash, {
        apiSecret: API_SECRET,
        authUserId,
        licenseKeyHash,
        productId,
      });
      const deprecated = await t.query(api.manualLicenses.validateByHash, {
        apiSecret: API_SECRET,
        authUserId,
        hashedKey: licenseKeyHash,
        productId,
      });

      expect(canonical).toMatchObject({
        valid: true,
        licenseId: created.licenseId,
        status: 'active',
        currentUses: 0,
      });
      expect(deprecated).toMatchObject({
        valid: true,
        licenseId: created.licenseId,
        status: 'active',
        currentUses: 0,
      });

      await expect(
        t.query(api.manualLicenses.validateByHash, {
          apiSecret: API_SECRET,
          licenseKeyHash,
          productId,
        } as never)
      ).rejects.toThrow(/authUserId/);
    });
  });

  describe('subject and entitlement read contracts', () => {
    it('pins resolveSubjectForPublicApi wrapper shape and required arg names', async () => {
      const t = makeTestConvex();
      const tWithoutInjectedActor = makeTestConvex({ injectActor: false });
      const authUserId = 'auth-subject-contract';
      const buyerAuthUserId = 'auth-subject-contract-buyer';
      const subjectId = await seedCreatorScopedSubject(t, {
        authUserId,
        buyerAuthUserId,
        primaryDiscordUserId: 'discord-subject-contract',
      });

      const result = await t.query(api.subjects.resolveSubjectForPublicApi, {
        apiSecret: API_SECRET,
        authUserId,
        selector: { subjectId },
      });

      expect(Object.keys(result).sort()).toEqual(['found', 'subject']);
      expect(result.found).toBe(true);
      expect(result.subject).toMatchObject({
        _id: subjectId,
        authUserId: buyerAuthUserId,
        primaryDiscordUserId: 'discord-subject-contract',
        status: 'active',
      });

      await expect(
        tWithoutInjectedActor.query(api.subjects.resolveSubjectForPublicApi, {
          apiSecret: API_SECRET,
          authUserId,
          selector: { subjectId },
        } as never)
      ).rejects.toThrow(/actor/);

      await expect(
        t.query(api.subjects.resolveSubjectForPublicApi, {
          apiSecret: API_SECRET,
          selector: { subjectId },
        } as never)
      ).rejects.toThrow(/authUserId/);

      await expect(
        t.query(api.subjects.resolveSubjectForPublicApi, {
          apiSecret: API_SECRET,
          authUserId,
          selector: { id: subjectId },
        } as never)
      ).rejects.toThrow(/Expected one of object/);
    });

    it('pins getEntitlementsBySubject args and normalized result shape', async () => {
      const t = makeTestConvex();
      const tWithoutInjectedActor = makeTestConvex({ injectActor: false });
      const authUserId = 'auth-entitlement-contract';
      const subjectId = await seedCreatorScopedSubject(t, {
        authUserId,
        buyerAuthUserId: 'auth-entitlement-contract-buyer',
        primaryDiscordUserId: 'discord-entitlement-contract',
      });
      const entitlementId = await seedEntitlement(t, subjectId, {
        authUserId,
        productId: 'product-entitlement-contract',
        sourceProvider: 'gumroad',
        sourceReference: 'source-entitlement-contract',
        status: 'active',
      });

      const result = await t.query(api.entitlements.getEntitlementsBySubject, {
        apiSecret: API_SECRET,
        authUserId,
        subjectId,
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        _id: entitlementId,
        subjectId,
        productId: 'product-entitlement-contract',
        sourceProvider: 'gumroad',
        status: 'active',
      });
      expect('authUserId' in result[0]).toBe(false);
      expect('sourceReference' in result[0]).toBe(false);
      expect('providerCustomerId' in result[0]).toBe(false);
      expect('policySnapshotVersion' in result[0]).toBe(false);

      await expect(
        tWithoutInjectedActor.query(api.entitlements.getEntitlementsBySubject, {
          apiSecret: API_SECRET,
          authUserId,
          subjectId,
        } as never)
      ).rejects.toThrow(/actor/);

      await expect(
        t.query(api.entitlements.getEntitlementsBySubject, {
          apiSecret: API_SECRET,
          authUserId,
        } as never)
      ).rejects.toThrow(/subjectId/);
    });
  });

  describe('webhook contract shapes and delivery statuses', () => {
    it('pins webhook subscription create return shape and required args', async () => {
      const t = makeTestConvex();
      const authUserId = 'auth-webhook-contract-create';

      const subscriptionId = await t.mutation(api.webhookSubscriptions.create, {
        apiSecret: API_SECRET,
        authUserId,
        url: 'https://example.com/webhooks/yucp',
        events: ['ping'],
        signingSecretEnc: 'encrypted-secret',
        signingSecretPrefix: 'whsec_test',
      });

      expect(typeof subscriptionId).toBe('string');

      const subscription = await t.query(api.webhookSubscriptions.getById, {
        apiSecret: API_SECRET,
        authUserId,
        subscriptionId,
      });

      expect(subscription).toMatchObject({
        authUserId,
        url: 'https://example.com/webhooks/yucp',
        enabled: true,
        signingSecretPrefix: 'whsec_test',
        status: 'active',
      });
      expect(typeof subscription._id).toBe('string');
      expect('events' in subscription).toBe(true);
      expect('signingSecretEnc' in subscription).toBe(false);

      await expect(
        t.mutation(api.webhookSubscriptions.create, {
          authUserId,
          url: 'https://example.com/webhooks/yucp',
          events: ['ping'],
          signingSecretEnc: 'encrypted-secret',
          signingSecretPrefix: 'whsec_test',
        } as never)
      ).rejects.toThrow(/apiSecret/);

      await expect(
        t.mutation(api.webhookSubscriptions.create, {
          apiSecret: API_SECRET,
          authUserId,
          url: 'https://example.com/webhooks/yucp',
          events: ['ping'],
          signingSecretPrefix: 'whsec_test',
        } as never)
      ).rejects.toThrow(/signingSecretEnc/);
    });

    it('pins webhook delivery list shape and lifecycle status values', async () => {
      const t = makeTestConvex();
      const authUserId = 'auth-webhook-contract-delivery';
      const subscriptionId = await t.mutation(api.webhookSubscriptions.create, {
        apiSecret: API_SECRET,
        authUserId,
        url: 'https://example.com/webhooks/yucp',
        events: ['ping'],
        signingSecretEnc: 'encrypted-secret',
        signingSecretPrefix: 'whsec_test',
      });

      const firstEventId = await t.run(async (ctx) =>
        ctx.runMutation(internal.creatorEvents.emitEvent, {
          apiSecret: API_SECRET,
          authUserId,
          eventType: 'ping',
          resourceType: 'ping',
          resourceId: 'first',
          data: { ok: true },
        })
      );
      const fanoutCount = await t.run(async (ctx) =>
        ctx.runMutation(internal.creatorEvents.fanOutToSubscriptions, {
          eventId: firstEventId,
          authUserId,
          eventType: 'ping',
        })
      );

      expect(fanoutCount).toBe(1);

      const pendingForWorker = await t.run(async (ctx) =>
        ctx.runQuery(internal.webhookDeliveries.listPending, {})
      );

      expect(pendingForWorker).toHaveLength(1);
      expect(pendingForWorker[0]).toMatchObject({
        authUserId,
        subscriptionId,
        eventId: firstEventId,
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 5,
      });

      const pendingList = await t.query(api.webhookDeliveries.listBySubscription, {
        apiSecret: API_SECRET,
        authUserId,
        subscriptionId,
        status: 'pending',
        limit: 10,
      });

      expect(Object.keys(pendingList).sort()).toEqual(['deliveries', 'hasMore']);
      expect(pendingList).toMatchObject({
        hasMore: false,
      });
      expect(pendingList.nextCursor).toBeUndefined();
      expect(pendingList.deliveries).toHaveLength(1);

      const deliveryId = pendingList.deliveries[0]._id as Id<'webhook_deliveries'>;
      await t.run(async (ctx) =>
        ctx.runMutation(internal.webhookDeliveries.markInProgress, { deliveryId })
      );

      const inProgressList = await t.query(api.webhookDeliveries.listBySubscription, {
        apiSecret: API_SECRET,
        authUserId,
        subscriptionId,
        status: 'in_progress',
      });

      expect(inProgressList.deliveries).toHaveLength(1);
      expect(inProgressList.deliveries[0].status).toBe('in_progress');

      await t.run(async (ctx) =>
        ctx.runMutation(internal.webhookDeliveries.markFailed, {
          deliveryId,
          lastHttpStatus: 503,
          lastError: 'temporary failure',
        })
      );

      const failedList = await t.query(api.webhookDeliveries.listBySubscription, {
        apiSecret: API_SECRET,
        authUserId,
        subscriptionId,
        status: 'failed',
      });

      expect(failedList.deliveries).toHaveLength(1);
      expect(failedList.deliveries[0]).toMatchObject({
        status: 'failed',
        attemptCount: 1,
        lastHttpStatus: 503,
        lastError: 'temporary failure',
      });

      for (let attempt = 0; attempt < 4; attempt++) {
        await t.run(async (ctx) =>
          ctx.runMutation(internal.webhookDeliveries.markFailed, {
            deliveryId,
            lastHttpStatus: 500,
            lastError: 'permanent failure',
          })
        );
      }

      const deadLetterList = await t.query(api.webhookDeliveries.listBySubscription, {
        apiSecret: API_SECRET,
        authUserId,
        subscriptionId,
        status: 'dead_letter',
      });

      expect(deadLetterList.deliveries).toHaveLength(1);
      expect(deadLetterList.deliveries[0]).toMatchObject({
        status: 'dead_letter',
        attemptCount: 5,
        lastHttpStatus: 500,
        lastError: 'permanent failure',
      });

      const secondEventId = await t.run(async (ctx) =>
        ctx.runMutation(internal.creatorEvents.emitEvent, {
          apiSecret: API_SECRET,
          authUserId,
          eventType: 'ping',
          resourceType: 'ping',
          resourceId: 'second',
          data: { ok: true },
        })
      );
      await t.run(async (ctx) =>
        ctx.runMutation(internal.creatorEvents.fanOutToSubscriptions, {
          eventId: secondEventId,
          authUserId,
          eventType: 'ping',
        })
      );

      const secondPendingList = await t.query(api.webhookDeliveries.listBySubscription, {
        apiSecret: API_SECRET,
        authUserId,
        subscriptionId,
        status: 'pending',
      });
      const secondDeliveryId = secondPendingList.deliveries[0]._id as Id<'webhook_deliveries'>;

      await t.run(async (ctx) =>
        ctx.runMutation(internal.webhookDeliveries.markInProgress, {
          deliveryId: secondDeliveryId,
        })
      );
      await t.run(async (ctx) =>
        ctx.runMutation(internal.webhookDeliveries.markDelivered, {
          deliveryId: secondDeliveryId,
          lastHttpStatus: 200,
          requestDurationMs: 123,
        })
      );

      const deliveredList = await t.query(api.webhookDeliveries.listBySubscription, {
        apiSecret: API_SECRET,
        authUserId,
        subscriptionId,
        status: 'delivered',
      });

      expect(deliveredList.deliveries).toHaveLength(1);
      expect(deliveredList.deliveries[0]).toMatchObject({
        status: 'delivered',
        lastHttpStatus: 200,
        requestDurationMs: 123,
      });

      await expect(
        t.query(api.webhookDeliveries.listBySubscription, {
          apiSecret: API_SECRET,
          authUserId,
          subscriptionId,
          status: 'queued',
        } as never)
      ).rejects.toThrow(/Expected one of literal/);
    });
  });
});
