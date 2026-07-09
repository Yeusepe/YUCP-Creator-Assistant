import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import betterAuthSchema from './betterAuth/schema';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'test-secret';

type BetterAuthComponentCtx = {
  db: {
    insert: (table: string, value: Record<string, unknown>) => Promise<string>;
    query: (table: string) => {
      collect: () => Promise<Array<Record<string, unknown>>>;
    };
  };
};

type ComponentAwareTestConvex = ReturnType<typeof makeTestConvex> & {
  runInComponent: <Output>(
    componentPath: string,
    handler: (ctx: BetterAuthComponentCtx) => Promise<Output>
  ) => Promise<Output>;
};

async function seedBetterAuthUser(
  t: ComponentAwareTestConvex,
  user: { name: string; email: string } = {
    name: 'Public API Owner',
    email: 'public-api-owner@example.com',
  }
): Promise<string> {
  return await t.runInComponent('betterAuth', async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert('user', {
      name: user.name,
      email: user.email,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('betterAuthApiKeys', () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret';
    process.env.CONVEX_API_SECRET = API_SECRET;
    process.env.CONVEX_SITE_URL = 'https://public-api.test.example';
  });

  it('creates managed public API keys with the Better Auth owner stored in userId', async () => {
    const t = makeTestConvex() as ComponentAwareTestConvex;
    t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
    const ownerAuthUserId = await seedBetterAuthUser(t);

    const result = await t.mutation(api.betterAuthApiKeys.createApiKey, {
      apiSecret: API_SECRET,
      userId: ownerAuthUserId,
      authUserId: ownerAuthUserId,
      name: 'Production public API key',
      scopes: ['cert:issue'],
      expiresIn: null,
    });

    expect(result.key).toMatch(/^ypsk_/);
    expect(result.apiKey.userId).toBe(ownerAuthUserId);
    expect(result.apiKey.metadata).toEqual({
      kind: 'public-api',
      authUserId: ownerAuthUserId,
    });

    const storedKeys = await t.runInComponent('betterAuth', async (ctx) => {
      return await ctx.db.query('apikey').collect();
    });

    expect(storedKeys).toHaveLength(1);
    expect(storedKeys[0]?.userId).toBe(ownerAuthUserId);
    expect(storedKeys[0]?.referenceId).toBe(ownerAuthUserId);

    const verified = await t.mutation(api.betterAuthApiKeys.verifyApiKey, {
      apiSecret: API_SECRET,
      key: result.key,
      scopes: ['cert:issue'],
    });

    expect(verified.valid).toBe(true);
    expect(verified.key?.userId).toBe(ownerAuthUserId);
    expect(verified.key?.metadata).toEqual({
      kind: 'public-api',
      authUserId: ownerAuthUserId,
    });
  }, 10_000);

  it('stores the public tenant authUserId when the session owner differs', async () => {
    const t = makeTestConvex() as ComponentAwareTestConvex;
    t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
    const sessionOwnerUserId = await seedBetterAuthUser(t, {
      name: 'Session Owner',
      email: 'session-owner@example.com',
    });
    const tenantAuthUserId = await seedBetterAuthUser(t, {
      name: 'Public Tenant',
      email: 'public-tenant@example.com',
    });

    const result = await t.mutation(api.betterAuthApiKeys.createApiKey, {
      apiSecret: API_SECRET,
      userId: sessionOwnerUserId,
      authUserId: tenantAuthUserId,
      name: 'Tenant public API key',
      scopes: ['verification:read'],
      expiresIn: null,
    });

    expect(result.apiKey.userId).toBe(tenantAuthUserId);
    expect(result.apiKey.metadata).toEqual({
      kind: 'public-api',
      authUserId: tenantAuthUserId,
    });

    const storedKeys = await t.runInComponent('betterAuth', async (ctx) => {
      return await ctx.db.query('apikey').collect();
    });

    expect(storedKeys).toHaveLength(1);
    expect(storedKeys[0]?.userId).toBe(tenantAuthUserId);
    expect(storedKeys[0]?.referenceId).toBe(tenantAuthUserId);

    const verified = await t.mutation(api.betterAuthApiKeys.verifyApiKey, {
      apiSecret: API_SECRET,
      key: result.key,
      scopes: ['verification:read'],
    });

    expect(verified.valid).toBe(true);
    expect(verified.key?.userId).toBe(tenantAuthUserId);
    expect(verified.key?.metadata).toEqual({
      kind: 'public-api',
      authUserId: tenantAuthUserId,
    });
  }, 10_000);
});
