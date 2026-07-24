import { beforeEach, describe, expect, it } from 'vitest';
import { components, internal } from './_generated/api';
import betterAuthSchema from './betterAuth/schema';
import { makeTestConvex } from './testHelpers';

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

function createTestConvex(): ComponentAwareTestConvex {
  const t = makeTestConvex() as ComponentAwareTestConvex;
  t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
  return t;
}

describe('Better Auth 1.7 persisted identity migration', () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret';
  });

  it('backfills and cleans OAuth accounts and API keys without replacing records', async () => {
    const t = createTestConvex();
    const seeded = await t.runInComponent('betterAuth', async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert('user', {
        name: 'Migration User',
        email: 'migration@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      const accountId = await ctx.db.insert('account', {
        accountId: 'discord-user-123',
        providerId: 'discord',
        userId,
        accessToken: 'preserve-access-token',
        refreshToken: 'preserve-refresh-token',
        createdAt: now,
        updatedAt: now,
      });
      const apiKeyId = await ctx.db.insert('apikey', {
        name: 'Existing API key',
        key: 'preserve-key-hash',
        userId,
        createdAt: now,
        updatedAt: now,
      });
      const sessionId = await ctx.db.insert('session', {
        expiresAt: now + 60_000,
        token: 'preserve-session-token',
        createdAt: now,
        updatedAt: now,
        userId,
      });
      const passkeyId = await ctx.db.insert('passkey', {
        name: 'Preserve passkey',
        publicKey: 'preserve-passkey-public-key',
        userId,
        credentialID: 'preserve-credential-id',
        counter: 1,
        deviceType: 'singleDevice',
        backedUp: false,
        createdAt: now,
      });
      return { userId, accountId, apiKeyId, sessionId, passkeyId };
    });

    const beforeAccounts = await t.query(internal.betterAuthV17Migration.auditPage, {
      table: 'account',
      cursor: null,
      limit: 50,
    });
    const legacyAccountRead = await t.query(components.betterAuth.adapter.findOne, {
      model: 'account',
      where: [
        { field: 'issuer', operator: 'eq', value: 'local:oauth:discord' },
        { field: 'providerAccountId', operator: 'eq', value: 'discord-user-123' },
      ],
    });
    const mismatchedLegacyAccountRead = await t.query(components.betterAuth.adapter.findOne, {
      model: 'account',
      where: [
        { field: 'issuer', operator: 'eq', value: 'local:oauth:discord' },
        { field: 'providerAccountId', operator: 'eq', value: 'discord-user-123' },
        { field: 'userId', operator: 'eq', value: 'different-user' },
      ],
    });
    const legacyAccountUpdate = await t.mutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'account',
        update: { scope: 'identify' },
        where: [
          { field: 'issuer', operator: 'eq', value: 'local:oauth:discord' },
          { field: 'providerAccountId', operator: 'eq', value: 'discord-user-123' },
        ],
      },
    });
    const legacyAccountList = await t.query(components.betterAuth.adapter.findMany, {
      model: 'account',
      where: [{ field: 'userId', operator: 'eq', value: seeded.userId }],
      paginationOpts: { cursor: null, numItems: 50 },
    });
    const beforeApiKeys = await t.query(internal.betterAuthV17Migration.auditPage, {
      table: 'apikey',
      cursor: null,
      limit: 50,
    });

    expect(beforeAccounts).toMatchObject({
      scanned: 1,
      current: 0,
      pendingBackfill: 1,
      pendingCleanup: 0,
      blockers: [],
      isDone: true,
    });
    expect(legacyAccountRead).toMatchObject({
      _id: seeded.accountId,
      issuer: 'local:oauth:discord',
      providerAccountId: 'discord-user-123',
      providerId: 'discord',
      userId: seeded.userId,
    });
    expect(mismatchedLegacyAccountRead).toBeNull();
    expect(legacyAccountUpdate).toMatchObject({
      _id: seeded.accountId,
      issuer: 'local:oauth:discord',
      providerAccountId: 'discord-user-123',
      scope: 'identify',
    });
    expect(legacyAccountList.page).toEqual([
      expect.objectContaining({
        _id: seeded.accountId,
        issuer: 'local:oauth:discord',
        providerAccountId: 'discord-user-123',
      }),
    ]);
    expect(beforeApiKeys).toMatchObject({
      scanned: 1,
      current: 0,
      pendingBackfill: 1,
      pendingCleanup: 0,
      blockers: [],
      isDone: true,
    });

    const accountBackfill = await t.mutation(internal.betterAuthV17Migration.migratePage, {
      table: 'account',
      phase: 'backfill',
      cursor: null,
      limit: 50,
    });
    const apiKeyBackfill = await t.mutation(internal.betterAuthV17Migration.migratePage, {
      table: 'apikey',
      phase: 'backfill',
      cursor: null,
      limit: 50,
    });

    expect(accountBackfill).toMatchObject({ scanned: 1, migrated: 1, blockers: [] });
    expect(apiKeyBackfill).toMatchObject({ scanned: 1, migrated: 1, blockers: [] });

    const afterBackfill = await t.runInComponent('betterAuth', async (ctx) => ({
      accounts: await ctx.db.query('account').collect(),
      apiKeys: await ctx.db.query('apikey').collect(),
    }));
    expect(afterBackfill.accounts).toHaveLength(1);
    expect(afterBackfill.accounts[0]).toMatchObject({
      _id: seeded.accountId,
      accountId: 'discord-user-123',
      issuer: 'local:oauth:discord',
      providerAccountId: 'discord-user-123',
      providerId: 'discord',
      userId: seeded.userId,
      accessToken: 'preserve-access-token',
      refreshToken: 'preserve-refresh-token',
      scope: 'identify',
    });
    expect(afterBackfill.apiKeys).toHaveLength(1);
    expect(afterBackfill.apiKeys[0]).toMatchObject({
      _id: seeded.apiKeyId,
      configId: 'default',
      referenceId: seeded.userId,
      userId: seeded.userId,
      key: 'preserve-key-hash',
    });

    const readyAccounts = await t.query(internal.betterAuthV17Migration.auditPage, {
      table: 'account',
      cursor: null,
      limit: 50,
    });
    const readyApiKeys = await t.query(internal.betterAuthV17Migration.auditPage, {
      table: 'apikey',
      cursor: null,
      limit: 50,
    });
    expect(readyAccounts).toMatchObject({
      current: 0,
      pendingBackfill: 0,
      pendingCleanup: 1,
      blockers: [],
    });
    expect(readyApiKeys).toMatchObject({
      current: 0,
      pendingBackfill: 0,
      pendingCleanup: 1,
      blockers: [],
    });

    await t.mutation(internal.betterAuthV17Migration.migratePage, {
      table: 'account',
      phase: 'cleanup',
      cursor: null,
      limit: 50,
    });
    await t.mutation(internal.betterAuthV17Migration.migratePage, {
      table: 'apikey',
      phase: 'cleanup',
      cursor: null,
      limit: 50,
    });

    const completed = await t.runInComponent('betterAuth', async (ctx) => ({
      accounts: await ctx.db.query('account').collect(),
      apiKeys: await ctx.db.query('apikey').collect(),
      sessions: await ctx.db.query('session').collect(),
      passkeys: await ctx.db.query('passkey').collect(),
    }));
    expect(completed.accounts[0]).not.toHaveProperty('accountId');
    expect(completed.apiKeys[0]).not.toHaveProperty('userId');
    expect(completed.accounts[0]?._id).toBe(seeded.accountId);
    expect(completed.apiKeys[0]?._id).toBe(seeded.apiKeyId);
    expect(completed.sessions).toEqual([
      expect.objectContaining({
        _id: seeded.sessionId,
        token: 'preserve-session-token',
        userId: seeded.userId,
      }),
    ]);
    expect(completed.passkeys).toEqual([
      expect.objectContaining({
        _id: seeded.passkeyId,
        credentialID: 'preserve-credential-id',
        publicKey: 'preserve-passkey-public-key',
        userId: seeded.userId,
      }),
    ]);

    const retry = await t.mutation(internal.betterAuthV17Migration.migratePage, {
      table: 'account',
      phase: 'cleanup',
      cursor: null,
      limit: 50,
    });
    expect(retry).toMatchObject({ scanned: 1, migrated: 0, blockers: [] });
  });

  it('uses the local credential namespace for password accounts', async () => {
    const t = createTestConvex();
    await t.runInComponent('betterAuth', async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert('user', {
        name: 'Password User',
        email: 'password@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('account', {
        accountId: userId,
        providerId: 'credential',
        userId,
        password: 'preserve-password-hash',
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.mutation(internal.betterAuthV17Migration.migratePage, {
      table: 'account',
      phase: 'backfill',
      cursor: null,
      limit: 50,
    });
    expect(result.blockers).toEqual([]);

    const [account] = await t.runInComponent('betterAuth', async (ctx) => {
      return await ctx.db.query('account').collect();
    });
    expect(account).toMatchObject({
      issuer: 'local:credential',
      providerAccountId: account?.userId,
      password: 'preserve-password-hash',
    });
  });

  it('blocks an identity collision before modifying the page', async () => {
    const t = createTestConvex();
    const legacyId = await t.runInComponent('betterAuth', async (ctx) => {
      const now = Date.now();
      const firstUserId = await ctx.db.insert('user', {
        name: 'First User',
        email: 'first@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      const secondUserId = await ctx.db.insert('user', {
        name: 'Second User',
        email: 'second@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      const legacyAccountId = await ctx.db.insert('account', {
        accountId: 'same-discord-user',
        providerId: 'discord',
        userId: firstUserId,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('account', {
        issuer: 'local:oauth:discord',
        providerAccountId: 'same-discord-user',
        providerId: 'discord-secondary',
        userId: secondUserId,
        createdAt: now,
        updatedAt: now,
      });
      return legacyAccountId;
    });

    const audit = await t.query(internal.betterAuthV17Migration.auditPage, {
      table: 'account',
      cursor: null,
      limit: 50,
    });
    expect(audit.blockers).toEqual([
      expect.objectContaining({
        recordId: legacyId,
        code: 'target_identity_collision',
      }),
    ]);

    await expect(
      t.mutation(internal.betterAuthV17Migration.migratePage, {
        table: 'account',
        phase: 'backfill',
        cursor: null,
        limit: 50,
      })
    ).rejects.toThrow('Better Auth 1.7 migration page has blockers');

    const accounts = await t.runInComponent('betterAuth', async (ctx) => {
      return await ctx.db.query('account').collect();
    });
    expect(accounts.find((account) => account._id === legacyId)).not.toHaveProperty('issuer');
  });

  it('blocks conflicting API-key owners before modifying the page', async () => {
    const t = createTestConvex();
    const keyId = await t.runInComponent('betterAuth', async (ctx) => {
      const now = Date.now();
      const firstUserId = await ctx.db.insert('user', {
        name: 'First Owner',
        email: 'first-owner@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      const secondUserId = await ctx.db.insert('user', {
        name: 'Second Owner',
        email: 'second-owner@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert('apikey', {
        key: 'conflicting-key-hash',
        userId: firstUserId,
        referenceId: secondUserId,
        createdAt: now,
        updatedAt: now,
      });
    });

    const audit = await t.query(internal.betterAuthV17Migration.auditPage, {
      table: 'apikey',
      cursor: null,
      limit: 50,
    });
    expect(audit.blockers).toEqual([
      expect.objectContaining({
        recordId: keyId,
        code: 'api_key_owner_conflict',
      }),
    ]);
  });

  it('resumes backfill from component-safe cursors', async () => {
    const t = createTestConvex();
    await t.runInComponent('betterAuth', async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 3; index += 1) {
        const userId = await ctx.db.insert('user', {
          name: `Paged User ${index}`,
          email: `paged-${index}@example.com`,
          emailVerified: true,
          createdAt: now + index,
          updatedAt: now + index,
        });
        await ctx.db.insert('account', {
          accountId: `paged-discord-${index}`,
          providerId: 'discord',
          userId,
          createdAt: now + index,
          updatedAt: now + index,
        });
      }
    });

    let cursor: string | null = null;
    let migrated = 0;
    let pages = 0;
    for (;;) {
      const page: {
        migrated: number;
        isDone: boolean;
        continueCursor: string;
      } = await t.mutation(internal.betterAuthV17Migration.migratePage, {
        table: 'account',
        phase: 'backfill',
        cursor,
        limit: 1,
      });
      migrated += page.migrated;
      pages += 1;
      if (page.isDone) {
        break;
      }
      expect(page.continueCursor).not.toBe(cursor);
      cursor = page.continueCursor;
    }

    expect(pages).toBe(4);
    expect(migrated).toBe(3);
    const accounts = await t.runInComponent('betterAuth', async (ctx) => {
      return await ctx.db.query('account').collect();
    });
    expect(accounts.every((account) => account.issuer === 'local:oauth:discord')).toBe(true);
  });
});
