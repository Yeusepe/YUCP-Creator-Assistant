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
import { ConvexError } from 'convex/values';
import { api } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { getByProductInternal } from './role_rules';
import { makeTestConvex, seedGuildLink } from './testHelpers';

const DUMMY_DISCORD_SOURCE_GUILD_ID = '100000000000000001';
const DUMMY_DISCORD_REQUIRED_ROLE_ID = '100000000000000002';

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

  it('declares a structured return validator for internal product role rules', () => {
    const exportedReturns = JSON.parse(
      (
        getByProductInternal as unknown as {
          exportReturns: () => string;
        }
      ).exportReturns()
    );

    expect(exportedReturns).toMatchObject({
      type: 'array',
      value: {
        type: 'object',
      },
    });
    expect(JSON.stringify(exportedReturns)).toContain('verifiedRoleIds');
    expect(JSON.stringify(exportedReturns)).toContain('catalogTierId');
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

    const rule = (await t.run(async (ctx) =>
      ctx.db.get(result.ruleId)
    )) as Doc<'role_rules'> | null;
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
      sourceGuildId: DUMMY_DISCORD_SOURCE_GUILD_ID,
      requiredRoleId: DUMMY_DISCORD_REQUIRED_ROLE_ID,
      guildId: 'guild-refresh-discord',
      guildLinkId,
      verifiedRoleId: 'target-role-refresh',
      displayName: 'Member Access',
    });

    const jobTypes = await getOutboxJobTypes(t);

    expect(jobTypes).toContain('retroactive_rule_sync');
    expect(jobTypes).toContain('verify_prompt_refresh');
  });

  it('rejects discord cross-server rules with malformed source guild IDs', async () => {
    const t = makeTestConvex();

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-invalid-discord-source',
      discordGuildId: 'guild-invalid-discord-source',
    });
    const before = await getRoleRuleCounts(t);

    let caught: unknown;
    try {
      await t.mutation(api.role_rules.addProductFromDiscordRole, {
        apiSecret: 'test-secret',
        authUserId: 'auth-creator-invalid-discord-source',
        sourceGuildId: '../member',
        requiredRoleId: DUMMY_DISCORD_REQUIRED_ROLE_ID,
        guildId: 'guild-invalid-discord-source',
        guildLinkId,
        verifiedRoleId: 'target-role-invalid-discord-source',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as Error).message).toContain('Invalid Discord source guild ID');

    expect(await getRoleRuleCounts(t)).toEqual(before);
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

  it('rejects role rules that grant too many verified roles on create', async () => {
    const t = makeTestConvex();

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-role-limit-create',
      discordGuildId: 'guild-role-limit-create',
    });
    const before = await getRoleRuleCounts(t);

    await expect(
      t.mutation(api.role_rules.createRoleRule, {
        apiSecret: 'test-secret',
        authUserId: 'auth-creator-role-limit-create',
        guildId: 'guild-role-limit-create',
        guildLinkId,
        productId: 'prod-role-limit-create',
        verifiedRoleIds: Array.from({ length: 11 }, (_, index) => `role-limit-create-${index}`),
      })
    ).rejects.toThrow('A role rule can grant at most 10 verified roles');

    expect(await getRoleRuleCounts(t)).toEqual(before);
  });

  it('rejects role rule updates that grant too many verified roles', async () => {
    const t = makeTestConvex();

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-role-limit-update',
      discordGuildId: 'guild-role-limit-update',
    });
    const { ruleId } = await t.mutation(api.role_rules.createRoleRule, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-role-limit-update',
      guildId: 'guild-role-limit-update',
      guildLinkId,
      productId: 'prod-role-limit-update',
      verifiedRoleId: 'role-limit-update-original',
    });

    await expect(
      t.mutation(api.role_rules.updateRoleRule, {
        apiSecret: 'test-secret',
        ruleId,
        verifiedRoleIds: Array.from({ length: 11 }, (_, index) => `role-limit-update-${index}`),
      })
    ).rejects.toThrow('A role rule can grant at most 10 verified roles');

    const rule = await t.run(async (ctx) => ctx.db.get(ruleId));
    expect(rule?.verifiedRoleId).toBe('role-limit-update-original');
    expect(rule?.verifiedRoleIds).toBeUndefined();
  });

  it('normalizes duplicate verified role ids before storing role rules', async () => {
    const t = makeTestConvex();

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-role-dedupe',
      discordGuildId: 'guild-role-dedupe',
    });

    const { ruleId } = await t.mutation(api.role_rules.createRoleRule, {
      apiSecret: 'test-secret',
      authUserId: 'auth-creator-role-dedupe',
      guildId: 'guild-role-dedupe',
      guildLinkId,
      productId: 'prod-role-dedupe',
      verifiedRoleIds: ['role-dedupe-primary', 'role-dedupe-primary', 'role-dedupe-secondary'],
    });

    const rule = await t.run(async (ctx) => ctx.db.get(ruleId));

    expect(rule?.verifiedRoleId).toBe('role-dedupe-primary');
    expect(rule?.verifiedRoleIds).toEqual(['role-dedupe-primary', 'role-dedupe-secondary']);
  });

  it('rejects discord cross-server rules that grant too many verified roles', async () => {
    const t = makeTestConvex();

    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-creator-role-limit-discord',
      discordGuildId: 'guild-role-limit-discord',
    });
    const before = await getRoleRuleCounts(t);

    await expect(
      t.mutation(api.role_rules.addProductFromDiscordRole, {
        apiSecret: 'test-secret',
        authUserId: 'auth-creator-role-limit-discord',
        sourceGuildId: DUMMY_DISCORD_SOURCE_GUILD_ID,
        requiredRoleId: DUMMY_DISCORD_REQUIRED_ROLE_ID,
        guildId: 'guild-role-limit-discord',
        guildLinkId,
        verifiedRoleIds: Array.from({ length: 11 }, (_, index) => `role-limit-discord-${index}`),
      })
    ).rejects.toThrow('A role rule can grant at most 10 verified roles');

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

  it('given attacker points a rule at another tenant catalog tier, then rejects and writes nothing', async () => {
    const t = makeTestConvex();
    const attackerGuildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-attacker-tier',
      discordGuildId: 'guild-attacker-tier',
    });
    const before = await getRoleRuleCounts(t);

    const { catalogProductId, catalogTierId } = await t.run(async (ctx) => {
      const now = Date.now();
      const productId = await ctx.db.insert('product_catalog', {
        authUserId: 'auth-victim-tier',
        productId: 'victim-product',
        provider: 'gumroad',
        providerProductRef: 'victim-product-ref',
        displayName: 'Victim Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      const tierId = await ctx.db.insert('catalog_tiers', {
        authUserId: 'auth-victim-tier',
        provider: 'gumroad',
        productId: 'victim-product',
        catalogProductId: productId,
        providerProductRef: 'victim-product-ref',
        providerTierRef: 'victim-tier-ref',
        displayName: 'Victim Tier',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return {
        catalogProductId: productId,
        catalogTierId: tierId,
      };
    });

    await expect(
      t.mutation(api.role_rules.createRoleRule, {
        apiSecret: 'test-secret',
        authUserId: 'auth-attacker-tier',
        guildId: 'guild-attacker-tier',
        guildLinkId: attackerGuildLinkId,
        productId: 'attacker-product',
        catalogProductId,
        catalogTierId,
        verifiedRoleId: 'role-attacker-tier',
      })
    ).rejects.toThrow();

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
