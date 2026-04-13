/**
 * Subject Queries
 *
 * Query functions for looking up subjects (canonical user identities) in YUCP.
 * Subjects are platform-level entities that span all tenants.
 */

import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import {
  type ExternalAccountIdentityCandidate,
  selectCanonicalExternalAccountCandidates,
} from './lib/externalAccountIdentity';
import { ProviderV } from './lib/providers';

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

const BuyerProviderLinkSummaryV = v.object({
  id: v.id('buyer_provider_links'),
  provider: ProviderV,
  externalAccountId: v.id('external_accounts'),
  providerUserId: v.string(),
  providerUsername: v.optional(v.string()),
  label: v.string(),
  verificationMethod: v.optional(v.string()),
  status: v.union(v.literal('active'), v.literal('expired')),
  linkedAt: v.number(),
  lastValidatedAt: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function resolveBuyerProviderLinkStatus(
  link: Doc<'buyer_provider_links'>,
  externalAccount: Pick<Doc<'external_accounts'>, 'status'> | null
): 'active' | 'expired' | 'revoked' {
  if (link.status === 'revoked') {
    return 'revoked';
  }
  if (!externalAccount || externalAccount.status !== 'active') {
    return 'expired';
  }
  if (link.status === 'expired') {
    return 'expired';
  }
  if (link.expiresAt != null && link.expiresAt <= Date.now()) {
    return 'expired';
  }
  return 'active';
}

function formatBuyerProviderLinkLabel(
  account: Pick<Doc<'external_accounts'>, 'providerUserId' | 'providerUsername'>
) {
  return account.providerUsername?.trim() || account.providerUserId;
}

export async function upsertBuyerProviderLinkRecord(
  ctx: Pick<MutationCtx, 'db'>,
  args: {
    subjectId: Id<'subjects'>;
    provider: Doc<'buyer_provider_links'>['provider'];
    externalAccountId: Id<'external_accounts'>;
    verificationMethod?: string;
    verificationSessionId?: Id<'verification_sessions'>;
    expiresAt?: number;
  }
): Promise<Id<'buyer_provider_links'>> {
  const externalAccount = await ctx.db.get(args.externalAccountId);
  if (!externalAccount) {
    throw new Error(`External account not found: ${args.externalAccountId}`);
  }
  if (externalAccount.provider !== args.provider) {
    throw new Error('Buyer provider link provider does not match external account provider');
  }

  const now = Date.now();
  const existing = await ctx.db
    .query('buyer_provider_links')
    .withIndex('by_subject_external', (q) =>
      q.eq('subjectId', args.subjectId).eq('externalAccountId', args.externalAccountId)
    )
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      provider: args.provider,
      verificationMethod: args.verificationMethod ?? existing.verificationMethod,
      verificationSessionId: args.verificationSessionId ?? existing.verificationSessionId,
      status: 'active',
      linkedAt: existing.linkedAt ?? now,
      lastValidatedAt: now,
      expiresAt: args.expiresAt,
      updatedAt: now,
    });
    return existing._id;
  }

  return await ctx.db.insert('buyer_provider_links', {
    subjectId: args.subjectId,
    provider: args.provider,
    externalAccountId: args.externalAccountId,
    verificationMethod: args.verificationMethod,
    verificationSessionId: args.verificationSessionId,
    status: 'active',
    linkedAt: now,
    lastValidatedAt: now,
    expiresAt: args.expiresAt,
    createdAt: now,
    updatedAt: now,
  });
}

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
                  // c87: Strip email and rawData, they are not needed by callers
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
 * Internal only, exposes a global enumeration oracle if public.
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
    requireApiSecret(args.apiSecret);
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
 * Internal only, exposes a global enumeration oracle if public.
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

export const listBuyerProviderLinksForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.array(BuyerProviderLinkSummaryV),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const subjects = await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    if (subjects.length === 0) {
      return [];
    }

    const candidates: Array<
      ExternalAccountIdentityCandidate & {
        value: {
          id: Id<'buyer_provider_links'>;
          provider: string;
          externalAccountId: Id<'external_accounts'>;
          providerUserId: string;
          providerUsername?: string;
          label: string;
          verificationMethod?: string;
          status: 'active' | 'expired';
          linkedAt: number;
          lastValidatedAt?: number;
          expiresAt?: number;
          createdAt: number;
          updatedAt: number;
        };
      }
    > = [];

    for (const subject of subjects) {
      const links = await ctx.db
        .query('buyer_provider_links')
        .withIndex('by_subject', (q) => q.eq('subjectId', subject._id))
        .collect();

      for (const link of links) {
        const externalAccount = await ctx.db.get(link.externalAccountId);
        const status = resolveBuyerProviderLinkStatus(link, externalAccount);
        if (!externalAccount || status === 'revoked') {
          continue;
        }

        candidates.push({
          bindingCreatedAt: link.linkedAt ?? link.createdAt,
          bindingId: String(link._id),
          externalAccountCreatedAt: externalAccount.createdAt ?? externalAccount._creationTime,
          externalAccountCreationTime: externalAccount._creationTime,
          externalAccountId: String(externalAccount._id),
          provider: link.provider,
          providerUserId: externalAccount.providerUserId,
          value: {
            id: link._id,
            provider: link.provider,
            externalAccountId: link.externalAccountId,
            providerUserId: externalAccount.providerUserId,
            providerUsername: externalAccount.providerUsername,
            label: formatBuyerProviderLinkLabel(externalAccount),
            verificationMethod: link.verificationMethod,
            status,
            linkedAt: link.linkedAt,
            lastValidatedAt: link.lastValidatedAt,
            expiresAt: link.expiresAt,
            createdAt: link.createdAt,
            updatedAt: link.updatedAt,
          },
        });
      }
    }

    return selectCanonicalExternalAccountCandidates(candidates)
      .map((candidate) => candidate.value)
      .sort((a, b) => b.linkedAt - a.linkedAt);
  },
});

export const reconcileBuyerProviderLinksForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.object({
    reconciledCount: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const subjects = await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    let reconciledCount = 0;

    for (const subject of subjects) {
      const bindings = await ctx.db
        .query('bindings')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', args.authUserId).eq('subjectId', subject._id)
        )
        .collect();

      for (const binding of bindings) {
        if (binding.bindingType !== 'verification' || binding.status !== 'active') {
          continue;
        }

        const externalAccount = await ctx.db.get(binding.externalAccountId);
        if (!externalAccount || externalAccount.status !== 'active') {
          continue;
        }

        const existingLink = await ctx.db
          .query('buyer_provider_links')
          .withIndex('by_subject_external', (q) =>
            q.eq('subjectId', subject._id).eq('externalAccountId', binding.externalAccountId)
          )
          .first();
        if (existingLink && existingLink.status !== 'revoked') {
          continue;
        }

        await upsertBuyerProviderLinkRecord(ctx, {
          subjectId: subject._id,
          provider: externalAccount.provider,
          externalAccountId: externalAccount._id,
          verificationMethod: 'account_link',
        });
        reconciledCount += 1;
      }
    }

    return { reconciledCount };
  },
});

export const getBuyerProviderLinkForSubject = internalQuery({
  args: {
    subjectId: v.id('subjects'),
    provider: ProviderV,
  },
  returns: v.union(BuyerProviderLinkSummaryV, v.null()),
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query('buyer_provider_links')
      .withIndex('by_subject_provider', (q) =>
        q.eq('subjectId', args.subjectId).eq('provider', args.provider)
      )
      .collect();

    const sortedLinks = links.sort((a, b) => b.linkedAt - a.linkedAt);
    let expiredCandidate: {
      id: Id<'buyer_provider_links'>;
      provider: string;
      externalAccountId: Id<'external_accounts'>;
      providerUserId: string;
      providerUsername?: string;
      label: string;
      verificationMethod?: string;
      status: 'active' | 'expired';
      linkedAt: number;
      lastValidatedAt?: number;
      expiresAt?: number;
      createdAt: number;
      updatedAt: number;
    } | null = null;

    for (const link of sortedLinks) {
      const externalAccount = await ctx.db.get(link.externalAccountId);
      const status = resolveBuyerProviderLinkStatus(link, externalAccount);
      if (!externalAccount || status === 'revoked') {
        continue;
      }

      const summary = {
        id: link._id,
        provider: link.provider,
        externalAccountId: link.externalAccountId,
        providerUserId: externalAccount.providerUserId,
        providerUsername: externalAccount.providerUsername,
        label: formatBuyerProviderLinkLabel(externalAccount),
        verificationMethod: link.verificationMethod,
        status,
        linkedAt: link.linkedAt,
        lastValidatedAt: link.lastValidatedAt,
        expiresAt: link.expiresAt,
        createdAt: link.createdAt,
        updatedAt: link.updatedAt,
      };

      if (status === 'active') {
        return summary;
      }

      expiredCandidate ??= summary;
    }

    return expiredCandidate;
  },
});

export const upsertBuyerProviderLink = mutation({
  args: {
    apiSecret: v.string(),
    subjectId: v.id('subjects'),
    provider: ProviderV,
    externalAccountId: v.id('external_accounts'),
    verificationMethod: v.optional(v.string()),
    verificationSessionId: v.optional(v.id('verification_sessions')),
    expiresAt: v.optional(v.number()),
  },
  returns: v.id('buyer_provider_links'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await upsertBuyerProviderLinkRecord(ctx, args);
  },
});

/**
 * Returns just the emailHash for an external account, used during buyer purchase verification
 * to locate purchase_facts without exposing the full account record.
 */
export const getExternalAccountEmailHash = internalQuery({
  args: {
    externalAccountId: v.id('external_accounts'),
  },
  returns: v.union(v.object({ emailHash: v.optional(v.string()) }), v.null()),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.externalAccountId);
    if (!account) return null;
    return { emailHash: account.emailHash };
  },
});

export const revokeBuyerProviderLink = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    linkId: v.id('buyer_provider_links'),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const link = await ctx.db.get(args.linkId);
    if (!link) {
      return { success: false };
    }

    const subject = await ctx.db.get(link.subjectId);
    if (!subject || subject.authUserId !== args.authUserId) {
      return { success: false };
    }

    await ctx.db.patch(link._id, {
      status: 'revoked',
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

export const markBuyerProviderLinkExpired = internalMutation({
  args: {
    linkId: v.id('buyer_provider_links'),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) {
      return { success: false };
    }

    const now = Date.now();
    await ctx.db.patch(args.linkId, {
      status: 'expired',
      lastValidatedAt: now,
      expiresAt: now,
      updatedAt: now,
    });

    return { success: true };
  },
});
