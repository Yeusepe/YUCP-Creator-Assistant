/**
 * Subject Queries
 *
 * Query functions for looking up subjects (canonical user identities) in YUCP.
 * Subjects are platform-level entities that span all tenants.
 */

import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalQuery, mutation, query } from './_generated/server';
import {
  type ExternalAccountIdentityCandidate,
  selectCanonicalExternalAccountCandidates,
} from './lib/externalAccountIdentity';
import { ProviderV } from './lib/providers';
import { requireApiSecret } from './lib/apiAuth';

export const PublicSubjectSelector = v.union(
  v.object({
    subjectId: v.id('subjects'),
  }),
  v.object({
    authUserId: v.string(),
  }),
  v.object({
    discordUserId: v.string(),
  }),
  v.object({
    externalAccount: v.object({
      provider: ProviderV,
      providerUserId: v.string(),
    }),
  })
);

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get a subject by their Better Auth user ID.
 * Used when syncing from Better Auth to find existing subjects.
 */
export const getSubjectByAuthId = query({
  args: {
    apiSecret: v.string(),
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
          v.literal('deleted')
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
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
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
    apiSecret: v.string(),
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
          v.literal('deleted')
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
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
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
 * Resolve a canonical subject for the public API.
 * External account selectors are tenant-aware and only resolve through active bindings.
 */
export const resolveSubjectForPublicApi = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    selector: PublicSubjectSelector,
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
          v.literal('deleted')
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
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const selector = args.selector as
      | { subjectId: Id<'subjects'> }
      | { authUserId: string }
      | { discordUserId: string }
      | {
          externalAccount: {
            provider: Doc<'external_accounts'>['provider'];
            providerUserId: string;
          };
        };

    /**
     * Checks whether the resolved subject has an active binding to the requesting creator.
     * All public-API selectors must be tenant-scoped to prevent cross-tenant subject enumeration.
     */
    async function hasTenantBinding(subjectId: Id<'subjects'>): Promise<boolean> {
      const binding = await ctx.db
        .query('bindings')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', args.authUserId).eq('subjectId', subjectId)
        )
        .filter((q) => q.eq(q.field('status'), 'active'))
        .first();
      return binding !== null;
    }

    if ('subjectId' in selector) {
      const subject = await ctx.db.get(selector.subjectId);
      if (!subject) return { found: false as const, subject: null };
      // Enforce tenant scope: only return the subject if this creator has an active binding.
      if (!(await hasTenantBinding(subject._id))) {
        return { found: false as const, subject: null };
      }
      return { found: true as const, subject };
    }

    if ('authUserId' in selector) {
      const subject = await ctx.db
        .query('subjects')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', selector.authUserId))
        .first();
      if (!subject) return { found: false as const, subject: null };
      // Enforce tenant scope: only return the subject if this creator has an active binding.
      if (!(await hasTenantBinding(subject._id))) {
        return { found: false as const, subject: null };
      }
      return { found: true as const, subject };
    }

    if ('discordUserId' in selector) {
      const subject = await ctx.db
        .query('subjects')
        .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', selector.discordUserId))
        .first();
      if (!subject) return { found: false as const, subject: null };
      // Enforce tenant scope: only return the subject if this creator has an active binding.
      if (!(await hasTenantBinding(subject._id))) {
        return { found: false as const, subject: null };
      }
      return { found: true as const, subject };
    }

    const account = await ctx.db
      .query('external_accounts')
      .withIndex('by_provider_user', (q) =>
        q
          .eq('provider', selector.externalAccount.provider)
          .eq('providerUserId', selector.externalAccount.providerUserId)
      )
      .first();

    if (!account) {
      return { found: false as const, subject: null };
    }

    const binding = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_external', (q) =>
        q.eq('authUserId', args.authUserId).eq('externalAccountId', account._id)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    if (!binding) {
      return { found: false as const, subject: null };
    }

    const subject = await ctx.db.get(binding.subjectId);
    return subject ? { found: true as const, subject } : { found: false as const, subject: null };
  },
});

/**
 * Get a subject with all their linked external accounts.
 * Useful for profile views and account management.
 */
