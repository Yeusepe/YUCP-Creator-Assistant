/**
 * Collaborator Invites - Cross-creator API key sharing
 *
 * Allows a server owner to invite another creator (collaborator) to share
 * their Jinxxy API key so license verification works across both stores.
 */

import { ConvexError, v } from 'convex/values';
import { internalQuery, mutation, query } from './_generated/server';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

/**
 * Create a collaborator invite.
 * tokenHash is the SHA-256 hex of the raw invite token (never stored plaintext).
 */
export const createCollaboratorInvite = mutation({
  args: {
    apiSecret: v.string(),
    ownerAuthUserId: v.string(),
    ownerDisplayName: v.string(),
    ownerGuildId: v.optional(v.string()),
    tokenHash: v.string(),
    expiresAt: v.number(),
    /** Commerce provider for this invite (e.g. 'jinxxy', 'lemonsqueezy'). Defaults to 'jinxxy'. */
    providerKey: v.optional(v.string()),
  },
  returns: v.id('collaborator_invites'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const MAX_EXPIRES_AT = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const expiresAt = Math.min(args.expiresAt, MAX_EXPIRES_AT);
    const inviteId = await ctx.db.insert('collaborator_invites', {
      ownerAuthUserId: args.ownerAuthUserId,
      tokenHash: args.tokenHash,
      status: 'pending',
      ownerDisplayName: args.ownerDisplayName,
      ownerGuildId: args.ownerGuildId,
      expiresAt,
      createdAt: Date.now(),
      providerKey: args.providerKey,
    });
    await ctx.db.insert('audit_events', {
      authUserId: args.ownerAuthUserId,
      eventType: 'collaborator.invite.created',
      actorType: 'system',
      metadata: { inviteId, ownerDisplayName: args.ownerDisplayName },
      createdAt: Date.now(),
    });
    return inviteId;
  },
});

/**
 * Look up an invite by its token hash.
 */
