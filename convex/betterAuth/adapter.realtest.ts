import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

describe('Better Auth Convex adapter atomic updates', () => {
  it('treats an omitted optional field as null for Better Auth equality predicates', async () => {
    const t = convexTest(schema, import.meta.glob('./**/*.ts'));
    const refreshTokenId = await t.run(async (ctx) => {
      return await ctx.db.insert('oauthRefreshToken', {
        token: 'refresh-token-hash',
        clientId: 'native-client',
        userId: 'user-id',
        scopes: ['offline_access'],
      });
    });
    const rotatedAt = Date.now();

    const rotated = await t.mutation(internal.adapter.incrementOne, {
      input: {
        model: 'oauthRefreshToken',
        where: [
          { field: '_id', operator: 'eq', value: refreshTokenId },
          { field: 'revoked', operator: 'eq', value: null },
        ],
        increment: {},
        set: {
          revoked: rotatedAt,
          rotatedAt,
        },
      },
    });

    expect(rotated?._id).toBe(refreshTokenId);
    expect(rotated?.revoked).toBe(rotatedAt);
    expect(rotated?.rotatedAt).toBe(rotatedAt);

    const replayedRotation = await t.mutation(internal.adapter.incrementOne, {
      input: {
        model: 'oauthRefreshToken',
        where: [
          { field: '_id', operator: 'eq', value: refreshTokenId },
          { field: 'revoked', operator: 'eq', value: null },
        ],
        increment: {},
        set: {
          revoked: rotatedAt + 1,
          rotatedAt: rotatedAt + 1,
        },
      },
    });

    expect(replayedRotation).toBeNull();
  });
});
