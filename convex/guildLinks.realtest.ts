import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'test-secret';
const previousAutomaticSetupFlag = process.env.YUCP_ENABLE_AUTOMATIC_SETUP;

async function seedGuildLink(
  t: ReturnType<typeof makeTestConvex>,
  args: {
    authUserId: string;
    discordGuildId: string;
  }
): Promise<Id<'guild_links'>> {
  return t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert('guild_links', {
      authUserId: args.authUserId,
      discordGuildId: args.discordGuildId,
      installedByAuthUserId: args.authUserId,
      botPresent: true,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedProviderConnection(
  t: ReturnType<typeof makeTestConvex>,
  authUserId: string
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('provider_connections', {
      authUserId,
      provider: 'gumroad',
      providerKey: 'gumroad',
      connectionType: 'setup',
      status: 'active',
      webhookConfigured: false,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('guild_links schema compatibility', () => {
  beforeEach(() => {
    process.env.YUCP_ENABLE_AUTOMATIC_SETUP = 'true';
  });

  afterEach(() => {
    process.env.YUCP_ENABLE_AUTOMATIC_SETUP = previousAutomaticSetupFlag;
  });

  it('atomically creates first onboarding state, repeats, and rejects a foreign guild owner', async () => {
    const t = makeTestConvex();
    const previousApiSecret = process.env.CONVEX_API_SECRET;
    process.env.CONVEX_API_SECRET = API_SECRET;
    try {
      const first = await t.mutation(api.guildLinks.completeCreatorOnboarding, {
        apiSecret: API_SECRET,
        authUserId: 'auth-onboarding-owner',
        discordUserId: 'discord-onboarding-owner',
        discordGuildId: 'guild-onboarding-owned',
      });
      expect(first).toEqual({
        completed: true,
        conflict: false,
        authUserId: 'auth-onboarding-owner',
        isFirstTime: true,
      });

      const repeated = await t.mutation(api.guildLinks.completeCreatorOnboarding, {
        apiSecret: API_SECRET,
        authUserId: 'auth-onboarding-owner',
        discordUserId: 'discord-onboarding-owner',
        discordGuildId: 'guild-onboarding-owned',
      });
      expect(repeated).toEqual({
        completed: true,
        conflict: false,
        authUserId: 'auth-onboarding-owner',
        isFirstTime: false,
      });

      const conflict = await t.mutation(api.guildLinks.completeCreatorOnboarding, {
        apiSecret: API_SECRET,
        authUserId: 'auth-onboarding-challenger',
        discordUserId: 'discord-onboarding-challenger',
        discordGuildId: 'guild-onboarding-owned',
      });
      expect(conflict).toEqual({ completed: false, conflict: true });

      const state = await t.run(async (ctx) => ({
        guildLinks: await ctx.db.query('guild_links').collect(),
        profiles: await ctx.db.query('creator_profiles').collect(),
      }));
      expect(state.guildLinks).toHaveLength(1);
      expect(state.guildLinks[0]?.authUserId).toBe('auth-onboarding-owner');
      expect(state.profiles).toHaveLength(1);
      expect(state.profiles[0]?.authUserId).toBe('auth-onboarding-owner');
    } finally {
      process.env.CONVEX_API_SECRET = previousApiSecret;
    }
  });

  it('accepts legacy verifyPromptMessage metadata on guild links', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const legacyGuildLink = {
      authUserId: 'auth-guild-link-legacy',
      discordGuildId: 'guild-legacy',
      installedByAuthUserId: 'auth-guild-link-legacy',
      botPresent: true,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
      verifyPromptMessage: {
        channelId: 'channel-legacy',
        messageId: 'message-legacy',
        updatedAt: now,
      },
    };

    const id = await t.run(async (ctx) => ctx.db.insert('guild_links', legacyGuildLink));
    const stored = await t.run(async (ctx) => ctx.db.get(id));

    expect(stored).toEqual(
      expect.objectContaining({
        verifyPromptMessage: legacyGuildLink.verifyPromptMessage,
      })
    );
  });

  it('removes legacy verifyPromptMessage metadata via migration', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const id = await t.run(async (ctx) =>
      ctx.db.insert('guild_links', {
        authUserId: 'auth-guild-link-migration',
        discordGuildId: 'guild-migration',
        installedByAuthUserId: 'auth-guild-link-migration',
        botPresent: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        verifyPromptMessage: {
          channelId: 'channel-migration',
          messageId: 'message-migration',
          updatedAt: now,
        },
      })
    );

    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.migrations.purgeGuildLinkVerifyPromptMessages, {})
    );
    const stored = await t.run(async (ctx) => ctx.db.get(id));

    expect(result).toEqual({ updated: 1 });
    expect(stored?.verifyPromptMessage).toBeUndefined();
  });

  it('cancels setup and migration work when a guild is disconnected', async () => {
    const t = makeTestConvex();
    const previousApiSecret = process.env.CONVEX_API_SECRET;
    process.env.CONVEX_API_SECRET = API_SECRET;
    try {
      const authUserId = 'auth-disconnect-cancel-work';
      const discordGuildId = 'guild-disconnect-cancel-work';
      const guildLinkId = await seedGuildLink(t, { authUserId, discordGuildId });
      await seedProviderConnection(t, authUserId);

      const { setupJobId } = await t.mutation(api.setupJobs.createOrResumeSetupJobForOwner, {
        apiSecret: API_SECRET,
        authUserId,
        guildLinkId,
        mode: 'automatic_setup',
        triggerSource: 'dashboard',
      });
      await t.mutation(api.setupJobs.applyRecommendedSetupForOwnerByGuild, {
        apiSecret: API_SECRET,
        authUserId,
        guildId: discordGuildId,
      });
      const { migrationJobId } = await t.mutation(api.setupJobs.createMigrationJobForOwner, {
        apiSecret: API_SECRET,
        authUserId,
        guildLinkId,
        setupJobId,
        mode: 'adopt_existing_roles',
      });

      const result = await t.mutation(api.guildLinks.hardDisconnectGuild, {
        apiSecret: API_SECRET,
        authUserId,
        discordGuildId,
      });

      expect(result).toEqual({ success: true });

      const { guildLink, setupJob, migrationJob, remainingJobs } = await t.run(async (ctx) => {
        const guildLink = await ctx.db
          .query('guild_links')
          .withIndex('by_discord_guild', (q) => q.eq('discordGuildId', discordGuildId))
          .first();
        const setupJob = await ctx.db.get(setupJobId);
        const migrationJob = await ctx.db.get(migrationJobId);
        const remainingJobs = await ctx.db
          .query('outbox_jobs')
          .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
          .collect();
        return { guildLink, setupJob, migrationJob, remainingJobs };
      });

      expect(guildLink).toBeNull();
      expect(setupJob?.status).toBe('cancelled');
      expect(migrationJob?.status).toBe('cancelled');
      expect(
        remainingJobs.find((job) =>
          ['setup_apply', 'setup_generate_plan', 'migration_analyze'].includes(job.jobType)
        )
      ).toBeUndefined();
    } finally {
      process.env.CONVEX_API_SECRET = previousApiSecret;
    }
  });

  it('preserves failed setup and migration jobs when a guild is disconnected', async () => {
    const t = makeTestConvex();
    const previousApiSecret = process.env.CONVEX_API_SECRET;
    process.env.CONVEX_API_SECRET = API_SECRET;
    try {
      const authUserId = 'auth-disconnect-preserve-failed';
      const discordGuildId = 'guild-disconnect-preserve-failed';
      const guildLinkId = await seedGuildLink(t, { authUserId, discordGuildId });

      const { setupJobId } = await t.mutation(api.setupJobs.createOrResumeSetupJobForOwner, {
        apiSecret: API_SECRET,
        authUserId,
        guildLinkId,
        mode: 'automatic_setup',
        triggerSource: 'dashboard',
      });
      const { migrationJobId } = await t.mutation(api.setupJobs.createMigrationJobForOwner, {
        apiSecret: API_SECRET,
        authUserId,
        guildLinkId,
        setupJobId,
        mode: 'adopt_existing_roles',
      });

      await t.run(async (ctx) => {
        const now = Date.now();
        await ctx.db.patch(setupJobId, {
          status: 'failed',
          currentPhase: 'apply_setup',
          blockingReason: 'Setup apply failed.',
          updatedAt: now,
        });
        await ctx.db.patch(migrationJobId, {
          status: 'failed',
          currentPhase: 'analyze',
          blockingReason: 'Migration analysis failed.',
          updatedAt: now,
        });
      });

      const result = await t.mutation(api.guildLinks.hardDisconnectGuild, {
        apiSecret: API_SECRET,
        authUserId,
        discordGuildId,
      });

      const { setupJob, migrationJob } = await t.run(async (ctx) => {
        const setupJob = await ctx.db.get(setupJobId);
        const migrationJob = await ctx.db.get(migrationJobId);
        return { setupJob, migrationJob };
      });

      expect(result).toEqual({ success: true });
      expect(setupJob?.status).toBe('failed');
      expect(migrationJob?.status).toBe('failed');
    } finally {
      process.env.CONVEX_API_SECRET = previousApiSecret;
    }
  });
});