export const getCollaboratorInviteByTokenHash = query({
  args: {
    apiSecret: v.string(),
    tokenHash: v.string(),
  },
  returns: v.union(
    v.object({
      _id: v.id('collaborator_invites'),
      ownerAuthUserId: v.string(),
      tokenHash: v.string(),
      status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('revoked')),
      ownerDisplayName: v.string(),
      ownerGuildId: v.optional(v.string()),
      expiresAt: v.number(),
      createdAt: v.number(),
      providerKey: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const invite = await ctx.db
      .query('collaborator_invites')
      .withIndex('by_token_hash', (q) => q.eq('tokenHash', args.tokenHash))
      .first();
    if (!invite) return null;
    return {
      _id: invite._id,
      ownerAuthUserId: invite.ownerAuthUserId,
      tokenHash: invite.tokenHash,
      status: invite.status,
      ownerDisplayName: invite.ownerDisplayName,
      ownerGuildId: invite.ownerGuildId,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      providerKey: invite.providerKey,
    };
  },
});

/**
 * Look up an invite by id for cookie-backed collab setup sessions.
 */
export const getCollaboratorInviteById = query({
  args: {
    apiSecret: v.string(),
    inviteId: v.id('collaborator_invites'),
  },
  returns: v.union(
    v.object({
      _id: v.id('collaborator_invites'),
      ownerAuthUserId: v.string(),
      tokenHash: v.string(),
      status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('revoked')),
      ownerDisplayName: v.string(),
      ownerGuildId: v.optional(v.string()),
      expiresAt: v.number(),
      createdAt: v.number(),
      providerKey: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) return null;
    return {
      _id: invite._id,
      ownerAuthUserId: invite.ownerAuthUserId,
      tokenHash: invite.tokenHash,
      status: invite.status,
      ownerDisplayName: invite.ownerDisplayName,
      ownerGuildId: invite.ownerGuildId,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      providerKey: invite.providerKey,
    };
  },
});

/**
 * Check if a Discord user has previously connected as a collaborator.
 * Returns only coarse history flags for UI messaging.
 */
export const getPriorCollabHistory = query({
  args: {
    apiSecret: v.string(),
    discordUserId: v.string(),
  },
  returns: v.object({
    hasApiOnly: v.boolean(),
    hasFullAccount: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const connections = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_collaborator_discord', (q) =>
        q.eq('collaboratorDiscordUserId', args.discordUserId)
      )
      .collect();

    const activeConnections = connections.filter((c) => c.status === 'active');
    const hasApiOnly = activeConnections.some((c) => c.linkType === 'api');
    const hasFullAccount = activeConnections.some((c) => c.linkType === 'account');

    return {
      hasApiOnly,
      hasFullAccount,
    };
  },
});

/**
 * Accept an invite and create a collaborator connection.
 * Called after the collaborator submits their credentials on the consent page.
 */
export const acceptCollaboratorInvite = mutation({
  args: {
    apiSecret: v.string(),
    inviteId: v.id('collaborator_invites'),
    /** Generic encrypted credential — replaces jinxxyApiKeyEncrypted for new records */
    credentialEncrypted: v.string(),
    webhookSecretRef: v.optional(v.string()),
    webhookEndpoint: v.optional(v.string()),
    linkType: v.union(v.literal('account'), v.literal('api')),
    /** Commerce provider (e.g. 'jinxxy', 'lemonsqueezy'). Defaults to 'jinxxy' for legacy. */
    provider: v.optional(v.string()),
    /** Discord user ID from server-side OAuth - never from client body */
    collaboratorDiscordUserId: v.string(),
    /** Discord username from server-side OAuth */
    collaboratorDisplayName: v.string(),
    /** Discord avatar hash — validated server-side during OAuth (/^(a_)?[0-9a-f]{32}$/) */
    collaboratorAvatarHash: v.optional(v.string()),
  },
  returns: v.id('collaborator_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const invite = await ctx.db.get(args.inviteId);
    if (!invite) throw new Error('Invite not found');
    if (invite.usedAt !== undefined) {
      throw new ConvexError('This invite has already been used');
    }
    if (invite.status !== 'pending') throw new Error('Invite is no longer pending');
    if (Date.now() > invite.expiresAt) throw new Error('Invite has expired');

    // Store the collaborator's Discord identity on the invite for audit purposes
    await ctx.db.patch(args.inviteId, {
      status: 'accepted',
      targetDiscordUserId: args.collaboratorDiscordUserId,
      targetDiscordDisplayName: args.collaboratorDisplayName,
    });

    const webhookConfigured = !!(args.webhookSecretRef && args.webhookEndpoint);
    const provider = args.provider ?? invite.providerKey ?? 'jinxxy';

    const connectionId = await ctx.db.insert('collaborator_connections', {
      ownerAuthUserId: invite.ownerAuthUserId,
      inviteId: args.inviteId,
      provider,
      credentialEncrypted: args.credentialEncrypted,
      webhookSecretRef: args.webhookSecretRef,
      webhookEndpoint: args.webhookEndpoint,
      webhookConfigured,
      linkType: args.linkType,
      status: 'active',
      source: 'invite',
      collaboratorDiscordUserId: args.collaboratorDiscordUserId,
      collaboratorDisplayName: args.collaboratorDisplayName,
      collaboratorAvatarHash: args.collaboratorAvatarHash,
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.inviteId, { usedAt: Date.now() });
    await ctx.db.insert('audit_events', {
      authUserId: invite.ownerAuthUserId,
      eventType: 'collaborator.invite.accepted',
      actorType: 'system',
      metadata: {
        inviteId: args.inviteId,
        connectionId,
        collaboratorDiscordUserId: args.collaboratorDiscordUserId,
      },
      createdAt: Date.now(),
    });
    return connectionId;
  },
});

/**
 * Manually add a collaborator connection (no invite).
 * Used when a creator shares their API key directly (e.g. via DM).
 * Identity comes from provider API since collaborator may not be in Discord server.
 */
export const addCollaboratorConnectionManual = mutation({
  args: {
    apiSecret: v.string(),
    ownerAuthUserId: v.string(),
    /** Generic encrypted credential (provider API key) */
    credentialEncrypted: v.string(),
    /** Commerce provider (e.g. 'jinxxy', 'lemonsqueezy') */
    provider: v.optional(v.string()),
    collaboratorDisplayName: v.string(),
    collaboratorIdentity: v.string(),
    addedByDiscordUserId: v.string(),
  },
  returns: v.id('collaborator_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const owner = await ctx.db
      .query('creator_profiles')
      .filter((q) => q.eq(q.field('authUserId'), args.ownerAuthUserId))
      .first();
    if (!owner) {
      throw new ConvexError('Invalid ownerAuthUserId: creator not found');
    }
    const connectionId = await ctx.db.insert('collaborator_connections', {
      ownerAuthUserId: args.ownerAuthUserId,
      provider: args.provider ?? 'jinxxy',
      credentialEncrypted: args.credentialEncrypted,
      webhookConfigured: false,
      linkType: 'api',
      status: 'active',
      source: 'manual',
      collaboratorDiscordUserId: args.collaboratorIdentity,
      collaboratorDisplayName: args.collaboratorDisplayName,
      addedByDiscordUserId: args.addedByDiscordUserId,
      createdAt: Date.now(),
    });
    await ctx.db.insert('audit_events', {
      authUserId: args.ownerAuthUserId,
      eventType: 'collaborator.connection.added',
      actorType: 'system',
      metadata: {
        connectionId,
        collaboratorIdentity: args.collaboratorIdentity,
        addedByDiscordUserId: args.addedByDiscordUserId,
      },
      createdAt: Date.now(),
    });
    return connectionId;
  },
});

/**
 * Revoke a collaborator invite (owner action).
 */
export const revokeCollaboratorInvite = mutation({
  args: {
    apiSecret: v.string(),
    inviteId: v.id('collaborator_invites'),
    ownerAuthUserId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invite.ownerAuthUserId !== args.ownerAuthUserId) {
      throw new Error('Invite not found or access denied');
    }
    await ctx.db.patch(args.inviteId, { status: 'revoked' });
    await ctx.db.insert('audit_events', {
      authUserId: args.ownerAuthUserId,
      eventType: 'collaborator.invite.revoked',
      actorType: 'system',
      metadata: { inviteId: args.inviteId },
      createdAt: Date.now(),
    });
  },
});

/**
 * List all collaborator connections for a tenant (owner view).
 */
export const listCollaboratorConnections = query({
  args: {
    apiSecret: v.string(),
    ownerAuthUserId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const connections = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_owner', (q) => q.eq('ownerAuthUserId', args.ownerAuthUserId))
      .collect();

    return connections.map((c) => ({
      id: c._id,
      inviteId: c.inviteId,
      provider: c.provider,
      linkType: c.linkType,
      status: c.status,
      source: c.source ?? 'invite',
      webhookConfigured: c.webhookConfigured,
      collaboratorDiscordUserId: c.collaboratorDiscordUserId,
      collaboratorDisplayName: c.collaboratorDisplayName,
      collaboratorAvatarHash: c.collaboratorAvatarHash,
      createdAt: c.createdAt,
    }));
  },
});

/**
 * List pending (not yet accepted) invites for a tenant (owner view).
 */
export const listPendingInvitesByOwner = query({
  args: {
    apiSecret: v.string(),
    ownerAuthUserId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const invites = await ctx.db
      .query('collaborator_invites')
      .withIndex('by_owner_status', (q) =>
        q.eq('ownerAuthUserId', args.ownerAuthUserId).eq('status', 'pending')
      )
      .collect();

    const now = Date.now();
    return invites
      .filter((i) => i.expiresAt > now)
      .map((i) => ({
        id: i._id,
        providerKey: i.providerKey ?? 'jinxxy',
        ownerDisplayName: i.ownerDisplayName,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      }));
  },
});

/**
 * List active connections where the caller is the collaborator (not the owner).
 * Resolves the caller's Discord ID via their creator_profile, then queries
 * collaborator_connections by that Discord ID.
 */
export const listConnectionsAsCollaborator = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    // Resolve the caller's Discord ID from their creator profile
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (!profile?.ownerDiscordUserId) return [];

    const connections = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_collaborator_discord', (q) =>
        q.eq('collaboratorDiscordUserId', profile.ownerDiscordUserId)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    // Enrich with owner display name from their profile
    const enriched = await Promise.all(
      connections.map(async (c) => {
        const ownerProfile = await ctx.db
          .query('creator_profiles')
          .withIndex('by_auth_user', (q) => q.eq('authUserId', c.ownerAuthUserId))
          .first();
        return {
          id: c._id,
          provider: c.provider,
          linkType: c.linkType,
          ownerAuthUserId: c.ownerAuthUserId,
          ownerDisplayName: ownerProfile?.name ?? null,
          createdAt: c.createdAt,
        };
      })
    );

    return enriched;
  },
});

