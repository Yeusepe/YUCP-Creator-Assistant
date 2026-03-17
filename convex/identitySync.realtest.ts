/**
 * Integration tests for Identity Sync Module
 *
 * Uses convex-test to run against an in-memory Convex backend.
 * Run with: npx vitest run --config convex/vitest.config.ts convex/identitySync.realtest.ts
 *
 * Security refs from plan.md:
 * - https://docs.convex.dev/testing/convex-test
 * - https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex } from './testHelpers';

async function getIdentityCounts(t: ReturnType<typeof makeTestConvex>) {
  return t.run(async (ctx) => ({
    subjects: (await ctx.db.query('subjects').collect()).length,
    externalAccounts: (await ctx.db.query('external_accounts').collect()).length,
    auditEvents: (await ctx.db.query('audit_events').collect()).length,
  }));
}

// ---------------------------------------------------------------------------
// syncUserFromAuth
// ---------------------------------------------------------------------------

describe('syncUserFromAuth', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  it('given new Discord user, when synced, then subject and external account created', async () => {
    const t = makeTestConvex();

    const result = await t.mutation(api.identitySync.syncUserFromAuth, {
      apiSecret: 'test-secret',
      authUserId: 'auth-1',
      discord: {
        discordUserId: 'discord-1',
        username: 'testuser',
      },
    });

    expect(result.success).toBe(true);
    expect(result.isNewSubject).toBe(true);
    expect(result.isNewExternalAccount).toBe(true);

    const subject = await t.run(async (ctx) =>
      ctx.db
        .query('subjects')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', 'auth-1'))
        .first()
    );
    expect(subject).not.toBeNull();
    expect(subject?.primaryDiscordUserId).toBe('discord-1');

    const extAccount = await t.run(async (ctx) =>
      ctx.db
        .query('external_accounts')
        .withIndex('by_provider_user', (q) =>
          q.eq('provider', 'discord').eq('providerUserId', 'discord-1')
        )
        .first()
    );
    expect(extAccount).not.toBeNull();
    expect(extAccount?.providerUsername).toBe('testuser');
  });

  it('given same Discord user synced twice, then idempotent (1 subject, 1 external account)', async () => {
    const t = makeTestConvex();

    const syncArgs = {
      apiSecret: 'test-secret',
      authUserId: 'auth-2',
      discord: { discordUserId: 'discord-2', username: 'user2' },
    } as const;

    await t.mutation(api.identitySync.syncUserFromAuth, syncArgs);
    const result2 = await t.mutation(api.identitySync.syncUserFromAuth, syncArgs);

    expect(result2.isNewSubject).toBe(false);
    expect(result2.isNewExternalAccount).toBe(false);

    const subjects = await t.run(async (ctx) =>
      ctx.db
        .query('subjects')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', 'auth-2'))
        .collect()
    );
    expect(subjects.length).toBe(1);

    const extAccounts = await t.run(async (ctx) =>
      ctx.db
        .query('external_accounts')
        .withIndex('by_provider_user', (q) =>
          q.eq('provider', 'discord').eq('providerUserId', 'discord-2')
        )
        .collect()
    );
    expect(extAccounts.length).toBe(1);
  });

  it('given existing user with old username, when synced with new username, then updated', async () => {
    const t = makeTestConvex();

    await t.mutation(api.identitySync.syncUserFromAuth, {
      apiSecret: 'test-secret',
      authUserId: 'auth-3',
      discord: { discordUserId: 'discord-3', username: 'oldname' },
    });

    await t.mutation(api.identitySync.syncUserFromAuth, {
      apiSecret: 'test-secret',
      authUserId: 'auth-3',
      discord: { discordUserId: 'discord-3', username: 'newname' },
    });

    const extAccount = await t.run(async (ctx) =>
      ctx.db
        .query('external_accounts')
        .withIndex('by_provider_user', (q) =>
          q.eq('provider', 'discord').eq('providerUserId', 'discord-3')
        )
        .first()
    );
    expect(extAccount?.providerUsername).toBe('newname');
  });

  it('given wrong apiSecret, when syncing user, then rejects and writes nothing', async () => {
    const t = makeTestConvex();
    const before = await getIdentityCounts(t);

    await expect(
      t.mutation(api.identitySync.syncUserFromAuth, {
        apiSecret: 'wrong-secret',
        authUserId: 'auth-secret-fail',
        discord: {
          discordUserId: 'discord-secret-fail',
          username: 'attacker',
        },
      })
    ).rejects.toThrow('Unauthorized');

    expect(await getIdentityCounts(t)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// suspicious subjects
// ---------------------------------------------------------------------------

describe('suspicious subjects', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  it('given user marked suspicious, then appears in suspicious list', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const subId1 = await t.run(async (ctx) =>
      ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-suspicious-1',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
    );

    // Seed a second subject that should NOT appear in the suspicious list
    await t.run(async (ctx) =>
      ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-innocent-1',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
    );

    await t.mutation(api.identitySync.markSubjectSuspicious, {
      apiSecret: 'test-secret',
      subjectId: subId1,
      reason: 'piracy',
      actorId: 'admin-1',
    });

    const suspList = await t.query(api.identitySync.listSuspiciousSubjects, {
      apiSecret: 'test-secret',
    });

    const discordIds = suspList.map((s: { discordUserId: string }) => s.discordUserId);
    expect(discordIds).toContain('discord-suspicious-1');
    expect(discordIds).not.toContain('discord-innocent-1');
  });

  it('given suspicious user cleared, then no longer in suspicious list', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const subId = await t.run(async (ctx) =>
      ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-clear-1',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
    );

    await t.mutation(api.identitySync.markSubjectSuspicious, {
      apiSecret: 'test-secret',
      subjectId: subId,
      reason: 'piracy',
      actorId: 'admin-1',
    });

    await t.mutation(api.identitySync.clearSubjectSuspicious, {
      apiSecret: 'test-secret',
      subjectId: subId,
      actorId: 'admin-1',
    });

    const suspList = await t.query(api.identitySync.listSuspiciousSubjects, {
      apiSecret: 'test-secret',
    });

    const discordIds = suspList.map((s: { discordUserId: string }) => s.discordUserId);
    expect(discordIds).not.toContain('discord-clear-1');
  });

  it('given tenant-scoped suspicious listings, then only that tenant subjects are returned', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const tenantASubject = await t.run(async (ctx) =>
      ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-tenant-a-suspicious',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
    );
    const tenantBSubject = await t.run(async (ctx) =>
      ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-tenant-b-suspicious',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
    );

    await t.mutation(api.identitySync.markSubjectSuspicious, {
      apiSecret: 'test-secret',
      subjectId: tenantASubject,
      reason: 'piracy',
      actorId: 'admin-a',
      authUserId: 'auth-tenant-a',
    });
    await t.mutation(api.identitySync.markSubjectSuspicious, {
      apiSecret: 'test-secret',
      subjectId: tenantBSubject,
      reason: 'piracy',
      actorId: 'admin-b',
      authUserId: 'auth-tenant-b',
    });

    const tenantAList = await t.query(api.identitySync.listSuspiciousSubjects, {
      apiSecret: 'test-secret',
      authUserId: 'auth-tenant-a',
    });

    expect(tenantAList.map((entry) => entry.discordUserId)).toEqual([
      'discord-tenant-a-suspicious',
    ]);
  });
});

// ---------------------------------------------------------------------------
// external account
// ---------------------------------------------------------------------------

describe('external account', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  it('given external account disconnected, then status=disconnected', async () => {
    const t = makeTestConvex();

    const syncResult = await t.mutation(api.identitySync.syncUserFromAuth, {
      apiSecret: 'test-secret',
      authUserId: 'auth-disc-1',
      discord: { discordUserId: 'discord-disc-1', username: 'discuser' },
    });

    expect(syncResult.externalAccountId).toBeDefined();
    const extAccountId = syncResult.externalAccountId!;

    await t.mutation(api.identitySync.disconnectExternalAccount, {
      apiSecret: 'test-secret',
      externalAccountId: extAccountId,
    });

    const account = await t.run(async (ctx) => ctx.db.get(extAccountId));
    expect(account?.status).toBe('disconnected');
  });
});
