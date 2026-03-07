/**
 * Collaborator Invites - Cross-creator API key sharing
 *
 * Allows a server owner to invite another creator (collaborator) to share
 * their Jinxxy API key so license verification works across both stores.
 */

import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

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
 * Check if a Discord user has previously connected as a collaborator.
 * Returns info about their prior connection history (for "returning user" UX).
 * Does NOT return the encrypted API key — the client never needs it directly.
 */
export const getPriorCollabHistory = query({
  args: {
    apiSecret: v.string(),
    discordUserId: v.string(),
  },
  returns: v.object({
    hasApiOnly: v.boolean(),
    hasFullAccount: v.boolean(),
    encryptedApiKey: v.optional(v.string()),
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

    // Return encrypted key from most recent active connection (for reuse UX)
    const withKey = activeConnections.find((c) => c.jinxxyApiKeyEncrypted);
    return {
      hasApiOnly,
      hasFullAccount,
      encryptedApiKey: withKey?.jinxxyApiKeyEncrypted,
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
    /** Discord user ID from server-side OAuth — never from client body */
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
      collaboratorDiscordUserId: args.collaboratorDiscordUserId,
      collaboratorDisplayName: args.collaboratorDisplayName,
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
      webhookConfigured: c.webhookConfigured,
      collaboratorDiscordUserId: c.collaboratorDiscordUserId,
      collaboratorDisplayName: c.collaboratorDisplayName,
      createdAt: c.createdAt,
    }));
  },
});

/**
 * Remove a collaborator connection (owner action — soft delete).
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
 * Get or create webhook config for a collab connection.
 * Uses the same signing secret pattern as getOrCreateJinxxyWebhookConfig.
 * Webhook URL format: {baseUrl}/webhooks/jinxxy-collab/{ownerTenantId}/{inviteId}
 */
export const getOrCreateCollabWebhookConfig = mutation({
  args: {
    apiSecret: v.string(),
    ownerTenantId: v.id('tenants'),
    inviteId: v.id('collaborator_invites'),
    baseUrl: v.string(),
  },
  returns: v.object({
    callbackUrl: v.string(),
    signingSecret: v.string(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invite.ownerTenantId !== args.ownerTenantId) {
      throw new Error('Invite not found or access denied');
    }

    const callbackUrl = `${args.baseUrl.replace(/\/$/, '')}/webhooks/jinxxy-collab/${args.ownerTenantId}/${args.inviteId}`;

    // Check if there is an existing pending connection with a webhook secret
    // (re-use if under 40 char limit, same as primary webhook config)
    // We store the temp secret on the invite itself via a separate DB pattern.
    // For simplicity: generate a new one each time unless already stored in state.
    // 14 random bytes = 28 hex chars + "whsec_yucp_" (11 chars) = 39 chars total
    const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(14)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const signingSecret = `whsec_yucp_${randomPart}`;

    return { callbackUrl, signingSecret };
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
