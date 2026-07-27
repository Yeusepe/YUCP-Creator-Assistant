import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

describe('Better Auth verification reservations', () => {
  it('allows exactly one concurrent reservation for one logical identifier', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const input = {
      reservationId: 'reservation-id',
      identifier: 'dpop-proof:logical-key',
      value: 'logical-key',
      expiresAt: now + 300_000,
      createdAt: now,
      updatedAt: now,
    };

    const results = await Promise.all([
      t.mutation(internal.betterAuthReservations.reserve, input),
      t.mutation(internal.betterAuthReservations.reserve, input),
    ]);

    expect(results.sort()).toEqual([false, true]);
    await expect(
      t.query(internal.betterAuthReservations.find, {
        reservationId: input.reservationId,
      })
    ).resolves.toMatchObject(input);
  });

  it('replaces an expired reservation and removes expired rows in bounded batches', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert('better_auth_reservations', {
        reservationId: 'expired-reservation',
        identifier: 'expired-identifier',
        value: 'expired-value',
        expiresAt: now - 1,
        createdAt: now - 301_000,
        updatedAt: now - 301_000,
      });
      await ctx.db.insert('better_auth_reservations', {
        reservationId: 'other-expired-reservation',
        identifier: 'other-expired-identifier',
        value: 'other-expired-value',
        expiresAt: now - 1,
        createdAt: now - 301_000,
        updatedAt: now - 301_000,
      });
    });

    await expect(
      t.mutation(internal.betterAuthReservations.reserve, {
        reservationId: 'expired-reservation',
        identifier: 'replacement-identifier',
        value: 'replacement-value',
        expiresAt: now + 300_000,
        createdAt: now,
        updatedAt: now,
      })
    ).resolves.toBe(true);
    await expect(t.mutation(internal.betterAuthReservations.cleanupExpired, {})).resolves.toBe(1);
    await expect(
      t.query(internal.betterAuthReservations.find, {
        reservationId: 'expired-reservation',
      })
    ).resolves.toMatchObject({
      identifier: 'replacement-identifier',
      value: 'replacement-value',
    });
  });
});
