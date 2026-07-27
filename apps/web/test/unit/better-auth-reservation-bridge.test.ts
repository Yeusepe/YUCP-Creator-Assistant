import type { BetterAuthOptions } from 'better-auth';
import { betterAuth } from 'better-auth';
import { describe, expect, it, vi } from 'vitest';
import {
  type BetterAuthReservationPort,
  betterAuthReservationBridge,
} from '../../../../convex/betterAuth/reservationBridge';

describe('Better Auth Convex reservation bridge', () => {
  it('preserves atomic verification reservations without forcing a Convex document ID', async () => {
    const reservations = new Map<
      string,
      {
        createdAt: number;
        expiresAt: number;
        identifier: string;
        reservationId: string;
        updatedAt: number;
        value: string;
      }
    >();
    const port: BetterAuthReservationPort = {
      reserve: vi.fn(async (input) => {
        if (reservations.has(input.reservationId)) {
          return false;
        }
        reservations.set(input.reservationId, input);
        return true;
      }),
      find: vi.fn(async (reservationId) => reservations.get(reservationId) ?? null),
    };
    const unsupportedForcedIdCreate = vi.fn(async () => {
      throw new Error('Convex does not accept caller-supplied document IDs');
    });
    const unsupportedForcedIdFind = vi.fn(async () => {
      throw new Error('The supplied value is not a Convex document ID');
    });
    const baseAdapter = {
      id: 'convex-contract-probe',
      create: unsupportedForcedIdCreate,
      findOne: unsupportedForcedIdFind,
    };
    const options = {
      baseURL: 'http://localhost:3000',
      database: () => baseAdapter,
      plugins: [betterAuthReservationBridge(port)],
      secret: 'test-secret-123456789012345678901234',
    } as unknown as BetterAuthOptions;
    const auth = betterAuth(options);
    const context = await auth.$context;
    const input = {
      expiresAt: new Date(Date.now() + 300_000),
      identifier: 'dpop-proof:contract-key',
      value: 'contract-key',
    };

    await expect(context.internalAdapter.reserveVerificationValue(input)).resolves.toBe(true);
    await expect(context.internalAdapter.reserveVerificationValue(input)).resolves.toBe(false);

    expect(unsupportedForcedIdCreate).not.toHaveBeenCalled();
    expect(unsupportedForcedIdFind).not.toHaveBeenCalled();
    expect(port.reserve).toHaveBeenCalledTimes(2);
    expect(port.find).toHaveBeenCalledTimes(1);
    expect(Array.from(reservations.values())).toEqual([
      expect.objectContaining({
        identifier: input.identifier,
        value: input.value,
      }),
    ]);
  });

  it('delegates normal verification lookups and unrelated forced identifiers', async () => {
    const port: BetterAuthReservationPort = {
      reserve: vi.fn(async () => false),
      find: vi.fn(async () => null),
    };
    const baseCreate = vi.fn(async () => ({ source: 'base-create' }));
    const baseFindOne = vi.fn(async () => ({ source: 'base-find' }));
    const options = {
      baseURL: 'http://localhost:3000',
      database: () => ({
        id: 'convex-delegation-probe',
        create: baseCreate,
        findOne: baseFindOne,
      }),
      plugins: [betterAuthReservationBridge(port)],
      secret: 'test-secret-123456789012345678901234',
    } as unknown as BetterAuthOptions;
    const context = await betterAuth(options).$context;

    await expect(
      context.adapter.create({
        model: 'oauthClient',
        data: {
          id: 'client-owned-id',
        },
        forceAllowId: true,
      })
    ).resolves.toEqual({ source: 'base-create' });
    await expect(
      context.adapter.findOne({
        model: 'verification',
        where: [{ field: 'id', value: 'normal-verification-id' }],
      })
    ).resolves.toEqual({ source: 'base-find' });

    expect(baseCreate).toHaveBeenCalledTimes(1);
    expect(baseFindOne).toHaveBeenCalledTimes(1);
  });
});
