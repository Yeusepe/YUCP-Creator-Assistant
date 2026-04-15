import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex } from './testHelpers';
import { createApiActorBinding } from '@yucp/shared/apiActor';

describe('manual license bounds', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
    process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';
  });

  it('rejects bulkCreate requests above the documented 100-license limit', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const actor = await createApiActorBinding(
      {
        version: 1,
        kind: 'auth_user',
        authUserId: 'auth-manual-bounds',
        source: 'session',
        scopes: [],
        issuedAt: now,
        expiresAt: now + 60_000,
      },
      process.env.INTERNAL_SERVICE_AUTH_SECRET as string
    );

    await expect(
      t.mutation(api.manualLicenses.bulkCreate, {
        apiSecret: 'test-secret',
        actor,
        authUserId: 'auth-manual-bounds',
        licenses: Array.from({ length: 101 }, (_, index) => ({
          licenseKeyHash: `${index}`.padStart(64, '0'),
          productId: `product-${index}`,
        })),
      })
    ).rejects.toThrow('Maximum of 100 licenses per bulk request');
  });
});
