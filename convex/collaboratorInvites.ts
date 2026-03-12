/**
 * Collaborator Invites - Cross-creator API key sharing
 *
 * Allows a server owner to invite another creator (collaborator) to share
 * their Jinxxy API key so license verification works across both stores.
 */

import { v } from 'convex/values';
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
    ownerTenantId: v.id('tenants'),
    ownerDisplayName: v.string(),
    ownerGuildId: v.optional(v.string()),
    tokenHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.id('collaborator_invites'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db.insert('collaborator_invites', {
      ownerTenantId: args.ownerTenantId,
      tokenHash: args.tokenHash,
      status: 'pending',
      ownerDisplayName: args.ownerDisplayName,
      ownerGuildId: args.ownerGuildId,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });
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
      ownerTenantId: v.id('tenants'),
      tokenHash: v.string(),
      status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('revoked')),
      ownerDisplayName: v.string(),
      ownerGuildId: v.optional(v.string()),
      expiresAt: v.number(),
      createdAt: v.number(),
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
      ownerTenantId: invite.ownerTenantId,
      tokenHash: invite.tokenHash,
      status: invite.status,
      ownerDisplayName: invite.ownerDisplayName,
      ownerGuildId: invite.ownerGuildId,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
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
      ownerTenantId: v.id('tenants'),
      tokenHash: v.string(),
      status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('revoked')),
      ownerDisplayName: v.string(),
      ownerGuildId: v.optional(v.string()),
      expiresAt: v.number(),
      createdAt: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) return null;
    return {
      _id: invite._id,
      ownerTenantId: invite.ownerTenantId,
      tokenHash: invite.tokenHash,
      status: invite.status,
      ownerDisplayName: invite.ownerDisplayName,
      ownerGuildId: invite.ownerGuildId,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
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
    jinxxyApiKeyEncrypted: v.string(),
    webhookSecretRef: v.optional(v.string()),
    webhookEndpoint: v.optional(v.string()),
    linkType: v.union(v.literal('account'), v.literal('api')),
    /** Discord user ID from server-side OAuth - never from client body */
    collaboratorDiscordUserId: v.string(),
    /** Discord username from server-side OAuth */
    collaboratorDisplayName: v.string(),
  },
  returns: v.id('collaborator_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const invite = await ctx.db.get(args.inviteId);
    if (!invite) throw new Error('Invite not found');
    if (invite.status !== 'pending') throw new Error('Invite is no longer pending');
    if (Date.now() > invite.expiresAt) throw new Error('Invite has expired');

    // Store the collaborator's Discord identity on the invite for audit purposes
    await ctx.db.patch(args.inviteId, {
      status: 'accepted',
      targetDiscordUserId: args.collaboratorDiscordUserId,
      targetDiscordDisplayName: args.collaboratorDisplayName,
    });

    const webhookConfigured = !!(args.webhookSecretRef && args.webhookEndpoint);

    return await ctx.db.insert('collaborator_connections', {
      ownerTenantId: invite.ownerTenantId,
      inviteId: args.inviteId,
      provider: 'jinxxy',
      jinxxyApiKeyEncrypted: args.jinxxyApiKeyEncrypted,
      webhookSecretRef: args.webhookSecretRef,
      webhookEndpoint: args.webhookEndpoint,
      webhookConfigured,
      linkType: args.linkType,
      status: 'active',
      source: 'invite',
      collaboratorDiscordUserId: args.collaboratorDiscordUserId,
      collaboratorDisplayName: args.collaboratorDisplayName,
      createdAt: Date.now(),
    });
  },
});

/**
 * Manually add a collaborator connection (no invite).
 * Used when a creator shares their API key directly (e.g. via DM).
 * Identity comes from Jinxxy API since collaborator may not be in Discord server.
 */
export const addCollaboratorConnectionManual = mutation({
  args: {
    apiSecret: v.string(),
    ownerTenantId: v.id('tenants'),
    jinxxyApiKeyEncrypted: v.string(),
    collaboratorDisplayName: v.string(),
    collaboratorIdentity: v.string(),
    addedByDiscordUserId: v.string(),
  },
  returns: v.id('collaborator_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db.insert('collaborator_connections', {
      ownerTenantId: args.ownerTenantId,
      provider: 'jinxxy',
      jinxxyApiKeyEncrypted: args.jinxxyApiKeyEncrypted,
      webhookConfigured: false,
      linkType: 'api',
      status: 'active',
      source: 'manual',
      collaboratorDiscordUserId: args.collaboratorIdentity,
      collaboratorDisplayName: args.collaboratorDisplayName,
      addedByDiscordUserId: args.addedByDiscordUserId,
      createdAt: Date.now(),
    });
  },
});

/**
 * Revoke a collaborator invite (owner action).
 */
export const revokeCollaboratorInvite = mutation({
  args: {
    apiSecret: v.string(),
    inviteId: v.id('collaborator_invites'),
    ownerTenantId: v.id('tenants'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invite.ownerTenantId !== args.ownerTenantId) {
      throw new Error('Invite not found or access denied');
    }
    await ctx.db.patch(args.inviteId, { status: 'revoked' });
  },
});

/**
 * List all collaborator connections for a tenant (owner view).
 */
export const listCollaboratorConnections = query({
  args: {
    apiSecret: v.string(),
    ownerTenantId: v.id('tenants'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const connections = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_owner', (q) => q.eq('ownerTenantId', args.ownerTenantId))
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
      createdAt: c.createdAt,
    }));
  },
});

/**
 * Remove a collaborator connection (owner action - soft delete).
 */
export const removeCollaboratorConnection = mutation({
  args: {
    apiSecret: v.string(),
    connectionId: v.id('collaborator_connections'),
    ownerTenantId: v.id('tenants'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db.get(args.connectionId);
    if (!conn || conn.ownerTenantId !== args.ownerTenantId) {
      throw new Error('Connection not found or access denied');
    }
    await ctx.db.patch(args.connectionId, { status: 'disconnected' });
  },
});

/**
 * Get active collaborator connections for license verification.
 * Returns only active connections with an encrypted API key.
 */
export const getCollabConnectionsForVerification = query({
  args: {
    apiSecret: v.string(),
    ownerTenantId: v.id('tenants'),
  },
  returns: v.array(
    v.object({
      id: v.id('collaborator_connections'),
      jinxxyApiKeyEncrypted: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const connections = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_owner_status', (q) =>
        q.eq('ownerTenantId', args.ownerTenantId).eq('status', 'active')
      )
      .collect();

    return connections
      .filter((c) => c.jinxxyApiKeyEncrypted)
      .map((c) => ({
        id: c._id,
        jinxxyApiKeyEncrypted: c.jinxxyApiKeyEncrypted,
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
  returns: v.array(v.object({ ownerTenantId: v.id('tenants') })),
  handler: async (ctx, args) => {
    const connections = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_collaborator_discord', (q) =>
        q.eq('collaboratorDiscordUserId', args.collaboratorDiscordUserId)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();
    return connections.map((c) => ({ ownerTenantId: c.ownerTenantId }));
  },
});
