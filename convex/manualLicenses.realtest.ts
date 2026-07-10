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

  it('returns a filtered cursor page without exposing license hashes', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-manual-pagination';
    const now = Date.now();
    const actor = await createApiActorBinding(
      {
        version: 1,
        kind: 'auth_user',
        authUserId,
        source: 'session',
        scopes: [],
        issuedAt: now,
        expiresAt: now + 60_000,
      },
      process.env.INTERNAL_SERVICE_AUTH_SECRET as string
    );

    const ids = await t.run(async (ctx) =>
      Promise.all(
        ['license-a', 'license-b', 'license-c'].map(async (licenseKeyHash, index) =>
          await ctx.db.insert('manual_licenses', {
            authUserId,
            licenseKeyHash,
            productId: 'product-pagination',
            currentUses: 0,
            status: 'active',
            createdAt: now + index,
            updatedAt: now + index,
          })
        )
      )
    );

    const firstPage = await t.query(api.manualLicenses.listByTenant, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      productId: 'product-pagination',
      limit: 2,
    });

    expect(firstPage).toMatchObject({ hasMore: true });
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.data.every((license) => !('licenseKeyHash' in license))).toBe(true);
    const firstCursor = firstPage.nextCursor;
    if (!firstCursor) {
      throw new Error('Expected the first manual-license page to include a cursor');
    }

    const secondPage = await t.query(api.manualLicenses.listByTenant, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      productId: 'product-pagination',
      cursor: firstCursor,
      limit: 2,
    });

    expect(secondPage).toMatchObject({ hasMore: false, nextCursor: null });
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.data[0]?._id).toBe(ids[2]);
  });
});
