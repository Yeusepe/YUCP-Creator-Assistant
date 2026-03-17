/**
 * Identity Sync Module
 *
 * Handles synchronization between Better Auth (Postgres) and Convex.
 * When users sign in via Better Auth Discord OAuth, this module ensures
 * their identity is properly reflected in Convex's subjects and external_accounts tables.
 *
 * Sync Flow:
 * 1. Better Auth creates/updates user in Postgres (handled by Better Auth)
 * 2. API calls syncUserFromAuth mutation after successful auth
 * 3. Convex creates/updates subject record
 * 4. Convex creates/updates external_account for Discord
 *
 * All operations are idempotent - safe to call multiple times.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalQuery, mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import { PII_PURPOSES } from './lib/credentialKeys';
import { encryptPii, normalizeAndEncryptEmail } from './lib/piiCrypto';

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Discord account data from Better Auth OAuth
 */
export const DiscordAccountData = v.object({
  discordUserId: v.string(),
  username: v.string(),
  discriminator: v.optional(v.string()),
  avatar: v.optional(v.string()),
  email: v.optional(v.string()),
});

/**
 * Result of syncing a user from Better Auth
 */
export const SyncResult = v.object({
  success: v.boolean(),
  subjectId: v.id('subjects'),
  externalAccountId: v.optional(v.id('external_accounts')),
  isNewSubject: v.boolean(),
  isNewExternalAccount: v.boolean(),
});

/**
 * Input for syncing a user from Better Auth
 */
export const SyncUserInput = v.object({
  authUserId: v.string(),
  discord: DiscordAccountData,
});

// ============================================================================
// EXPORTED HELPERS (for testing and reuse)
// ============================================================================

/** Build Discord CDN avatar URL from user ID and avatar hash */
export function buildDiscordAvatarUrl(
  discordUserId: string,
  avatarHash: string | undefined
): string | undefined {
  if (!avatarHash) return undefined;
  return `https://cdn.discordapp.com/avatars/${discordUserId}/${avatarHash}.png`;
}

/** Build full username with discriminator (legacy format) */
export function buildFullUsername(username: string, discriminator: string | undefined): string {
  if (discriminator && discriminator !== '0') {
    return `${username}#${discriminator}`;
  }
  return username;
}

/** Build Discord profile URL */
export function buildDiscordProfileUrl(discordUserId: string): string {
  return `https://discord.com/users/${discordUserId}`;
}

// ============================================================================
// INTERNAL QUERIES
// ============================================================================

/**
 * Internal query to find a subject by authUserId.
 * Used by sync operations to check for existing subjects.
 */
export const findSubjectByAuthId = internalQuery({
  args: {
    authUserId: v.string(),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      subjectId: v.id('subjects'),
      primaryDiscordUserId: v.string(),
    }),
    v.object({
      found: v.literal(false),
      subjectId: v.null(),
      primaryDiscordUserId: v.null(),
    })
  ),
  handler: async (ctx, args) => {
    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (!subject) {
      return { found: false as const, subjectId: null, primaryDiscordUserId: null };
    }

    return {
      found: true as const,
      subjectId: subject._id,
      primaryDiscordUserId: subject.primaryDiscordUserId,
    };
  },
});

/**
 * Internal query to find a subject by Discord user ID.
 * Used to detect account reconnection scenarios.
 */
export const findSubjectByDiscordId = internalQuery({
  args: {
    discordUserId: v.string(),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      subjectId: v.id('subjects'),
      authUserId: v.optional(v.string()),
    }),
    v.object({
      found: v.literal(false),
      subjectId: v.null(),
      authUserId: v.null(),
    })
  ),
  handler: async (ctx, args) => {
    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .first();

    if (!subject) {
      return { found: false as const, subjectId: null, authUserId: null };
    }

    return {
      found: true as const,
      subjectId: subject._id,
      authUserId: subject.authUserId,
    };
  },
});

/**
 * Find external account by provider and provider user ID.
 */
