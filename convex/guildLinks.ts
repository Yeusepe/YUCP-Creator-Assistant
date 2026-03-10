/**
 * Guild Links - Convex functions for Discord guild installation state
 *
 * All functions require CONVEX_API_SECRET for API-to-Convex calls.
 * Called by the API server after validating creator session.
 */

import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';

const GuildLinkStatus = v.union(
  v.literal('active'),
  v.literal('uninstalled'),
  v.literal('suspended'),
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
    tenantId: v.id('tenants'),
    discordGuildId: v.string(),
    installedByAuthUserId: v.string(),
    botPresent: v.boolean(),
    status: GuildLinkStatus,
    commandScopeState: v.optional(
      v.object({
        registered: v.boolean(),
        registeredAt: v.optional(v.number()),
      }),
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
      await ctx.db.patch(existing._id, {
        tenantId: args.tenantId,
        installedByAuthUserId: args.installedByAuthUserId,
        botPresent: args.botPresent,
        status: args.status,
        commandScopeState: args.commandScopeState,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert('guild_links', {
      tenantId: args.tenantId,
      discordGuildId: args.discordGuildId,
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
 */
export const updateGuildLinkStatus = mutation({
  args: {
    apiSecret: v.string(),
    discordGuildId: v.string(),
    status: GuildLinkStatus,
    botPresent: v.boolean(),
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

    await ctx.db.patch(link._id, {
      status: args.status,
      botPresent: args.botPresent,
      updatedAt: now,
    });

    return { updated: true };
  },
});

/**
 * Get guild link for bot command handling. Returns tenantId and guildLinkId when guild is active.
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
    return { tenantId: link.tenantId, guildLinkId: link._id };
  },
});

/**
 * Get guild link with tenant for ownership check. API calls this before uninstall.
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

    const tenant = await ctx.db.get(link.tenantId);
    if (!tenant) return null;

    return {
      guildLinkId: link._id,
      tenantId: link.tenantId,
      ownerAuthUserId: tenant.ownerAuthUserId,
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
    const tenants = await ctx.db
      .query('tenants')
      .withIndex('by_owner_auth', (q) => q.eq('ownerAuthUserId', args.authUserId))
      .collect();
      
    const guilds = [];
    for (const tenant of tenants) {
      const links = await ctx.db
        .query('guild_links')
        .withIndex('by_tenant', (q) => q.eq('tenantId', tenant._id))
        .filter((q) => q.eq(q.field('status'), 'active'))
        .collect();
        
      for (const link of links) {
        guilds.push({
          tenantId: tenant._id,
          guildId: link.discordGuildId,
          name: link.discordGuildName || tenant.name,
          icon: null
        });
      }
    }
    return guilds;
  },
});