/**
 * Remove a collaborator connection (owner action - soft delete).
 */
export const removeCollaboratorConnection = mutation({
  args: {
    apiSecret: v.string(),
    connectionId: v.id('collaborator_connections'),
    ownerAuthUserId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db.get(args.connectionId);
    if (!conn || conn.ownerAuthUserId !== args.ownerAuthUserId) {
      throw new Error('Connection not found or access denied');
    }
    await ctx.db.patch(args.connectionId, { status: 'disconnected' });
    await ctx.db.insert('audit_events', {
      authUserId: args.ownerAuthUserId,
      eventType: 'collaborator.connection.removed',
      actorType: 'system',
      metadata: { connectionId: args.connectionId },
      createdAt: Date.now(),
    });
  },
});

/**
 * Get active collaborator connections for license verification.
 * Returns only active connections with an encrypted API key.
 */
export const getCollabConnectionsForVerification = query({
  args: {
    apiSecret: v.string(),
    ownerAuthUserId: v.string(),
  },
  returns: v.array(
    v.object({
      id: v.id('collaborator_connections'),
      provider: v.string(),
      collaboratorDisplayName: v.string(),
      /** Legacy Jinxxy-specific field; present on old records */
      jinxxyApiKeyEncrypted: v.optional(v.string()),
      /** Generic credential field; present on new records */
      credentialEncrypted: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const connections = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_owner_status', (q) =>
        q.eq('ownerAuthUserId', args.ownerAuthUserId).eq('status', 'active')
      )
      .collect();

    return connections
      .filter((c) => c.jinxxyApiKeyEncrypted || c.credentialEncrypted)
      .map((c) => ({
        id: c._id,
        provider: c.provider,
        collaboratorDisplayName: c.collaboratorDisplayName,
        jinxxyApiKeyEncrypted: c.jinxxyApiKeyEncrypted,
        credentialEncrypted: c.credentialEncrypted,
      }));
  },
});

/**
 * Get the webhook signing secret for a collab connection.
 * Used by the webhook handler for signature verification.
 */
export const getCollabWebhookSecret = query({
  args: {
    apiSecret: v.string(),
    inviteId: v.id('collaborator_invites'),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_invite', (q) => q.eq('inviteId', args.inviteId))
      .first();
    if (!conn?.webhookSecretRef) return null;
    return conn.webhookSecretRef;
  },
});

/**
 * Get active collaborator connections where the given Discord user is the collaborator.
 * Used by GET /v1/products to include products from tenants this creator collaborates with.
 */
export const getActiveByCollaboratorDiscord = internalQuery({
  args: { collaboratorDiscordUserId: v.string() },
  returns: v.array(v.object({ ownerAuthUserId: v.string() })),
  handler: async (ctx, args) => {
    const connections = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_collaborator_discord', (q) =>
        q.eq('collaboratorDiscordUserId', args.collaboratorDiscordUserId)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();
    return connections.map((c) => ({ ownerAuthUserId: c.ownerAuthUserId }));
  },
});
