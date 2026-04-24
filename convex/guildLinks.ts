/**
 * Guild Links - Convex functions for Discord guild installation state
 *
 * All functions require CONVEX_API_SECRET for API-to-Convex calls.
 * Called by the API server after validating creator session.
 */

import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';

const GuildLinkStatus = v.union(
  v.literal('active'),
  v.literal('uninstalled'),
  v.literal('suspended')
);

const VerifyPromptMessage = v.object({
  channelId: v.string(),
  messageId: v.string(),
  titleOverride: v.optional(v.string()),
  descriptionOverride: v.optional(v.string()),
  buttonTextOverride: v.optional(v.string()),
  color: v.optional(v.number()),
  imageUrl: v.optional(v.string()),
  updatedAt: v.number(),
});

/**
 * Upsert a guild link. Called by API after bot install callback.
 */
export const upsertGuildLink = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    discordGuildId: v.string(),
    discordGuildName: v.optional(v.string()),
    discordGuildIcon: v.optional(v.string()),
    installedByAuthUserId: v.string(),
    botPresent: v.boolean(),
    status: GuildLinkStatus,
    commandScopeState: v.optional(
      v.object({
        registered: v.boolean(),
        registeredAt: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('guild_links')
      .withIndex('by_discord_guild', (q) => q.eq('discordGuildId', args.discordGuildId))
      .first();

    if (existing) {
      const patch: Record<string, unknown> = {
        authUserId: args.authUserId,
        installedByAuthUserId: args.installedByAuthUserId,
        botPresent: args.botPresent,
        status: args.status,
        commandScopeState: args.commandScopeState,
        updatedAt: now,
      };
      if (existing.authUserId && existing.authUserId !== args.authUserId) {
        throw new ConvexError('Unauthorized: guild link owned by different user');
      }
      if (args.discordGuildName !== undefined) patch.discordGuildName = args.discordGuildName;
      if (args.discordGuildIcon !== undefined) patch.discordGuildIcon = args.discordGuildIcon;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert('guild_links', {
      authUserId: args.authUserId,
      discordGuildId: args.discordGuildId,
      discordGuildName: args.discordGuildName,
      discordGuildIcon: args.discordGuildIcon,
      installedByAuthUserId: args.installedByAuthUserId,
      botPresent: args.botPresent,
      status: args.status,
      commandScopeState: args.commandScopeState,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Update guild link status. Called by API for uninstall/health.
 * Optionally syncs discordGuildName and discordGuildIcon when available.
 */
export const updateGuildLinkStatus = mutation({
  args: {
    apiSecret: v.string(),
    discordGuildId: v.string(),
    status: GuildLinkStatus,
    botPresent: v.boolean(),
    discordGuildName: v.optional(v.string()),
    discordGuildIcon: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const link = await ctx.db
      .query('guild_links')
      .withIndex('by_discord_guild', (q) => q.eq('discordGuildId', args.discordGuildId))
      .first();

    if (!link) {
      return { updated: false };
    }

    const patch: Record<string, unknown> = {
      status: args.status,
      botPresent: args.botPresent,
      updatedAt: now,
    };
    if (args.discordGuildName !== undefined) patch.discordGuildName = args.discordGuildName;
    if (args.discordGuildIcon !== undefined) patch.discordGuildIcon = args.discordGuildIcon;

    await ctx.db.patch(link._id, patch);

    return { updated: true };
  },
});

/**
 * Get guild link for bot command handling. Returns authUserId and guildLinkId when guild is active.
 */
export const getByDiscordGuildForBot = query({
  args: {
    apiSecret: v.string(),
    discordGuildId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const link = await ctx.db
      .query('guild_links')
      .withIndex('by_discord_guild', (q) => q.eq('discordGuildId', args.discordGuildId))
      .first();
    if (!link || link.status !== 'active') return null;
    return { authUserId: link.authUserId, guildLinkId: link._id };
  },
});

export const getVerifyPromptMessageForOwner = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildLinkId: v.id('guild_links'),
  },
  returns: v.union(
    v.null(),
    v.object({
      guildId: v.string(),
      verifyPromptMessage: v.optional(VerifyPromptMessage),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const link = await ctx.db.get(args.guildLinkId);
    if (!link) return null;
    if (link.authUserId !== args.authUserId) {
      throw new ConvexError('Unauthorized: not the owner');
    }

    return {
      guildId: link.discordGuildId,
      verifyPromptMessage: link.verifyPromptMessage,
    };
  },
});

export const getVerifyPromptMessageForBot = query({
  args: {
    apiSecret: v.string(),
    guildLinkId: v.id('guild_links'),
  },
  returns: v.union(
    v.null(),
    v.object({
      authUserId: v.string(),
      guildId: v.string(),
      verifyPromptMessage: v.optional(VerifyPromptMessage),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const link = await ctx.db.get(args.guildLinkId);
    if (!link || link.status !== 'active') return null;

    return {
      authUserId: link.authUserId,
      guildId: link.discordGuildId,
      verifyPromptMessage: link.verifyPromptMessage,
    };
  },
});

/**
 * Get guild link with creator profile for ownership check. API calls this before uninstall.
 */
export const getGuildLinkForUninstall = query({
  args: {
    apiSecret: v.string(),
    discordGuildId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const link = await ctx.db
      .query('guild_links')
      .withIndex('by_discord_guild', (q) => q.eq('discordGuildId', args.discordGuildId))
      .first();

    if (!link) return null;

    return {
      guildLinkId: link._id,
      authUserId: link.authUserId,
      status: link.status,
    };
  },
});

/**
 * Get all active guild links for a user (servers they manage)
 */
export const getUserGuilds = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    const links = await ctx.db
      .query('guild_links')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    return links.map((link) => ({
      authUserId: args.authUserId,
      guildId: link.discordGuildId,
      name: link.discordGuildName || profile?.name || 'Creator Server',
      icon: link.discordGuildIcon ?? null,
    }));
  },
});

export const saveVerifyPromptMessage = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildLinkId: v.id('guild_links'),
    channelId: v.string(),
    messageId: v.string(),
    titleOverride: v.optional(v.string()),
    descriptionOverride: v.optional(v.string()),
    buttonTextOverride: v.optional(v.string()),
    color: v.optional(v.number()),
    imageUrl: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const link = await ctx.db.get(args.guildLinkId);
    if (!link) {
      throw new ConvexError('Guild link not found');
    }
    if (link.authUserId !== args.authUserId) {
      throw new ConvexError('Unauthorized: not the owner');
    }

    await ctx.db.patch(args.guildLinkId, {
      verifyPromptMessage: {
        channelId: args.channelId,
        messageId: args.messageId,
        titleOverride: args.titleOverride,
        descriptionOverride: args.descriptionOverride,
        buttonTextOverride: args.buttonTextOverride,
        color: args.color,
        imageUrl: args.imageUrl,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

export const clearVerifyPromptMessage = mutation({
  args: {
    apiSecret: v.string(),
    guildLinkId: v.id('guild_links'),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const link = await ctx.db.get(args.guildLinkId);
    if (!link) {
      return { success: false };
    }

    await ctx.db.patch(args.guildLinkId, {
      verifyPromptMessage: undefined,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Completely wipe a guild link and all associated data. Called by bot on /creator-admin settings disconnect.
 * Danger: Irreversible deletion of role rules, download routes, download artifacts, and the guild link itself.
 */
export const hardDisconnectGuild = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    discordGuildId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const link = await ctx.db
      .query('guild_links')
      .withIndex('by_discord_guild', (q) => q.eq('discordGuildId', args.discordGuildId))
      .first();

    if (!link) {
      return { success: false, reason: 'guild_link_not_found' };
    }

    if (link.authUserId !== args.authUserId) {
      throw new ConvexError('Unauthorized: not the owner');
    }

    const guildId = args.discordGuildId;

    // Delete all role_rules for this guild
    const roleRules = await ctx.db
      .query('role_rules')
      .withIndex('by_guild_link', (q) => q.eq('guildLinkId', link._id))
      .collect();
    for (const rule of roleRules) {
      await ctx.db.delete(rule._id);
    }

    // Delete all download_routes for this guild
    const downloadRoutes = await ctx.db
      .query('download_routes')
      .withIndex('by_guild_link', (q) => q.eq('guildLinkId', link._id))
      .collect();
    for (const route of downloadRoutes) {
      await ctx.db.delete(route._id);
    }

    // Delete all download_artifacts for this guild
    const downloadArtifacts = await ctx.db
      .query('download_artifacts')
      .withIndex('by_auth_user_guild', (q) =>
        q.eq('authUserId', link.authUserId).eq('guildId', guildId)
      )
      .collect();
    for (const artifact of downloadArtifacts) {
      await ctx.db.delete(artifact._id);
    }

    const now = Date.now();

    // Cancel any non-terminal setup_jobs for this guild so the setup page
    // shows a fresh 'new' state after the creator reconnects the server.
    const setupJobs = await ctx.db
      .query('setup_jobs')
      .withIndex('by_auth_user_guild', (q) =>
        q.eq('authUserId', link.authUserId).eq('discordGuildId', guildId)
      )
      .collect();
    for (const setupJob of setupJobs) {
      if (
        setupJob.status !== 'completed' &&
        setupJob.status !== 'failed' &&
        setupJob.status !== 'cancelled'
      ) {
        await ctx.db.patch(setupJob._id, {
          status: 'cancelled',
          cancelledAt: now,
          updatedAt: now,
        });
      }
    }

    const migrationJobs = (
      await ctx.db
        .query('migration_jobs')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', link.authUserId))
        .collect()
    ).filter((migrationJob) => migrationJob.discordGuildId === guildId);
    for (const migrationJob of migrationJobs) {
      if (
        migrationJob.status !== 'completed' &&
        migrationJob.status !== 'failed' &&
        migrationJob.status !== 'cancelled'
      ) {
        await ctx.db.patch(migrationJob._id, {
          status: 'cancelled',
          cancelledAt: now,
          updatedAt: now,
        });
      }
    }

    const pendingSetupAndMigrationJobs = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', link.authUserId))
      .collect();
    for (const job of pendingSetupAndMigrationJobs) {
      if (
        job.status === 'pending' &&
        job.targetGuildId === guildId &&
        (job.jobType === 'setup_generate_plan' ||
          job.jobType === 'setup_apply' ||
          job.jobType === 'migration_analyze')
      ) {
        await ctx.db.delete(job._id);
      }
    }

    // Delete the guild_link itself
    await ctx.db.delete(link._id);

    return { success: true };
  },
});

/**
 * List all guild links for a creator with optional status filter.
 */
export const listByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('guild_links')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.status) {
      all = all.filter((g) => g.status === args.status);
    }
    return all;
  },
});

/**
 * Get a guild link by Discord guild ID, scoped to authUserId.
 */
export const getByGuildId = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const link = await ctx.db
      .query('guild_links')
      .withIndex('by_discord_guild', (q) => q.eq('discordGuildId', args.guildId))
      .first();
    if (!link || link.authUserId !== args.authUserId) return null;
    return link;
  },
});
