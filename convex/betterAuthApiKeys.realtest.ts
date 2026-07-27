import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import betterAuthSchema from './betterAuth/schema';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'test-secret';
const API_KEY_OWNERSHIP_TEST_TIMEOUT_MS = 30_000;

type BetterAuthComponentCtx = {
  db: {
    insert: (table: string, value: Record<string, unknown>) => Promise<string>;
    patch: (id: string, value: Record<string, unknown>) => Promise<void>;
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

  it('creates managed public API keys with the Better Auth owner stored in referenceId', async () => {
    const t = makeTestConvex() as ComponentAwareTestConvex;
    t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
    const ownerAuthUserId = await seedBetterAuthUser(t);

    const result = await t.mutation(api.betterAuthApiKeys.createApiKey, {
      apiSecret: API_SECRET,
      authUserId: ownerAuthUserId,
      name: 'Production public API key',
      scopes: ['cert:issue'],
      expiresIn: null,
    });

    expect(result.key).toMatch(/^ypsk_/);
    expect(result.apiKey.referenceId).toBe(ownerAuthUserId);
    expect(result.apiKey.metadata).toEqual({
      kind: 'public-api',
      authUserId: ownerAuthUserId,
    });

    const storedKeys = await t.runInComponent('betterAuth', async (ctx) => {
      return await ctx.db.query('apikey').collect();
    });

    expect(storedKeys).toHaveLength(1);
    expect(storedKeys[0]).not.toHaveProperty('userId');
    expect(storedKeys[0]?.referenceId).toBe(ownerAuthUserId);

    const verified = await t.mutation(api.betterAuthApiKeys.verifyApiKey, {
      apiSecret: API_SECRET,
      key: result.key,
      scopes: ['cert:issue'],
    });

    expect(verified.valid).toBe(true);
    expect(verified.key?.referenceId).toBe(ownerAuthUserId);
    expect(verified.key?.metadata).toEqual({
      kind: 'public-api',
      authUserId: ownerAuthUserId,
    });
  }, API_KEY_OWNERSHIP_TEST_TIMEOUT_MS);

  it('stores the public tenant authUserId as the reference owner', async () => {
    const t = makeTestConvex() as ComponentAwareTestConvex;
    t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
    const tenantAuthUserId = await seedBetterAuthUser(t, {
      name: 'Public Tenant',
      email: 'public-tenant@example.com',
    });

    const result = await t.mutation(api.betterAuthApiKeys.createApiKey, {
      apiSecret: API_SECRET,
      authUserId: tenantAuthUserId,
      name: 'Tenant public API key',
      scopes: ['verification:read'],
      expiresIn: null,
    });

    expect(result.apiKey.referenceId).toBe(tenantAuthUserId);
    expect(result.apiKey.metadata).toEqual({
      kind: 'public-api',
      authUserId: tenantAuthUserId,
    });

    const storedKeys = await t.runInComponent('betterAuth', async (ctx) => {
      return await ctx.db.query('apikey').collect();
    });

    expect(storedKeys).toHaveLength(1);
    expect(storedKeys[0]).not.toHaveProperty('userId');
    expect(storedKeys[0]?.referenceId).toBe(tenantAuthUserId);

    const verified = await t.mutation(api.betterAuthApiKeys.verifyApiKey, {
      apiSecret: API_SECRET,
      key: result.key,
      scopes: ['verification:read'],
    });

    expect(verified.valid).toBe(true);
    expect(verified.key?.referenceId).toBe(tenantAuthUserId);
    expect(verified.key?.metadata).toEqual({
      kind: 'public-api',
      authUserId: tenantAuthUserId,
    });
  }, API_KEY_OWNERSHIP_TEST_TIMEOUT_MS);

  it('rejects a managed public API key when metadata names a different owner', async () => {
    const t = makeTestConvex() as ComponentAwareTestConvex;
    t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
    const attackerAuthUserId = await seedBetterAuthUser(t, {
      name: 'Attacker',
      email: 'attacker@example.com',
    });
    const victimAuthUserId = await seedBetterAuthUser(t, {
      name: 'Victim',
      email: 'victim@example.com',
    });

    const created = await t.mutation(api.betterAuthApiKeys.createApiKey, {
      apiSecret: API_SECRET,
      authUserId: attackerAuthUserId,
      name: 'Forged public API key',
      scopes: ['verification:read'],
      expiresIn: null,
    });

    await t.runInComponent('betterAuth', async (ctx) => {
      const [storedKey] = await ctx.db.query('apikey').collect();
      if (!storedKey || typeof storedKey._id !== 'string') {
        throw new Error('Expected the managed public API key to be stored');
      }

      await ctx.db.patch(storedKey._id, {
        metadata: JSON.stringify({
          kind: 'public-api',
          authUserId: victimAuthUserId,
        }),
      });
    });

    const verified = await t.mutation(api.betterAuthApiKeys.verifyApiKey, {
      apiSecret: API_SECRET,
      key: created.key,
      scopes: ['verification:read'],
    });

    expect(verified.valid).toBe(false);
    expect(verified.key).toBeNull();
  }, API_KEY_OWNERSHIP_TEST_TIMEOUT_MS);

  it('rejects managed public API keys whose reference owner differs from metadata', async () => {
    const t = makeTestConvex() as ComponentAwareTestConvex;
    t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
    const sessionOwnerUserId = await seedBetterAuthUser(t, {
      name: 'Different Reference Owner',
      email: 'different-reference-owner@example.com',
    });
    const tenantAuthUserId = await seedBetterAuthUser(t, {
      name: 'Public Tenant',
      email: 'public-tenant-reference@example.com',
    });

    const created = await t.mutation(api.betterAuthApiKeys.createApiKey, {
      apiSecret: API_SECRET,
      authUserId: tenantAuthUserId,
      name: 'Tenant public API key',
      scopes: ['verification:read'],
      expiresIn: null,
    });

    const mismatchedStoredKey = await t.runInComponent('betterAuth', async (ctx) => {
      const [storedKey] = await ctx.db.query('apikey').collect();
      if (!storedKey || typeof storedKey._id !== 'string') {
        throw new Error('Expected the managed public API key to be stored');
      }

      await ctx.db.patch(storedKey._id, { referenceId: sessionOwnerUserId });
      const [mismatchedKey] = await ctx.db.query('apikey').collect();
      return mismatchedKey;
    });

    expect(mismatchedStoredKey).toMatchObject({
      referenceId: sessionOwnerUserId,
    });
    expect(JSON.parse(String(mismatchedStoredKey?.metadata))).toEqual({
      kind: 'public-api',
      authUserId: tenantAuthUserId,
    });

    const verified = await t.mutation(api.betterAuthApiKeys.verifyApiKey, {
      apiSecret: API_SECRET,
      key: created.key,
      scopes: ['verification:read'],
    });

    expect(verified.valid).toBe(false);
    expect(verified.key).toBeNull();
  }, API_KEY_OWNERSHIP_TEST_TIMEOUT_MS);
});
