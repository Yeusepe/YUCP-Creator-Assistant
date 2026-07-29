import { convexTest } from 'convex-test';
import type { FunctionReference } from 'convex/server';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';

type IncrementRefreshTokenArgs = {
  input: {
    model: 'oauthRefreshToken';
    where: Array<{
      field: '_id' | 'revoked';
      operator: 'eq';
      value: Id<'oauthRefreshToken'> | null;
    }>;
    increment: Record<string, number>;
    set: Record<string, unknown>;
  };
};

const incrementRefreshToken = (
  internal as unknown as {
    adapter: {
      incrementOne: FunctionReference<
        'mutation',
        'internal',
        IncrementRefreshTokenArgs,
        Doc<'oauthRefreshToken'> | null
      >;
    };
  }
).adapter.incrementOne;

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

    const rotated = await t.mutation(incrementRefreshToken, {
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

    const replayedRotation = await t.mutation(incrementRefreshToken, {
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