export const findExternalAccount = internalQuery({
  args: {
    provider: v.string(),
    providerUserId: v.string(),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      externalAccountId: v.id('external_accounts'),
      status: v.union(v.literal('active'), v.literal('disconnected'), v.literal('revoked')),
    }),
    v.object({
      found: v.literal(false),
      externalAccountId: v.null(),
      status: v.null(),
    })
  ),
  handler: async (ctx, args) => {
    const account = await ctx.db
      .query('external_accounts')
      .withIndex('by_provider_user', (q) =>
        q.eq('provider', args.provider).eq('providerUserId', args.providerUserId)
      )
      .first();

    if (!account) {
      return { found: false as const, externalAccountId: null, status: null };
    }

    return {
      found: true as const,
      externalAccountId: account._id,
      status: account.status,
    };
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Get or create a subject for a Discord user (retroactive sync).
 * Used when granting entitlements to users who have the source role but haven't verified yet.
 * Creates a minimal subject with primaryDiscordUserId only; authUserId remains unset until they sign in.
 */
export const getOrCreateSubjectForDiscordUser = mutation({
  args: {
    apiSecret: v.string(),
    discordUserId: v.string(),
    displayName: v.optional(v.string()),
  },
  returns: v.id('subjects'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .first();

    if (existing) {
      return existing._id;
    }

    return await ctx.db.insert('subjects', {
      primaryDiscordUserId: args.discordUserId,
      status: 'active',
      displayName: args.displayName,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Sync a user from Better Auth to Convex.
 *
 * This mutation:
 * 1. Creates a subject if one doesn't exist for this authUserId
 * 2. Updates the subject if it exists (handles user rename)
 * 3. Creates/updates external_account for Discord
 * 4. Handles account reconnection (same Discord ID, different authUserId)
 *
 * Idempotent: Safe to call multiple times with the same data.
 */
export const syncUserFromAuth = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    discord: v.object({
      discordUserId: v.string(),
      username: v.string(),
      discriminator: v.optional(v.string()),
      avatar: v.optional(v.string()),
      email: v.optional(v.string()),
    }),
  },
  returns: v.object({
    success: v.boolean(),
    subjectId: v.id('subjects'),
    externalAccountId: v.optional(v.id('external_accounts')),
    isNewSubject: v.boolean(),
    isNewExternalAccount: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    let subjectId: Id<'subjects'>;
    let externalAccountId: Id<'external_accounts'> | undefined;
    let isNewSubject = false;
    let isNewExternalAccount = false;

    // Step 1: Check for existing subject by authUserId
    const existingByAuth = await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (existingByAuth) {
      // Subject exists with this authUserId - update it
      subjectId = existingByAuth._id;

      // Check if Discord ID changed (account transfer scenario)
      if (existingByAuth.primaryDiscordUserId !== args.discord.discordUserId) {
        // User has connected a different Discord account
        // Update to new Discord ID
        await ctx.db.patch(subjectId, {
          primaryDiscordUserId: args.discord.discordUserId,
          displayName: args.discord.username,
          avatarUrl: buildDiscordAvatarUrl(args.discord.discordUserId, args.discord.avatar),
          updatedAt: now,
        });
      } else {
        // Same Discord account - just update profile info
        await ctx.db.patch(subjectId, {
          displayName: args.discord.username,
          avatarUrl:
            buildDiscordAvatarUrl(args.discord.discordUserId, args.discord.avatar) ??
            existingByAuth.avatarUrl,
          updatedAt: now,
        });
      }
    } else {
      // No subject with this authUserId - check if Discord account already exists
      const existingByDiscord = await ctx.db
        .query('subjects')
        .withIndex('by_discord_user', (q) =>
          q.eq('primaryDiscordUserId', args.discord.discordUserId)
        )
        .first();

      if (existingByDiscord) {
        // Discord account exists with different authUserId (account reconnection)
        // Link the authUserId to the existing subject
        subjectId = existingByDiscord._id;
        await ctx.db.patch(subjectId, {
          authUserId: args.authUserId,
          displayName: args.discord.username,
          avatarUrl:
            buildDiscordAvatarUrl(args.discord.discordUserId, args.discord.avatar) ??
            existingByDiscord.avatarUrl,
          updatedAt: now,
        });
      } else {
        // No existing subject - create new one
        subjectId = await ctx.db.insert('subjects', {
          primaryDiscordUserId: args.discord.discordUserId,
          authUserId: args.authUserId,
          status: 'active',
          displayName: args.discord.username,
          avatarUrl: buildDiscordAvatarUrl(args.discord.discordUserId, args.discord.avatar),
          createdAt: now,
          updatedAt: now,
        });
        isNewSubject = true;
      }
    }

    // Step 2: Create or update external account for Discord
    const existingExternalAccount = await ctx.db
      .query('external_accounts')
      .withIndex('by_provider_user', (q) =>
        q.eq('provider', 'discord').eq('providerUserId', args.discord.discordUserId)
      )
      .first();

    // Build display name with discriminator if present
    const fullUsername =
      args.discord.discriminator && args.discord.discriminator !== '0'
        ? `${args.discord.username}#${args.discord.discriminator}`
        : args.discord.username;

    if (existingExternalAccount) {
      // Update existing external account
      externalAccountId = existingExternalAccount._id;
      await ctx.db.patch(existingExternalAccount._id, {
        providerUsername: fullUsername,
        providerMetadata: {
          emailEncrypted: await encryptPii(args.discord.email, PII_PURPOSES.externalAccountMetadataEmail),
          avatarUrl: buildDiscordAvatarUrl(args.discord.discordUserId, args.discord.avatar),
          profileUrl: buildDiscordProfileUrl(args.discord.discordUserId),
          rawDataEncrypted: args.discord.discriminator
            ? await encryptPii(JSON.stringify({ discriminator: args.discord.discriminator }), PII_PURPOSES.externalAccountRawData)
            : undefined,
        },
        lastValidatedAt: now,
        status: 'active', // Reactivate if was disconnected
        updatedAt: now,
      });
    } else {
      // Create new external account
      externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'discord',
        providerUserId: args.discord.discordUserId,
        providerUsername: fullUsername,
        providerMetadata: {
          emailEncrypted: await encryptPii(args.discord.email, PII_PURPOSES.externalAccountMetadataEmail),
          avatarUrl: buildDiscordAvatarUrl(args.discord.discordUserId, args.discord.avatar),
          profileUrl: buildDiscordProfileUrl(args.discord.discordUserId),
          rawDataEncrypted: args.discord.discriminator
            ? await encryptPii(JSON.stringify({ discriminator: args.discord.discriminator }), PII_PURPOSES.externalAccountRawData)
            : undefined,
        },
        lastValidatedAt: now,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      isNewExternalAccount = true;
    }

    return {
      success: true,
      subjectId,
      externalAccountId,
      isNewSubject,
      isNewExternalAccount,
    };
  },
});

/**
 * Sync a user from an OAuth provider (Gumroad, Discord, Jinxxy).
 * Creates or finds subject and external_account for verification callbacks.
 * Idempotent: same provider+providerUserId returns same subjectId.
 *
 * When discordUserId is provided (e.g. from verify button in Discord), uses it as primaryDiscordUserId
 * instead of provider:userId, so role sync works. Call from Gumroad callback when session has discordUserId.
 */
export const syncUserFromProvider = mutation({
  args: {
    apiSecret: v.string(),
    provider: v.string(),
    providerUserId: v.string(),
    username: v.optional(v.union(v.string(), v.null())),
    email: v.optional(v.union(v.string(), v.null())),
    avatarUrl: v.optional(v.union(v.string(), v.null())),
    profileUrl: v.optional(v.union(v.string(), v.null())),
    /** When provided, use as primaryDiscordUserId (for Gumroad→Discord link from verify button) */
    discordUserId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    subjectId: v.id('subjects'),
    externalAccountId: v.id('external_accounts'),
    isNewSubject: v.boolean(),
    isNewExternalAccount: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const username = args.username ?? undefined;
    const email = args.email ?? undefined;
    const avatarUrl = args.avatarUrl ?? undefined;
    const profileUrl = args.profileUrl ?? undefined;

    // primaryDiscordUserId: when discordUserId provided use it; for Discord use providerUserId; for others use provider:userId
    const primaryId =
      args.discordUserId != null
        ? args.discordUserId
        : args.provider === 'discord'
          ? args.providerUserId
          : `${args.provider}:${args.providerUserId}`;

    // Find or create subject
    let subjectId: Id<'subjects'>;
    let isNewSubject = false;
    const providerFallbackId =
      args.provider === 'discord' ? args.providerUserId : `${args.provider}:${args.providerUserId}`;

    let existingSubject = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', primaryId))
      .first();

    if (!existingSubject && args.discordUserId && providerFallbackId !== primaryId) {
      // User verified from Discord but had prior Gumroad-only subject (gumroad:xxx)
      existingSubject = await ctx.db
        .query('subjects')
        .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', providerFallbackId))
        .first();
      if (existingSubject) {
        await ctx.db.patch(existingSubject._id, {
          primaryDiscordUserId: args.discordUserId,
          displayName: username ?? existingSubject.displayName,
          avatarUrl: avatarUrl ?? existingSubject.avatarUrl,
          updatedAt: now,
        });
      }
    }

    if (existingSubject) {
      subjectId = existingSubject._id;
      await ctx.db.patch(subjectId, {
        displayName: username ?? existingSubject.displayName,
        avatarUrl: avatarUrl ?? existingSubject.avatarUrl,
        updatedAt: now,
      });
    } else {
      subjectId = await ctx.db.insert('subjects', {
        primaryDiscordUserId: primaryId,
        status: 'active',
        displayName: username,
        avatarUrl: avatarUrl,
        createdAt: now,
        updatedAt: now,
      });
      isNewSubject = true;
    }

    // Find or create external_account
    let externalAccountId: Id<'external_accounts'>;
    let isNewExternalAccount = false;
    const existingAccount = await ctx.db
      .query('external_accounts')
      .withIndex('by_provider_user', (q) =>
        q.eq('provider', args.provider).eq('providerUserId', args.providerUserId)
      )
      .first();

    const { emailHash, normalizedEmailEncrypted } = await normalizeAndEncryptEmail(email, sha256Hex);

    if (existingAccount) {
      externalAccountId = existingAccount._id;
      await ctx.db.patch(externalAccountId, {
        providerUsername: username ?? existingAccount.providerUsername,
        emailHash,
        normalizedEmailEncrypted,
        providerMetadata: {
          emailEncrypted: await encryptPii(email, PII_PURPOSES.externalAccountMetadataEmail),
          avatarUrl: avatarUrl,
          profileUrl: profileUrl,
        },
        lastValidatedAt: now,
        status: 'active',
        updatedAt: now,
      });
    } else {
      externalAccountId = await ctx.db.insert('external_accounts', {
        provider: args.provider,
        providerUserId: args.providerUserId,
        providerUsername: username,
        emailHash,
        normalizedEmailEncrypted,
        providerMetadata: {
          emailEncrypted: await encryptPii(email, PII_PURPOSES.externalAccountMetadataEmail),
          avatarUrl: avatarUrl,
          profileUrl: profileUrl,
        },
        lastValidatedAt: now,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      isNewExternalAccount = true;
    }

    if (args.provider !== 'discord' && emailHash) {
      await ctx.scheduler.runAfter(0, internal.backgroundSync.syncPastPurchasesForSubject, {
        subjectId,
        provider: args.provider,
        providerUserId: args.providerUserId,
        emailHash,
      });
    }

    return {
      success: true,
      subjectId,
      externalAccountId,
      isNewSubject,
      isNewExternalAccount,
    };
  },
});

/**
 * Store encrypted Discord OAuth tokens on an external account.
 * Called after a successful discord_role OAuth callback so we can
 * proactively check guild membership when new discord_role products
 * are added (retroactive sync without requiring re-authorization).
 */
export const storeDiscordToken = mutation({
  args: {
    apiSecret: v.string(),
    externalAccountId: v.id('external_accounts'),
    discordAccessTokenEncrypted: v.string(),
    discordTokenExpiresAt: v.optional(v.number()),
    discordRefreshTokenEncrypted: v.optional(v.string()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const account = await ctx.db.get(args.externalAccountId);
    if (!account) {
      throw new Error(`External account not found: ${args.externalAccountId}`);
    }
    await ctx.db.patch(args.externalAccountId, {
      discordAccessTokenEncrypted: args.discordAccessTokenEncrypted,
      discordTokenExpiresAt: args.discordTokenExpiresAt,
      discordRefreshTokenEncrypted: args.discordRefreshTokenEncrypted,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});
/**
 * Update subject status.
 * Used for account suspension, quarantine, or deletion.
 */
export const updateSubjectStatus = mutation({
  args: {
    apiSecret: v.string(),
    subjectId: v.id('subjects'),
    status: v.union(
      v.literal('active'),
      v.literal('suspended'),
      v.literal('quarantined'),
      v.literal('deleted')
    ),
    reason: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    previousStatus: v.union(
      v.literal('active'),
      v.literal('suspended'),
      v.literal('quarantined'),
      v.literal('deleted')
    ),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const subject = await ctx.db.get(args.subjectId);
    if (!subject) {
      throw new Error(`Subject not found: ${args.subjectId}`);
    }

    const previousStatus = subject.status;
    await ctx.db.patch(args.subjectId, {
      status: args.status,
      updatedAt: Date.now(),
    });

    await ctx.db.insert('audit_events', {
      eventType: 'subject.status.updated',
      actorType: 'system',
      subjectId: args.subjectId,
      metadata: {
        previousStatus,
        newStatus: args.status,
        reason: args.reason,
      },
      createdAt: Date.now(),
    });

    return {
      success: true,
      previousStatus,
    };
  },
});

/**
 * Mark a subject as suspicious (piracy, double license, redistribution, etc.).
 * Sets flags and optionally quarantines. Called by bot when admin runs /yucp suspicious mark.
 */
export const markSubjectSuspicious = mutation({
  args: {
    apiSecret: v.string(),
    subjectId: v.id('subjects'),
    reason: v.string(),
    actorId: v.string(),
    authUserId: v.optional(v.string()),
    quarantine: v.optional(v.boolean()),
  },
  returns: v.object({
    success: v.boolean(),
    wasAlreadySuspicious: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const subject = await ctx.db.get(args.subjectId);
    if (!subject) {
      throw new Error(`Subject not found: ${args.subjectId}`);
    }

    const wasAlreadySuspicious = subject.flags?.suspicious ?? false;
    const now = Date.now();

    await ctx.db.patch(args.subjectId, {
      flags: {
        ...subject.flags,
        suspicious: true,
        reason: args.reason,
        flaggedAt: now,
        flaggedBy: args.actorId,
      },
      ...(args.quarantine !== false && { status: 'quarantined' }),
      updatedAt: now,
    });

    await ctx.db.insert('audit_events', {
      ...(args.authUserId && { authUserId: args.authUserId }),
      eventType: 'subject.suspicious.marked',
      actorType: 'admin',
      actorId: args.actorId,
      subjectId: args.subjectId,
      metadata: { reason: args.reason, quarantine: args.quarantine !== false },
      createdAt: now,
    });

    return { success: true, wasAlreadySuspicious };
  },
});

/**
 * List suspicious subjects (optionally for a tenant).
 * Returns subjects with flags.suspicious or status quarantined.
 */
export const listSuspiciousSubjects = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      subjectId: v.id('subjects'),
      discordUserId: v.string(),
      displayName: v.optional(v.string()),
      reason: v.optional(v.string()),
      flaggedAt: v.optional(v.number()),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = Math.min(args.limit ?? 25, 50);
    let subjectIds: Id<'subjects'>[];
    if (args.authUserId) {
      const events = await ctx.db
        .query('audit_events')
        .withIndex('by_auth_user_event', (q) =>
          q.eq('authUserId', args.authUserId!).eq('eventType', 'subject.suspicious.marked')
        )
        .order('desc')
        .take(limit * 2);
      const seen = new Set<string>();
      subjectIds = [];
      for (const e of events) {
        if (e.subjectId && !seen.has(e.subjectId)) {
          seen.add(e.subjectId);
          subjectIds.push(e.subjectId);
          if (subjectIds.length >= limit) break;
        }
      }
    } else {
      const subjects = await ctx.db
        .query('subjects')
        .withIndex('by_status', (q) => q.eq('status', 'quarantined'))
        .take(limit);
      subjectIds = subjects.map((s) => s._id);
      const alsoSuspicious = await ctx.db
        .query('subjects')
        .filter((q) => q.eq(q.field('flags.suspicious'), true))
        .take(limit);
      for (const s of alsoSuspicious) {
        if (!subjectIds.includes(s._id)) subjectIds.push(s._id);
      }
    }
    const result = [];
    for (const sid of subjectIds) {
      const s = await ctx.db.get(sid);
      if (s) {
        result.push({
          subjectId: s._id,
          discordUserId: s.primaryDiscordUserId,
          displayName: s.displayName,
          reason: s.flags?.reason,
          flaggedAt: s.flags?.flaggedAt,
        });
      }
    }
    return result;
  },
});

/**
 * Clear suspicious flag from a subject.
 */
export const clearSubjectSuspicious = mutation({
  args: {
    apiSecret: v.string(),
    subjectId: v.id('subjects'),
    actorId: v.string(),
    authUserId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const subject = await ctx.db.get(args.subjectId);
    if (!subject) {
      throw new Error(`Subject not found: ${args.subjectId}`);
    }

    const now = Date.now();

    await ctx.db.patch(args.subjectId, {
      flags: subject.flags
        ? {
            ...subject.flags,
            suspicious: false,
            reason: undefined,
            flaggedAt: undefined,
            flaggedBy: undefined,
          }
        : undefined,
      status: 'active',
      updatedAt: now,
    });

    await ctx.db.insert('audit_events', {
      ...(args.authUserId && { authUserId: args.authUserId }),
      eventType: 'subject.suspicious.cleared',
      actorType: 'admin',
      actorId: args.actorId,
      subjectId: args.subjectId,
      metadata: {},
      createdAt: now,
    });

    return { success: true };
  },
});

/**
 * Disconnect an external account.
 * Marks the account as disconnected but preserves the record.
 */
export const disconnectExternalAccount = mutation({
  args: {
    apiSecret: v.string(),
    externalAccountId: v.id('external_accounts'),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const account = await ctx.db.get(args.externalAccountId);
    if (!account) {
      throw new Error(`External account not found: ${args.externalAccountId}`);
    }

    await ctx.db.patch(args.externalAccountId, {
      status: 'disconnected',
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Link an existing external account to a subject.
 * Used when a user connects additional provider accounts (e.g., Gumroad).
 *
 * Note: In the current schema, external_accounts are linked implicitly
 * via providerUserId matching to subject's primaryDiscordUserId.
 * This mutation is for future use when explicit linking is implemented.
 */
export const linkExternalAccountToSubject = mutation({
  args: {
    apiSecret: v.string(),
    subjectId: v.id('subjects'),
    provider: v.string(),
    providerUserId: v.string(),
    providerUsername: v.optional(v.string()),
    providerMetadata: v.optional(
      v.object({
        avatarUrl: v.optional(v.string()),
        profileUrl: v.optional(v.string()),
      })
    ),
  },
  returns: v.object({
    success: v.boolean(),
    externalAccountId: v.id('external_accounts'),
    isNew: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    // Check for existing external account
    const existing = await ctx.db
      .query('external_accounts')
      .withIndex('by_provider_user', (q) =>
        q.eq('provider', args.provider).eq('providerUserId', args.providerUserId)
      )
      .first();

    if (existing) {
      // Update existing account
      await ctx.db.patch(existing._id, {
        providerUsername: args.providerUsername ?? existing.providerUsername,
        providerMetadata: args.providerMetadata ?? existing.providerMetadata,
        lastValidatedAt: now,
        status: 'active',
        updatedAt: now,
      });

      return {
        success: true,
        externalAccountId: existing._id,
        isNew: false,
      };
    }

    // Create new external account
    const externalAccountId = await ctx.db.insert('external_accounts', {
      provider: args.provider,
      providerUserId: args.providerUserId,
      providerUsername: args.providerUsername,
      providerMetadata: args.providerMetadata,
      lastValidatedAt: now,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      externalAccountId,
      isNew: true,
    };
  },
});

// ============================================================================
// INTERNAL MUTATIONS
// ============================================================================

/**
 * Internal mutation for bulk sync operations.
 * Used by background jobs to sync multiple users.
 *
 * Note: Convex mutations are already atomic, so this duplicates the syncUserFromAuth logic
 * without the transaction wrapper.
 */
export const internalSyncUserFromAuth = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    discord: v.object({
      discordUserId: v.string(),
      username: v.string(),
      discriminator: v.optional(v.string()),
      avatar: v.optional(v.string()),
      email: v.optional(v.string()),
    }),
    idempotencyKey: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    subjectId: v.id('subjects'),
    externalAccountId: v.optional(v.id('external_accounts')),
    isNewSubject: v.boolean(),
    isNewExternalAccount: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    let subjectId: Id<'subjects'>;
    let externalAccountId: Id<'external_accounts'> | undefined;
    let isNewSubject = false;
    let isNewExternalAccount = false;

    // Step 1: Check for existing subject by authUserId
    const result = await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (result) {
      subjectId = result._id;
      await ctx.db.patch(subjectId, {
        primaryDiscordUserId: args.discord.discordUserId,
        displayName: args.discord.username,
        avatarUrl: args.discord.avatar
          ? `https://cdn.discordapp.com/avatars/${args.discord.discordUserId}/${args.discord.avatar}.png`
          : result.avatarUrl,
        updatedAt: now,
      });
    } else {
      const existingByDiscord = await ctx.db
        .query('subjects')
        .withIndex('by_discord_user', (q) =>
          q.eq('primaryDiscordUserId', args.discord.discordUserId)
        )
        .first();

      if (existingByDiscord) {
        subjectId = existingByDiscord._id;
        await ctx.db.patch(subjectId, {
          authUserId: args.authUserId,
          displayName: args.discord.username,
          updatedAt: now,
        });
      } else {
        subjectId = await ctx.db.insert('subjects', {
          primaryDiscordUserId: args.discord.discordUserId,
          authUserId: args.authUserId,
          status: 'active',
          displayName: args.discord.username,
          avatarUrl: buildDiscordAvatarUrl(args.discord.discordUserId, args.discord.avatar),
          createdAt: now,
          updatedAt: now,
        });
        isNewSubject = true;
      }
    }

    const existingAccount = await ctx.db
      .query('external_accounts')
      .withIndex('by_provider_user', (q) =>
        q.eq('provider', 'discord').eq('providerUserId', args.discord.discordUserId)
      )
      .first();

    const fullUsername =
      args.discord.discriminator && args.discord.discriminator !== '0'
        ? `${args.discord.username}#${args.discord.discriminator}`
        : args.discord.username;

    if (existingAccount) {
      externalAccountId = existingAccount._id;
      await ctx.db.patch(existingAccount._id, {
        providerUsername: fullUsername,
        providerMetadata: {
          emailEncrypted: await encryptPii(args.discord.email, PII_PURPOSES.externalAccountMetadataEmail),
          avatarUrl: buildDiscordAvatarUrl(args.discord.discordUserId, args.discord.avatar),
          profileUrl: buildDiscordProfileUrl(args.discord.discordUserId),
          rawDataEncrypted: args.discord.discriminator
            ? await encryptPii(JSON.stringify({ discriminator: args.discord.discriminator }), PII_PURPOSES.externalAccountRawData)
            : undefined,
        },
        lastValidatedAt: now,
        status: 'active',
        updatedAt: now,
      });
    } else {
      externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'discord',
        providerUserId: args.discord.discordUserId,
        providerUsername: fullUsername,
        providerMetadata: {
          emailEncrypted: await encryptPii(args.discord.email, PII_PURPOSES.externalAccountMetadataEmail),
          avatarUrl: buildDiscordAvatarUrl(args.discord.discordUserId, args.discord.avatar),
          profileUrl: buildDiscordProfileUrl(args.discord.discordUserId),
          rawDataEncrypted: args.discord.discriminator
            ? await encryptPii(JSON.stringify({ discriminator: args.discord.discriminator }), PII_PURPOSES.externalAccountRawData)
            : undefined,
        },
        lastValidatedAt: now,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      isNewExternalAccount = true;
    }

    return {
      success: true,
      subjectId,
      externalAccountId,
      isNewSubject,
      isNewExternalAccount,
    };
  },
});
