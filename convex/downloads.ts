import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';

const RoleLogic = v.union(v.literal('all'), v.literal('any'));
const DownloadArtifactStatus = v.union(
  v.literal('active'),
  v.literal('deleted'),
  v.literal('failed')
);
const DownloadArtifactSourceMode = v.union(v.literal('reply'), v.literal('webhook'));

const DownloadFile = v.object({
  filename: v.string(),
  url: v.string(),
  size: v.optional(v.number()),
  contentType: v.optional(v.string()),
  extension: v.string(),
});

export const listRoutesByGuild = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db
      .query('download_routes')
      .withIndex('by_auth_user_guild', (q) =>
        q.eq('authUserId', args.authUserId).eq('guildId', args.guildId)
      )
      .order('asc')
      .collect();
  },
});

export const getRouteById = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    routeId: v.id('download_routes'),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const doc = await ctx.db.get(args.routeId);
    if (!doc || doc.authUserId !== args.authUserId) return null;
    return doc;
  },
});

export const getActiveRoutesForChannel = query({
  args: {
    apiSecret: v.string(),
    guildId: v.string(),
    channelIds: v.array(v.string()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    if (args.channelIds.length > 50) {
      throw new ConvexError('channelIds cannot exceed 50 entries');
    }
    const uniqueChannelIds = [...new Set(args.channelIds.filter(Boolean))];
    if (uniqueChannelIds.length === 0) return [];

    const results: any[] = [];
    const seen = new Set<string>();
    for (const channelId of uniqueChannelIds) {
      const routes = await ctx.db
        .query('download_routes')
        .withIndex('by_guild_source_channel', (q) =>
          q.eq('guildId', args.guildId).eq('sourceChannelId', channelId)
        )
        .collect();
      for (const route of routes) {
        if (!route.enabled) continue;
        if (seen.has(route._id)) continue;
        seen.add(route._id);
        results.push(route);
      }
    }
    return results;
  },
});

export const createRoute = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
    guildLinkId: v.id('guild_links'),
    sourceChannelId: v.string(),
    archiveChannelId: v.string(),
    messageTitle: v.string(),
    messageBody: v.string(),
    requiredRoleIds: v.array(v.string()),
    roleLogic: RoleLogic,
    allowedExtensions: v.array(v.string()),
    enabled: v.optional(v.boolean()),
  },
  returns: v.object({
    routeId: v.id('download_routes'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const normalizedExtensions = [
      ...new Set(args.allowedExtensions.map((ext) => ext.trim().toLowerCase()).filter(Boolean)),
    ];
    const normalizedRoleIds = [
      ...new Set(args.requiredRoleIds.map((roleId) => roleId.trim()).filter(Boolean)),
    ];
    const messageTitle = args.messageTitle.trim();
    const messageBody = args.messageBody.trim();

    if (normalizedExtensions.length === 0) {
      throw new Error('At least one allowed extension is required');
    }
    if (normalizedRoleIds.length === 0) {
      throw new Error('At least one required role is required');
    }
    if (!messageTitle) {
      throw new Error('A message title is required');
    }
    if (!messageBody) {
      throw new Error('A message body is required');
    }
    if (messageTitle.length > 256)
      throw new ConvexError('messageTitle must be 256 characters or fewer');
    if (messageBody.length > 4000)
      throw new ConvexError('messageBody must be 4000 characters or fewer');

    const routeId = await ctx.db.insert('download_routes', {
      authUserId: args.authUserId,
      guildId: args.guildId,
      guildLinkId: args.guildLinkId,
      sourceChannelId: args.sourceChannelId,
      archiveChannelId: args.archiveChannelId,
      messageTitle,
      messageBody,
      requiredRoleIds: normalizedRoleIds,
      roleLogic: args.roleLogic,
      allowedExtensions: normalizedExtensions,
      enabled: args.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });

    return { routeId };
  },
});

