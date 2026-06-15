import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

const PRODUCT_ID = 'product-action-test';
const AUTH_USER = 'auth-action-test';
const DISCORD_USER = 'discord-action-user';
const GUILD_ID = 'guild-action-test';
const ROLE_ID = 'role-action-test';

async function seed(
  t: ReturnType<typeof makeTestConvex>,
  entitlementStatus: 'active' | 'revoked' = 'active'
) {
  const now = Date.now();
  return t.run(async (ctx) => {
    const subjectId = await ctx.db.insert('subjects', {
      primaryDiscordUserId: DISCORD_USER,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const guildLinkId = await ctx.db.insert('guild_links', {
      authUserId: AUTH_USER,
      discordGuildId: GUILD_ID,
      installedByAuthUserId: AUTH_USER,
      botPresent: true,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const entitlementId = await ctx.db.insert('entitlements', {
      authUserId: AUTH_USER,
      subjectId,
      productId: PRODUCT_ID,
      sourceProvider: 'gumroad',
      sourceReference: 'order-action-test',
      status: entitlementStatus,
      grantedAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('role_rules', {
      authUserId: AUTH_USER,
      guildId: GUILD_ID,
      guildLinkId,
      productId: PRODUCT_ID,
      verifiedRoleId: ROLE_ID,
      removeOnRevoke: true,
      priority: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const outboxJobId = await ctx.db.insert('outbox_jobs', {
      authUserId: AUTH_USER,
      jobType: 'role_sync',
      payload: { subjectId, entitlementId, discordUserId: DISCORD_USER },
      status: 'pending',
      idempotencyKey: `action-test-${now}`,
      retryCount: 0,
      maxRetries: 10,
      createdAt: now,
      updatedAt: now,
    });
    return { subjectId, entitlementId, outboxJobId };
  });
}

function mockFetch(status: number, body?: unknown, headers?: Record<string, string>) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
    body === undefined
      ? new Response(null, { status, headers })
      : new Response(JSON.stringify(body), { status, headers })
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('roleSyncActions.runRoleSync', () => {
  const originalToken = process.env.DISCORD_BOT_TOKEN;
  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = originalToken;
  });

  it('grants the role and reports success when Discord returns 204', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId } = await seed(t);
    const fetchFn = mockFetch(204);

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(true);
    expect(result.rolesAdded).toEqual([ROLE_ID]);
    expect(result.targetGuildIds).toEqual([GUILD_ID]);
    const url = fetchFn.mock.calls[0]?.[0];
    expect(url).toContain(`/guilds/${GUILD_ID}/members/${DISCORD_USER}/roles/${ROLE_ID}`);
  });

  it('throws (retriable) when the member is not in the guild yet (10007)', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId } = await seed(t);
    mockFetch(404, { code: 10007, message: 'Unknown Member' });

    await expect(
      t.action(internal.roleSyncActions.runRoleSync, {
        outboxJobId,
        authUserId: AUTH_USER,
        subjectId,
        entitlementId,
        discordUserId: DISCORD_USER,
      })
    ).rejects.toThrow(/Member not found/);
  });

  it('returns a permanent failure (no throw) on missing permissions (50013)', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId } = await seed(t);
    mockFetch(403, { code: 50013, message: 'Missing Permissions' });

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Manage Roles/);
    expect(result.targetGuildIds).toEqual([GUILD_ID]);
  });

  it('skips (success, no grant) when the entitlement is not active', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId } = await seed(t, 'revoked');
    const fetchFn = mockFetch(204);

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(true);
    expect(result.rolesAdded).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('roleSyncActions.runRoleRemoval', () => {
  const originalToken = process.env.DISCORD_BOT_TOKEN;
  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = originalToken;
  });

  it('treats Unknown Member/Role as already-removed success (idempotent)', async () => {
    const t = makeTestConvex();
    const { subjectId, outboxJobId } = await seed(t, 'revoked');
    mockFetch(404, { code: 10011, message: 'Unknown Role' });

    const result = await t.action(internal.roleSyncActions.runRoleRemoval, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      guildId: GUILD_ID,
      roleId: ROLE_ID,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(true);
  });
});
