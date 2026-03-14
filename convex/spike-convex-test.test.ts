import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';

describe('spike: convex-test works', () => {
  it('can insert and query a subjects record', async () => {
    const t = convexTest(schema, import.meta.glob('./**/*.ts'));
    const id = await t.run(async (ctx) => {
      return await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-spike-123',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    expect(id).toBeTruthy();

    const record = await t.run(async (ctx) => ctx.db.get(id));
    expect(record?.primaryDiscordUserId).toBe('discord-spike-123');
    expect(record?.status).toBe('active');
  });
});
