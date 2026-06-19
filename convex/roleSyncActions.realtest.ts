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
  entitlementStatus: 'active' | 'revoked' = 'active',
  overrides?: {
    discordUserId?: string;
    guildId?: string;
    roleId?: string;
  }
) {
  const now = Date.now();
  const discordUserId = overrides?.discordUserId ?? DISCORD_USER;
  const guildId = overrides?.guildId ?? GUILD_ID;
  const roleId = overrides?.roleId ?? ROLE_ID;
  return t.run(async (ctx) => {
    const subjectId = await ctx.db.insert('subjects', {
      primaryDiscordUserId: discordUserId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const guildLinkId = await ctx.db.insert('guild_links', {
      authUserId: AUTH_USER,
      discordGuildId: guildId,
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
    const roleRuleId = await ctx.db.insert('role_rules', {
      authUserId: AUTH_USER,
      guildId,
      guildLinkId,
      productId: PRODUCT_ID,
      verifiedRoleId: roleId,
      removeOnRevoke: true,
      priority: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const outboxJobId = await ctx.db.insert('outbox_jobs', {
      authUserId: AUTH_USER,
      jobType: 'role_sync',
      payload: { subjectId, entitlementId, discordUserId },
      status: 'pending',
      idempotencyKey: `action-test-${now}`,
      retryCount: 0,
      maxRetries: 10,
      createdAt: now,
      updatedAt: now,
    });
    return { subjectId, entitlementId, outboxJobId, roleRuleId, guildLinkId };
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
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect((fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe(
      'Bot test-bot-token'
    );
  });

  it('uses matching tier-scoped rules instead of product-level fallback rules', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId, guildLinkId } = await seed(t);
    const fetchFn = mockFetch(204);
    await t.run(async (ctx) => {
      const now = Date.now();
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: AUTH_USER,
        productId: PRODUCT_ID,
        provider: 'gumroad',
        providerProductRef: PRODUCT_ID,
        displayName: 'Tiered Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      const advancedTierId = await ctx.db.insert('catalog_tiers', {
        authUserId: AUTH_USER,
        provider: 'gumroad',
        productId: PRODUCT_ID,
        catalogProductId,
        providerProductRef: PRODUCT_ID,
        providerTierRef: 'version-advanced',
        displayName: 'Advanced',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('entitlement_evidence', {
        authUserId: AUTH_USER,
        subjectId,
        providerKey: 'gumroad',
        sourceReference: 'order-action-test',
        evidenceType: 'license_verification',
        status: 'active',
        productId: PRODUCT_ID,
        catalogProductId,
        providerTierRefs: ['version-advanced'],
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
      await ctx.db.insert('role_rules', {
        authUserId: AUTH_USER,
        guildId: GUILD_ID,
        guildLinkId,
        productId: PRODUCT_ID,
        catalogTierId: advancedTierId,
        verifiedRoleId: 'role-action-advanced',
        removeOnRevoke: true,
        priority: 1,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(true);
    expect(result.rolesAdded).toEqual(['role-action-advanced']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toContain(
      `/guilds/${GUILD_ID}/members/${DISCORD_USER}/roles/role-action-advanced`
    );
  });

  it('preserves product-wide rules in guilds without tier-scoped overrides', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId } = await seed(t);
    const fetchFn = mockFetch(204);

    await t.run(async (ctx) => {
      const now = Date.now();
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: AUTH_USER,
        productId: PRODUCT_ID,
        provider: 'gumroad',
        providerProductRef: PRODUCT_ID,
        displayName: 'Multi Guild Tiered Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      const advancedTierId = await ctx.db.insert('catalog_tiers', {
        authUserId: AUTH_USER,
        provider: 'gumroad',
        productId: PRODUCT_ID,
        catalogProductId,
        providerProductRef: PRODUCT_ID,
        providerTierRef: 'version-advanced',
        displayName: 'Advanced',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('entitlement_evidence', {
        authUserId: AUTH_USER,
        subjectId,
        providerKey: 'gumroad',
        sourceReference: 'order-action-test',
        evidenceType: 'license_verification',
        status: 'active',
        productId: PRODUCT_ID,
        catalogProductId,
        providerTierRefs: ['version-advanced'],
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
      const tieredGuildLinkId = await ctx.db.insert('guild_links', {
        authUserId: AUTH_USER,
        discordGuildId: 'guild-action-tiered',
        installedByAuthUserId: AUTH_USER,
        botPresent: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId: AUTH_USER,
        guildId: 'guild-action-tiered',
        guildLinkId: tieredGuildLinkId,
        productId: PRODUCT_ID,
        verifiedRoleId: 'role-action-tiered-fallback',
        removeOnRevoke: true,
        priority: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId: AUTH_USER,
        guildId: 'guild-action-tiered',
        guildLinkId: tieredGuildLinkId,
        productId: PRODUCT_ID,
        catalogTierId: advancedTierId,
        verifiedRoleId: 'role-action-advanced',
        removeOnRevoke: true,
        priority: 1,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(true);
    expect(result.rolesAdded).toEqual(expect.arrayContaining([ROLE_ID, 'role-action-advanced']));
    expect(result.rolesAdded).toHaveLength(2);
    expect(result.targetGuildIds).toEqual(
      expect.arrayContaining([GUILD_ID, 'guild-action-tiered'])
    );
    const roleUrls = fetchFn.mock.calls.map((call) => String(call[0]));
    expect(roleUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`/guilds/${GUILD_ID}/members/${DISCORD_USER}/roles/${ROLE_ID}`),
        expect.stringContaining(
          `/guilds/guild-action-tiered/members/${DISCORD_USER}/roles/role-action-advanced`
        ),
      ])
    );
    expect(roleUrls).not.toEqual(
      expect.arrayContaining([expect.stringContaining('role-action-tiered-fallback')])
    );
  });

  it('fails visibly when tier-scoped rules exist but the entitlement has no tier evidence', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId, guildLinkId } = await seed(t);
    const fetchFn = mockFetch(204);
    await t.run(async (ctx) => {
      const now = Date.now();
      const advancedTierId = await ctx.db.insert('catalog_tiers', {
        authUserId: AUTH_USER,
        provider: 'gumroad',
        productId: PRODUCT_ID,
        providerProductRef: PRODUCT_ID,
        providerTierRef: 'version-advanced',
        displayName: 'Advanced',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId: AUTH_USER,
        guildId: GUILD_ID,
        guildLinkId,
        productId: PRODUCT_ID,
        catalogTierId: advancedTierId,
        verifiedRoleId: 'role-action-advanced',
        removeOnRevoke: true,
        priority: 1,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Tier evidence missing/);
    expect(result.nonRetriable).toBe(true);
    expect(result.targetGuildIds).toEqual([GUILD_ID]);
    expect(result.rolesAdded).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('ignores disabled fallback rules when failing closed for missing tier evidence', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId, guildLinkId } = await seed(t);
    const fetchFn = mockFetch(204);

    await t.run(async (ctx) => {
      const now = Date.now();
      const disabledFallbackGuildLinkId = await ctx.db.insert('guild_links', {
        authUserId: AUTH_USER,
        discordGuildId: 'guild-action-disabled-fallback',
        installedByAuthUserId: AUTH_USER,
        botPresent: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const advancedTierId = await ctx.db.insert('catalog_tiers', {
        authUserId: AUTH_USER,
        provider: 'gumroad',
        productId: PRODUCT_ID,
        providerProductRef: PRODUCT_ID,
        providerTierRef: 'version-disabled-fallback-advanced',
        displayName: 'Advanced Disabled Fallback',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId: AUTH_USER,
        guildId: GUILD_ID,
        guildLinkId,
        productId: PRODUCT_ID,
        catalogTierId: advancedTierId,
        verifiedRoleId: 'role-action-disabled-fallback-advanced',
        removeOnRevoke: true,
        priority: 1,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId: AUTH_USER,
        guildId: 'guild-action-disabled-fallback',
        guildLinkId: disabledFallbackGuildLinkId,
        productId: PRODUCT_ID,
        verifiedRoleId: 'role-action-disabled-fallback-product',
        removeOnRevoke: true,
        priority: 1,
        enabled: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Tier evidence missing/);
    expect(result.nonRetriable).toBe(true);
    expect(result.targetGuildIds).toEqual([GUILD_ID]);
    expect(result.rolesAdded).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('preserves product-wide sync in guilds without tier-scoped rules when tier evidence is missing', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId } = await seed(t);
    const fetchFn = mockFetch(204);

    await t.run(async (ctx) => {
      const now = Date.now();
      const tieredGuildLinkId = await ctx.db.insert('guild_links', {
        authUserId: AUTH_USER,
        discordGuildId: 'guild-action-tiered-missing-evidence',
        installedByAuthUserId: AUTH_USER,
        botPresent: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const advancedTierId = await ctx.db.insert('catalog_tiers', {
        authUserId: AUTH_USER,
        provider: 'gumroad',
        productId: PRODUCT_ID,
        providerProductRef: PRODUCT_ID,
        providerTierRef: 'version-missing-evidence-advanced',
        displayName: 'Advanced Without Evidence',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId: AUTH_USER,
        guildId: 'guild-action-tiered-missing-evidence',
        guildLinkId: tieredGuildLinkId,
        productId: PRODUCT_ID,
        verifiedRoleId: 'role-action-tiered-fallback-missing-evidence',
        removeOnRevoke: true,
        priority: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId: AUTH_USER,
        guildId: 'guild-action-tiered-missing-evidence',
        guildLinkId: tieredGuildLinkId,
        productId: PRODUCT_ID,
        catalogTierId: advancedTierId,
        verifiedRoleId: 'role-action-advanced-missing-evidence',
        removeOnRevoke: true,
        priority: 1,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    });

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
    const roleUrls = fetchFn.mock.calls.map((call) => String(call[0]));
    expect(roleUrls).toEqual([
      expect.stringContaining(`/guilds/${GUILD_ID}/members/${DISCORD_USER}/roles/${ROLE_ID}`),
    ]);
    expect(roleUrls).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('role-action-tiered-fallback-missing-evidence'),
        expect.stringContaining('role-action-advanced-missing-evidence'),
      ])
    );
  });

  it('skips tier-scoped sync when tier evidence does not match an active configured tier', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId, guildLinkId } = await seed(t);
    const fetchFn = mockFetch(204);

    await t.run(async (ctx) => {
      const now = Date.now();
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: AUTH_USER,
        productId: PRODUCT_ID,
        provider: 'gumroad',
        providerProductRef: PRODUCT_ID,
        displayName: 'Tiered Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      const advancedTierId = await ctx.db.insert('catalog_tiers', {
        authUserId: AUTH_USER,
        provider: 'gumroad',
        productId: PRODUCT_ID,
        catalogProductId,
        providerProductRef: PRODUCT_ID,
        providerTierRef: 'version-advanced',
        displayName: 'Advanced',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('entitlement_evidence', {
        authUserId: AUTH_USER,
        subjectId,
        providerKey: 'gumroad',
        sourceReference: 'order-action-test',
        evidenceType: 'license_verification',
        status: 'active',
        productId: PRODUCT_ID,
        catalogProductId,
        providerTierRefs: ['version-basic-unconfigured'],
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
      await ctx.db.insert('role_rules', {
        authUserId: AUTH_USER,
        guildId: GUILD_ID,
        guildLinkId,
        productId: PRODUCT_ID,
        catalogTierId: advancedTierId,
        verifiedRoleId: 'role-action-advanced',
        removeOnRevoke: true,
        priority: 1,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.rolesAdded).toEqual([]);
    expect(result.targetGuildIds).toEqual([]);
    expect(result.error).toBe('No role rules configured for product');
    expect(result.nonRetriable).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('URL-encodes Discord role path params before calling the API', async () => {
    const t = makeTestConvex();
    const discordUserId = 'discord/action user';
    const guildId = 'guild/action test';
    const roleId = 'role/action test';
    const { subjectId, entitlementId, outboxJobId } = await seed(t, 'active', {
      discordUserId,
      guildId,
      roleId,
    });
    const fetchFn = mockFetch(204);

    await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId,
    });

    expect(fetchFn.mock.calls[0]?.[0]).toContain(
      `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordUserId)}/roles/${encodeURIComponent(roleId)}`
    );
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

    const stored = await t.run(async (ctx) => ctx.db.get(outboxJobId));
    expect(stored?.targetGuildIds).toEqual([GUILD_ID]);
  });

  it('rejects entitlement/auth user mismatches before calling Discord', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId } = await seed(t);
    const fetchFn = mockFetch(204);

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: 'auth-action-intruder',
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Entitlement\/authUser mismatch/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('redacts entitlement ids when a sync job references a deleted entitlement', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId } = await seed(t);
    const fetchFn = mockFetch(204);
    await t.run(async (ctx) => {
      await ctx.db.delete(entitlementId);
    });

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Entitlement not found');
    expect(result.error).not.toContain(entitlementId);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects oversized legacy multi-role rules before calling Discord', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId, roleRuleId } = await seed(t);
    const fetchFn = mockFetch(204);
    await t.run(async (ctx) => {
      await ctx.db.patch(roleRuleId, {
        verifiedRoleId: 'role-oversized-0',
        verifiedRoleIds: Array.from({ length: 11 }, (_, index) => `role-oversized-${index}`),
      });
    });

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Role rule exceeds the maximum of 10 verified roles');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('dedupes repeated verified role ids before calling Discord', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId, roleRuleId } = await seed(t);
    const fetchFn = mockFetch(204);
    await t.run(async (ctx) => {
      await ctx.db.patch(roleRuleId, {
        verifiedRoleId: 'role-duplicate-a',
        verifiedRoleIds: ['role-duplicate-a', 'role-duplicate-a', 'role-duplicate-b'],
      });
    });

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(true);
    expect(result.rolesAdded).toEqual(['role-duplicate-a', 'role-duplicate-b']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('rejects role sync jobs with too many Discord role operations before calling Discord', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId } = await seed(t);
    const fetchFn = mockFetch(204);
    await t.run(async (ctx) => {
      const now = Date.now();
      const guildLinkId = await ctx.db.insert('guild_links', {
        authUserId: AUTH_USER,
        discordGuildId: 'guild-action-bulk',
        installedByAuthUserId: AUTH_USER,
        botPresent: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      for (let index = 0; index < 100; index++) {
        await ctx.db.insert('role_rules', {
          authUserId: AUTH_USER,
          guildId: 'guild-action-bulk',
          guildLinkId,
          productId: PRODUCT_ID,
          verifiedRoleId: `role-action-bulk-${index}`,
          removeOnRevoke: true,
          priority: index,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    const result = await t.action(internal.roleSyncActions.runRoleSync, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Role sync exceeds the maximum of 100 Discord role operations');
    expect(fetchFn).not.toHaveBeenCalled();
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
    const fetchFn = mockFetch(404, { code: 10011, message: 'Unknown Role' });

    const result = await t.action(internal.roleSyncActions.runRoleRemoval, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      guildId: GUILD_ID,
      roleId: ROLE_ID,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(true);
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('URL-encodes Discord role removal path params before calling the API', async () => {
    const t = makeTestConvex();
    const discordUserId = 'discord/remove user';
    const guildId = 'guild/remove test';
    const roleId = 'role/remove test';
    const { subjectId, outboxJobId } = await seed(t, 'revoked', {
      discordUserId,
      guildId,
      roleId,
    });
    const fetchFn = mockFetch(204);

    await t.action(internal.roleSyncActions.runRoleRemoval, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      guildId,
      roleId,
      discordUserId,
    });

    expect(fetchFn.mock.calls[0]?.[0]).toContain(
      `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordUserId)}/roles/${encodeURIComponent(roleId)}`
    );
  });

  it('rejects removal entitlement/auth user mismatches before calling Discord', async () => {
    const t = makeTestConvex();
    const { subjectId, entitlementId, outboxJobId } = await seed(t, 'revoked');
    const fetchFn = mockFetch(204);

    const result = await t.action(internal.roleSyncActions.runRoleRemoval, {
      outboxJobId,
      authUserId: 'auth-action-intruder',
      subjectId,
      entitlementId,
      guildId: GUILD_ID,
      roleId: ROLE_ID,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Entitlement\/authUser mismatch/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('removes stale roles from the queued Discord user after the subject reconnects', async () => {
    const t = makeTestConvex();
    const oldDiscordUserId = 'discord-action-old-user';
    const newDiscordUserId = 'discord-action-new-user';
    const { subjectId, entitlementId, outboxJobId } = await seed(t, 'active', {
      discordUserId: newDiscordUserId,
    });
    const fetchFn = mockFetch(204);

    const result = await t.action(internal.roleSyncActions.runRoleRemoval, {
      outboxJobId,
      authUserId: AUTH_USER,
      subjectId,
      entitlementId,
      guildId: GUILD_ID,
      roleId: ROLE_ID,
      discordUserId: oldDiscordUserId,
    });

    expect(result.success).toBe(true);
    expect(result.rolesRemoved).toEqual([ROLE_ID]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toContain(
      `/members/${encodeURIComponent(oldDiscordUserId)}/roles/`
    );
  });
});
