/**
 * Integration tests for Role Rules Module
 *
 * Uses convex-test to run against an in-memory Convex backend.
 * Run with: npx vitest run --config convex/vitest.config.ts convex/roleRules.realtest.ts
 *
 * Security refs from plan.md:
 * - https://docs.convex.dev/testing/convex-test
 * - https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex, seedGuildLink } from './testHelpers';

async function getRoleRuleCounts(t: ReturnType<typeof makeTestConvex>) {
  return t.run(async (ctx) => ({
    roleRules: (await ctx.db.query('role_rules').collect()).length,
    outboxJobs: (await ctx.db.query('outbox_jobs').collect()).length,
  }));
}

async function getOutboxJobTypes(t: ReturnType<typeof makeTestConvex>) {
  return t.run(async (ctx) =>
    (await ctx.db.query('outbox_jobs').collect()).map((job) => job.jobType)
  );
}

describe('role rules CRUD and isolation', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  it('given new product rule created, then correct fields stored', async () => {
    const t = makeTestConvex();

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-1',
      discordGuildId: 'guild-A',
    });

    const result = await t.mutation(api.role_rules.createRoleRule, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-1',
      guildId: 'guild-A',
      guildLinkId,
      productId: 'gumroad:prod1',
      verifiedRoleId: 'role-111',
    });

    expect(result.ruleId).toBeDefined();

    const rule = await t.run(async (ctx) => ctx.db.get(result.ruleId));
    expect(rule?.productId).toBe('gumroad:prod1');
    expect(rule?.verifiedRoleId).toBe('role-111');
    expect(rule?.guildId).toBe('guild-A');
    expect(rule?.authUserId).toBe('auth-creator-1');
    expect(rule?.enabled).toBe(true);
    expect(rule?.removeOnRevoke).toBe(true);
  });

  it('given rules in 2 guilds, when getByGuild called for guild A, then only guild A rules returned', async () => {
    const t = makeTestConvex();

    const guildLinkA = await seedGuildLink(t, {
      authUserId: 'auth-creator-2',
      discordGuildId: 'guild-A2',
    });
    const guildLinkB = await seedGuildLink(t, {
      authUserId: 'auth-creator-2',
      discordGuildId: 'guild-B2',
    });

    // Insert 3 rules in guild A
    for (let i = 0; i < 3; i++) {
      await t.mutation(api.role_rules.createRoleRule, {
        apiSecret: 'test-secret',
        authUserId: 'auth-creator-2',
        guildId: 'guild-A2',
        guildLinkId: guildLinkA,
        productId: `prod-a-${i}`,
        verifiedRoleId: `role-a-${i}`,
      });
    }

    // Insert 1 rule in guild B
    await t.mutation(api.role_rules.createRoleRule, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-2',
      guildId: 'guild-B2',
      guildLinkId: guildLinkB,
      productId: 'prod-b-1',
      verifiedRoleId: 'role-b-1',
    });

    const rulesA = await t.query(api.role_rules.getByGuild, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-2',
      guildId: 'guild-A2',
    });

    expect(rulesA.length).toBe(3);
    expect(rulesA.every((r: { guildId: string }) => r.guildId === 'guild-A2')).toBe(true);
  });

  it('given 1 rule, when deleted, then getByGuild returns empty', async () => {
    const t = makeTestConvex();

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-3',
      discordGuildId: 'guild-C3',
    });

    const { ruleId } = await t.mutation(api.role_rules.createRoleRule, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-3',
      guildId: 'guild-C3',
      guildLinkId,
      productId: 'prod-c-1',
      verifiedRoleId: 'role-c-1',
    });

    await t.mutation(api.role_rules.deleteRoleRule, {
      apiSecret: 'test-secret',
      ruleId,
    });

    const rules = await t.query(api.role_rules.getByGuild, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-3',
      guildId: 'guild-C3',
    });

    expect(rules.length).toBe(0);
  });

  it('given rules referencing gumroad + jinxxy products, getEnabledVerificationProviders returns both (no duplicates)', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    // Insert product catalog entries so provider can be resolved by the query
    const gumroadCatalogId = await t.run(async (ctx) =>
      ctx.db.insert('product_catalog', {
        authUserId: 'auth-creator-4',
        productId: 'gumroad:prod1',
        provider: 'gumroad',
        providerProductRef: 'prod1-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      })
    );

    const jinxxyCatalogId = await t.run(async (ctx) =>
      ctx.db.insert('product_catalog', {
        authUserId: 'auth-creator-4',
        productId: 'jinxxy:prod2',
        provider: 'jinxxy',
        providerProductRef: 'prod2-ref',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      })
    );

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-4',
      discordGuildId: 'guild-D4',
    });

    // 2 rules referencing gumroad catalog, 1 rule referencing jinxxy catalog
    await t.run(async (ctx) => {
      await ctx.db.insert('role_rules', {
        authUserId: 'auth-creator-4',
        guildId: 'guild-D4',
        guildLinkId,
        productId: 'gumroad:prod1',
        catalogProductId: gumroadCatalogId,
        verifiedRoleId: 'role-d-1',
        removeOnRevoke: true,
        priority: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId: 'auth-creator-4',
        guildId: 'guild-D4',
        guildLinkId,
        productId: 'gumroad:prod1',
        catalogProductId: gumroadCatalogId,
        verifiedRoleId: 'role-d-2',
        removeOnRevoke: true,
        priority: 1,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId: 'auth-creator-4',
        guildId: 'guild-D4',
        guildLinkId,
        productId: 'jinxxy:prod2',
        catalogProductId: jinxxyCatalogId,
        verifiedRoleId: 'role-d-3',
        removeOnRevoke: true,
        priority: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.query(api.role_rules.getEnabledVerificationProvidersFromProducts, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-4',
      guildId: 'guild-D4',
    });

    const providers = [...result.providers].sort();
    expect(providers).toContain('gumroad');
    expect(providers).toContain('jinxxy');
    expect(providers.length).toBe(2); // no duplicates
  });

  it('enqueues a verify prompt refresh job when a role rule is created', async () => {
    const t = makeTestConvex();

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-refresh-create',
      discordGuildId: 'guild-refresh-create',
    });

    await t.mutation(api.role_rules.createRoleRule, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-refresh-create',
      guildId: 'guild-refresh-create',
      guildLinkId,
      productId: 'gumroad:prod-refresh-create',
      verifiedRoleId: 'role-refresh-create',
    });

    const jobTypes = await getOutboxJobTypes(t);

    expect(jobTypes).toContain('retroactive_rule_sync');
    expect(jobTypes).toContain('verify_prompt_refresh');
  });

  it('enqueues another verify prompt refresh job when a role rule is deleted', async () => {
    const t = makeTestConvex();

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-refresh-delete',
      discordGuildId: 'guild-refresh-delete',
    });

    const { ruleId } = await t.mutation(api.role_rules.createRoleRule, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-refresh-delete',
      guildId: 'guild-refresh-delete',
      guildLinkId,
      productId: 'gumroad:prod-refresh-delete',
      verifiedRoleId: 'role-refresh-delete',
    });

    await t.mutation(api.role_rules.deleteRoleRule, {
      apiSecret: 'test-secret',
      ruleId,
    });

    const refreshJobs = (await getOutboxJobTypes(t)).filter(
      (jobType) => jobType === 'verify_prompt_refresh'
    );

    expect(refreshJobs).toHaveLength(2);
  });

  it('enqueues a verify prompt refresh job for discord cross-server role rules', async () => {
    const t = makeTestConvex();

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-refresh-discord',
      discordGuildId: 'guild-refresh-discord',
    });

    await t.mutation(api.role_rules.addProductFromDiscordRole, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-refresh-discord',
      sourceGuildId: 'source-guild-refresh',
      requiredRoleId: 'source-role-refresh',
      guildId: 'guild-refresh-discord',
      guildLinkId,
      verifiedRoleId: 'target-role-refresh',
      displayName: 'Member Access',
    });

    const jobTypes = await getOutboxJobTypes(t);

    expect(jobTypes).toContain('retroactive_rule_sync');
    expect(jobTypes).toContain('verify_prompt_refresh');
  });

  it('given wrong apiSecret, when creating rule, then throws', async () => {
    const t = makeTestConvex();

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-5',
      discordGuildId: 'guild-E5',
    });
    const before = await getRoleRuleCounts(t);

    await expect(
      t.mutation(api.role_rules.createRoleRule, {
        apiSecret: 'wrong-secret',
        authUserId: 'auth-creator-5',
        guildId: 'guild-E5',
        guildLinkId,
        productId: 'prod-e-1',
        verifiedRoleId: 'role-e-1',
      })
    ).rejects.toThrow();

    expect(await getRoleRuleCounts(t)).toEqual(before);
  });

  it('given attacker uses another tenant guildLink, when creating rule, then rejects and writes nothing', async () => {
    const t = makeTestConvex();
    const victimGuildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-victim-1',
      discordGuildId: 'guild-victim-1',
    });
    const before = await getRoleRuleCounts(t);

    await expect(
      t.mutation(api.role_rules.createRoleRule, {
        apiSecret: 'test-secret',
        authUserId: 'auth-attacker-1',
        guildId: 'guild-victim-1',
        guildLinkId: victimGuildLinkId,
        productId: 'gumroad:prod-attack',
        verifiedRoleId: 'role-attack',
      })
    ).rejects.toThrow('Unauthorized: caller does not own this guild link');

    expect(await getRoleRuleCounts(t)).toEqual(before);
  });

  it('given same guildId reused across tenants, when queried, then only caller tenant rules are returned', async () => {
    const t = makeTestConvex();
    const guildId = 'shared-guild-id';
    const tenantALink = await seedGuildLink(t, {
      authUserId: 'auth-tenant-a',
      discordGuildId: guildId,
    });
    const tenantBLink = await seedGuildLink(t, {
      authUserId: 'auth-tenant-b',
      discordGuildId: guildId,
    });

    await t.mutation(api.role_rules.createRoleRule, {
      apiSecret: 'test-secret',
      authUserId: 'auth-tenant-a',
      guildId,
      guildLinkId: tenantALink,
      productId: 'gumroad:prod-a',
      verifiedRoleId: 'role-a',
    });
    await t.mutation(api.role_rules.createRoleRule, {
      apiSecret: 'test-secret',
      authUserId: 'auth-tenant-b',
      guildId,
      guildLinkId: tenantBLink,
      productId: 'gumroad:prod-b',
      verifiedRoleId: 'role-b',
    });

    const tenantARules = await t.query(api.role_rules.getByGuild, {
      apiSecret: 'test-secret',
      authUserId: 'auth-tenant-a',
      guildId,
    });

    expect(tenantARules).toHaveLength(1);
    expect(tenantARules[0]).toMatchObject({
      authUserId: 'auth-tenant-a',
      productId: 'gumroad:prod-a',
      verifiedRoleId: 'role-a',
    });
  });
});
