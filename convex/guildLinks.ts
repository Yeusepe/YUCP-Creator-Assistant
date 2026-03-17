/**
 * Guild Links - Convex functions for Discord guild installation state
 *
 * All functions require CONVEX_API_SECRET for API-to-Convex calls.
 * Called by the API server after validating creator session.
 */

import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';

const GuildLinkStatus = v.union(
  v.literal('active'),
  v.literal('uninstalled'),
  v.literal('suspended')
);

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

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
    const profiles = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    const guilds = [];
    for (const profile of profiles) {
      const links = await ctx.db
        .query('guild_links')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', profile.authUserId))
        .filter((q) => q.eq(q.field('status'), 'active'))
        .collect();

      for (const link of links) {
        guilds.push({
          authUserId: profile.authUserId,
          guildId: link.discordGuildId,
          name: link.discordGuildName || profile.name,
          icon: link.discordGuildIcon ?? null,
        });
      }
    }
    return guilds;
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