export const toggleRoute = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    routeId: v.id('download_routes'),
    enabled: v.boolean(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const route = await ctx.db.get(args.routeId);
    if (!route) throw new Error(`Download route not found: ${args.routeId}`);
    if (route.authUserId !== args.authUserId) throw new ConvexError('Unauthorized: not the owner');
    await ctx.db.patch(args.routeId, {
      enabled: args.enabled,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

export const updateRouteMessage = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    routeId: v.id('download_routes'),
    messageTitle: v.string(),
    messageBody: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const route = await ctx.db.get(args.routeId);
    if (!route) throw new Error(`Download route not found: ${args.routeId}`);
    if (route.authUserId !== args.authUserId) throw new ConvexError('Unauthorized: not the owner');

    const messageTitle = args.messageTitle.trim();
    const messageBody = args.messageBody.trim();
    if (!messageTitle) throw new Error('A message title is required');
    if (!messageBody) throw new Error('A message body is required');
    if (messageTitle.length > 256)
      throw new ConvexError('messageTitle must be 256 characters or fewer');
    if (messageBody.length > 4000)
      throw new ConvexError('messageBody must be 4000 characters or fewer');

    await ctx.db.patch(args.routeId, {
      messageTitle,
      messageBody,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

export const deleteRoute = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    routeId: v.id('download_routes'),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const route = await ctx.db.get(args.routeId);
    if (!route) throw new Error(`Download route not found: ${args.routeId}`);
    if (route.authUserId !== args.authUserId) throw new ConvexError('Unauthorized: not the owner');

    const artifacts = await ctx.db
      .query('download_artifacts')
      .withIndex('by_route', (q) => q.eq('routeId', args.routeId))
      .collect();

    const now = Date.now();
    for (const artifact of artifacts) {
      await ctx.db.patch(artifact._id, {
        status: 'deleted',
        updatedAt: now,
      });
    }

    await ctx.db.delete(args.routeId);
    return { success: true };
  },
});

export const createArtifact = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
    routeId: v.id('download_routes'),
    sourceChannelId: v.string(),
    sourceMessageId: v.string(),
    sourceMessageUrl: v.string(),
    sourceAuthorId: v.string(),
    archiveChannelId: v.string(),
    archiveMessageId: v.string(),
    archiveThreadId: v.optional(v.string()),
    sourceRelayMessageId: v.optional(v.string()),
    sourceDeliveryMode: v.optional(DownloadArtifactSourceMode),
    requiredRoleIds: v.array(v.string()),
    roleLogic: RoleLogic,
    files: v.array(DownloadFile),
    status: v.optional(DownloadArtifactStatus),
  },
  returns: v.object({
    artifactId: v.id('download_artifacts'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    for (const file of args.files) {
      if (!file.url.startsWith('https://')) {
        throw new ConvexError('Download URLs must use HTTPS');
      }
    }
    const now = Date.now();
    const artifactId = await ctx.db.insert('download_artifacts', {
      authUserId: args.authUserId,
      guildId: args.guildId,
      routeId: args.routeId,
      sourceChannelId: args.sourceChannelId,
      sourceMessageId: args.sourceMessageId,
      sourceMessageUrl: args.sourceMessageUrl,
      sourceAuthorId: args.sourceAuthorId,
      archiveChannelId: args.archiveChannelId,
      archiveMessageId: args.archiveMessageId,
      archiveThreadId: args.archiveThreadId,
      sourceRelayMessageId: args.sourceRelayMessageId,
      sourceDeliveryMode: args.sourceDeliveryMode,
      requiredRoleIds: [...new Set(args.requiredRoleIds)],
      roleLogic: args.roleLogic,
      files: args.files,
      status: args.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    });
    return { artifactId };
  },
});

export const updateArtifactSourceRelay = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    artifactId: v.id('download_artifacts'),
    sourceRelayMessageId: v.optional(v.string()),
    sourceDeliveryMode: DownloadArtifactSourceMode,
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) throw new Error(`Download artifact not found: ${args.artifactId}`);
    if (artifact.authUserId !== args.authUserId)
      throw new ConvexError('Unauthorized: not the owner');
    await ctx.db.patch(args.artifactId, {
      sourceRelayMessageId: args.sourceRelayMessageId,
      sourceDeliveryMode: args.sourceDeliveryMode,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

export const markArtifactStatus = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    artifactId: v.id('download_artifacts'),
    status: DownloadArtifactStatus,
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) throw new Error(`Download artifact not found: ${args.artifactId}`);
    if (artifact.authUserId !== args.authUserId)
      throw new ConvexError('Unauthorized: not the owner');
    await ctx.db.patch(args.artifactId, {
      status: args.status,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

export const getArtifactForDelivery = query({
  args: {
    apiSecret: v.string(),
    artifactId: v.id('download_artifacts'),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db.get(args.artifactId);
  },
});

export const listActiveArtifactsByRoute = query({
  args: {
    apiSecret: v.string(),
    routeId: v.id('download_routes'),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const artifacts = await ctx.db
      .query('download_artifacts')
      .withIndex('by_route', (q) => q.eq('routeId', args.routeId))
      .collect();
    return artifacts.filter((artifact) => artifact.status === 'active');
  },
});

export const getArtifactBySourceMessage = query({
  args: {
    apiSecret: v.string(),
    sourceMessageId: v.string(),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db
      .query('download_artifacts')
      .withIndex('by_source_message', (q) => q.eq('sourceMessageId', args.sourceMessageId))
      .first();
  },
});


/**
 * List download_routes for a creator with optional guildId/enabled filters and pagination.
 */
export const listRoutesByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('download_routes')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.guildId !== undefined) {
      all = all.filter((r) => r.guildId === args.guildId);
    }
    if (args.enabled !== undefined) {
      all = all.filter((r) => r.enabled === args.enabled);
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
 * List download_artifacts for a creator with optional routeId/guildId/status filters and pagination.
 */
export const listArtifactsByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    routeId: v.optional(v.id('download_routes')),
    guildId: v.optional(v.string()),
    status: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('download_artifacts')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.routeId !== undefined) {
      all = all.filter((a) => a.routeId === args.routeId);
    }
    if (args.guildId !== undefined) {
      all = all.filter((a) => a.guildId === args.guildId);
    }
    if (args.status !== undefined) {
      all = all.filter((a) => a.status === args.status);
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
 * Get a single download_artifact by ID, scoped to authUserId.
 */
export const getArtifactById = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    artifactId: v.id('download_artifacts'),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const doc = await ctx.db.get(args.artifactId);
    if (!doc || doc.authUserId !== args.authUserId) return null;
    return doc;
  },
});
