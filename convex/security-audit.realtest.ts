import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'test-secret';

describe('security audit webhook queue behavior', () => {
  it('does not starve authenticated webhook events behind unauthenticated pending events', async () => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    const t = makeTestConvex();

    for (let index = 0; index < 25; index += 1) {
      await t.mutation(api.webhookIngestion.insertWebhookEvent, {
        apiSecret: API_SECRET,
        authUserId: 'auth-invalid',
        provider: 'gumroad',
        providerEventId: `invalid-${index}`,
        eventType: 'sale',
        rawPayload: { sale_id: `invalid-${index}` },
        signatureValid: false,
      });
    }

    const valid = await t.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: API_SECRET,
      authUserId: 'auth-valid',
      provider: 'gumroad',
      providerEventId: 'valid-route-token',
      eventType: 'sale',
      rawPayload: { sale_id: 'valid-route-token', email: 'buyer@example.com' },
      signatureValid: false,
      verificationMethod: 'route-token',
    });

    const pending = await t.run(async (ctx) =>
      ctx.runQuery(api.webhookIngestion.getPendingWebhookEvents, {
        apiSecret: API_SECRET,
        limit: 10,
      })
    );

    expect(pending.map((event) => event._id)).toContain(valid.eventId);
  });
});
