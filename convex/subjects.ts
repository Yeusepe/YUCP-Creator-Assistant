/**
 * Subject Queries
 *
 * Query functions for looking up subjects (canonical user identities) in YUCP.
 * Subjects are platform-level entities that span all tenants.
 */

import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { Doc } from './_generated/dataModel';

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get a subject by their Better Auth user ID.
 * Used when syncing from Better Auth to find existing subjects.
 */
export const getSubjectByAuthId = query({
  args: {
    authUserId: v.string(),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      subject: v.object({
        _id: v.id('subjects'),
        _creationTime: v.number(),
        primaryDiscordUserId: v.string(),
        authUserId: v.optional(v.string()),
        status: v.union(
          v.literal('active'),
          v.literal('suspended'),
          v.literal('quarantined'),
          v.literal('deleted'),
        ),
        displayName: v.optional(v.string()),
        avatarUrl: v.optional(v.string()),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
    }),
    v.object({
      found: v.literal(false),
      subject: v.null(),
    }),
  ),
  handler: async (ctx, args) => {
    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (!subject) {
      return { found: false as const, subject: null };
    }

    return { found: true as const, subject };
  },
});

/**
 * Get a subject by their primary Discord user ID.
 * Used for Discord-based lookups and verification.
 */
export const getSubjectByDiscordId = query({
  args: {
    discordUserId: v.string(),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      subject: v.object({
        _id: v.id('subjects'),
        _creationTime: v.number(),
        primaryDiscordUserId: v.string(),
        authUserId: v.optional(v.string()),
        status: v.union(
          v.literal('active'),
          v.literal('suspended'),
          v.literal('quarantined'),
          v.literal('deleted'),
        ),
        displayName: v.optional(v.string()),
        avatarUrl: v.optional(v.string()),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
    }),
    v.object({
      found: v.literal(false),
      subject: v.null(),
    }),
  ),
  handler: async (ctx, args) => {
    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .first();

    if (!subject) {
      return { found: false as const, subject: null };
    }

    return { found: true as const, subject };
  },
});

/**
 * Get a subject with all their linked external accounts.
 * Useful for profile views and account management.
 */
export const getSubjectWithAccounts = query({
  args: {
    subjectId: v.id('subjects'),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      subject: v.object({
        _id: v.id('subjects'),
        _creationTime: v.number(),
        primaryDiscordUserId: v.string(),
        authUserId: v.optional(v.string()),
        status: v.union(
          v.literal('active'),
          v.literal('suspended'),
          v.literal('quarantined'),
          v.literal('deleted'),
        ),
        displayName: v.optional(v.string()),
        avatarUrl: v.optional(v.string()),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
      externalAccounts: v.array(
        v.object({
          _id: v.id('external_accounts'),
          _creationTime: v.number(),
          provider: v.union(
            v.literal('discord'),
            v.literal('gumroad'),
            v.literal('jinxxy'),
            v.literal('manual'),
          ),
          providerUserId: v.string(),
          providerUsername: v.optional(v.string()),
          providerMetadata: v.optional(
            v.object({
              email: v.optional(v.string()),
              avatarUrl: v.optional(v.string()),
              profileUrl: v.optional(v.string()),
              rawData: v.optional(v.any()),
            }),
          ),
          lastValidatedAt: v.optional(v.number()),
          status: v.union(
            v.literal('active'),
            v.literal('disconnected'),
            v.literal('revoked'),
          ),
          createdAt: v.number(),
          updatedAt: v.number(),
        }),
      ),
    }),
    v.object({
      found: v.literal(false),
      subject: v.null(),
      externalAccounts: v.array(v.any()),
    }),
  ),
  handler: async (ctx, args) => {
    const subject = await ctx.db.get(args.subjectId);

    if (!subject) {
      return { found: false as const, subject: null, externalAccounts: [] };
    }

    // Get Discord external accounts for this subject's Discord ID
    // Note: by_provider_user is a compound index, so we use filter
    const discordAccounts = await ctx.db
      .query('external_accounts')
      .withIndex('by_provider', (q) => q.eq('provider', 'discord'))
      .filter((q) => q.eq(q.field('providerUserId'), subject.primaryDiscordUserId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    return {
      found: true as const,
      subject,
      externalAccounts: discordAccounts,
    };
  },
});

/**
 * Check if a subject exists with the given Discord ID.
 * Lightweight check for validation purposes.
 */
export const subjectExistsByDiscordId = query({
  args: {
    discordUserId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .first();

    return subject !== null;
  },
});

/**
 * Ensure a subject exists for a Discord user. Creates one if not found.
 * Used by bot when user verifies without prior auth (e.g. license key flow).
 * Requires apiSecret.
 */
export const ensureSubjectForDiscord = mutation({
  args: {
    apiSecret: v.string(),
    discordUserId: v.string(),
    displayName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
  },
  returns: v.object({
    subjectId: v.id('subjects'),
    isNew: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (process.env.CONVEX_API_SECRET !== args.apiSecret) {
      throw new Error('Unauthorized');
    }
    const existing = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .first();
    if (existing) {
      return { subjectId: existing._id, isNew: false };
    }
    const now = Date.now();
    const id = await ctx.db.insert('subjects', {
      primaryDiscordUserId: args.discordUserId,
      status: 'active',
      displayName: args.displayName,
      avatarUrl: args.avatarUrl,
      createdAt: now,
      updatedAt: now,
    });
    return { subjectId: id, isNew: true };
  },
});

/**
 * Get subject ID by Discord user ID.
 * Returns just the ID for efficient lookups.
 */
export const getSubjectIdByDiscordId = query({
  args: {
    discordUserId: v.string(),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      subjectId: v.id('subjects'),
    }),
    v.object({
      found: v.literal(false),
      subjectId: v.null(),
    }),
  ),
  handler: async (ctx, args) => {
    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .first();

    if (!subject) {
      return { found: false as const, subjectId: null };
    }

    return { found: true as const, subjectId: subject._id };
  },
});