export const getSubjectWithAccounts = query({
  args: {
    apiSecret: v.string(),
    subjectId: v.id('subjects'),
    /** When provided, only return accounts linked via this user (for verify panel). */
    authUserId: v.optional(v.string()),
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
          v.literal('deleted')
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
          provider: ProviderV,
          providerUserId: v.string(),
          providerUsername: v.optional(v.string()),
          providerMetadata: v.optional(
            v.object({
              avatarUrl: v.optional(v.string()),
              profileUrl: v.optional(v.string()),
            })
          ),
          lastValidatedAt: v.optional(v.number()),
          status: v.union(v.literal('active'), v.literal('disconnected'), v.literal('revoked')),
          createdAt: v.number(),
          updatedAt: v.number(),
        })
      ),
    }),
    v.object({
      found: v.literal(false),
      subject: v.null(),
      externalAccounts: v.array(v.any()),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const subject = await ctx.db.get(args.subjectId);

    if (!subject) {
      return { found: false as const, subject: null, externalAccounts: [] };
    }

    // Look up active external accounts linked to this subject via bindings.
    // When authUserId is provided (e.g. from verify panel), only return accounts for that user.
    const bindingsQuery = ctx.db
      .query('bindings')
      .withIndex('by_subject', (q) => q.eq('subjectId', args.subjectId))
      .filter((q) => q.eq(q.field('status'), 'active'));

    const activeBindings = args.authUserId
      ? (await bindingsQuery.collect()).filter((b) => b.authUserId === args.authUserId)
      : await bindingsQuery.collect();

    const externalAccountCandidates: Array<
      ExternalAccountIdentityCandidate & {
        value: {
          _id: Id<'external_accounts'>;
          _creationTime: number;
          provider: string;
          providerUserId: string;
          providerUsername?: string;
          providerMetadata?: {
            email?: string;
            avatarUrl?: string;
            profileUrl?: string;
            rawData?: any;
          };
          lastValidatedAt?: number;
          status: 'active' | 'disconnected' | 'revoked';
          createdAt: number;
          updatedAt: number;
        };
      }
    > = [];
    for (const binding of activeBindings) {
      const account = await ctx.db.get(binding.externalAccountId);
      if (account && account.status === 'active') {
        // Map to validator shape (exclude emailHash, normalizedEmail, etc.)
        externalAccountCandidates.push({
          bindingCreatedAt: binding.createdAt,
          bindingId: String(binding._id),
          externalAccountCreatedAt: account.createdAt,
          externalAccountCreationTime: account._creationTime,
          externalAccountId: String(account._id),
          provider: account.provider,
          providerUserId: account.providerUserId,
          value: {
            _id: account._id,
            _creationTime: account._creationTime,
            provider: account.provider,
            providerUserId: account.providerUserId,
            providerUsername: account.providerUsername,
            providerMetadata: account.providerMetadata
              ? {
                  // c87: Strip email and rawData — they are not needed by callers
                  // and increase breach surface. Use avatarUrl/profileUrl only.
                  avatarUrl: account.providerMetadata.avatarUrl,
                  profileUrl: account.providerMetadata.profileUrl,
                }
              : undefined,
            lastValidatedAt: account.lastValidatedAt,
            status: account.status,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
          },
        });
      }
    }

    const externalAccounts = selectCanonicalExternalAccountCandidates(
      externalAccountCandidates
    ).map((candidate) => candidate.value);

    return {
      found: true as const,
      subject,
      externalAccounts,
    };
  },
});

/**
 * Check if a subject exists with the given Discord ID.
 * Lightweight check for validation purposes.
 * Internal only — exposes a global enumeration oracle if public.
 */
export const subjectExistsByDiscordId = internalQuery({
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
 * List subjects by authUserId with optional status filter, text search, and pagination.
 */
export const listByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    status: v.optional(v.string()),
    q: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.status) {
      all = all.filter((s) => s.status === args.status);
    }
    if (args.q) {
      const q = args.q.toLowerCase();
      all = all.filter(
        (s) =>
          (s.displayName && s.displayName.toLowerCase().includes(q)) ||
          String(s._id).toLowerCase().includes(q) ||
          s.primaryDiscordUserId.includes(q)
      );
    }

    const limit = Math.min(args.limit ?? 50, 100);
    let startIndex = 0;
    if (args.cursor) {
      const idx = all.findIndex((item) => String(item._id) === args.cursor);
      if (idx !== -1) startIndex = idx + 1;
    }
    const data = all.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < all.length;
    return {
      data,
      hasMore,
      nextCursor: hasMore ? String(data[data.length - 1]._id) : null,
    };
  },
});

/**
 * Get subject ID by Discord user ID.
 * Returns just the ID for efficient lookups.
 * Internal only — exposes a global enumeration oracle if public.
 */
export const getSubjectIdByDiscordId = internalQuery({
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
    })
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
