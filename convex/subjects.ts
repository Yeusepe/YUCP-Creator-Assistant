/**
 * Subject Queries
 *
 * Query functions for looking up subjects (canonical user identities) in YUCP.
 * Subjects are platform-level entities that span all tenants.
 */

import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { Doc } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import {
  type ExternalAccountIdentityCandidate,
  selectCanonicalExternalAccountCandidates,
} from './lib/externalAccountIdentity';
import { ProviderV } from './lib/providers';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

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
    tenantId: v.id('tenants'),
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

    if ('subjectId' in selector) {
      const subject = await ctx.db.get(selector.subjectId);
      return subject ? { found: true as const, subject } : { found: false as const, subject: null };
    }

    if ('authUserId' in selector) {
      const subject = await ctx.db
        .query('subjects')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', selector.authUserId))
        .first();
      return subject ? { found: true as const, subject } : { found: false as const, subject: null };
    }

    if ('discordUserId' in selector) {
      const subject = await ctx.db
        .query('subjects')
        .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', selector.discordUserId))
        .first();
      return subject ? { found: true as const, subject } : { found: false as const, subject: null };
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
      .withIndex('by_tenant_external', (q) =>
        q.eq('tenantId', args.tenantId).eq('externalAccountId', account._id)
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
    /** When provided, only return accounts linked in this tenant (for verify panel). */
    tenantId: v.optional(v.id('tenants')),
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
              email: v.optional(v.string()),
              avatarUrl: v.optional(v.string()),
              profileUrl: v.optional(v.string()),
              rawData: v.optional(v.any()),
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
    // When tenantId is provided (e.g. from verify panel), only return accounts in that tenant.
    const bindingsQuery = ctx.db
      .query('bindings')
      .withIndex('by_subject', (q) => q.eq('subjectId', args.subjectId))
      .filter((q) => q.eq(q.field('status'), 'active'));

    const activeBindings = args.tenantId
      ? (await bindingsQuery.collect()).filter((b) => b.tenantId === args.tenantId)
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
            providerMetadata: account.providerMetadata,
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
