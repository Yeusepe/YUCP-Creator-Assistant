import { ConvexError, v } from 'convex/values';
import { components } from './_generated/api';
import { type QueryCtx, query } from './_generated/server';
import { getAuthenticatedAuthUser } from './lib/authUser';
import { buildBetterAuthUserProviderLookupWhere } from './lib/betterAuthAdapter';
import { requireApiSecret } from './lib/apiAuth';

const ViewerValue = v.object({
  authUserId: v.string(),
  name: v.union(v.string(), v.null()),
  email: v.union(v.string(), v.null()),
  image: v.union(v.string(), v.null()),
  discordUserId: v.union(v.string(), v.null()),
});

interface DiscordAccountRecord {
  accountId?: string;
}

function serializeAuthViewerError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}

async function resolveViewer(ctx: QueryCtx) {
  console.info('[convex] authViewer resolve started', {
    phase: 'convex-authviewer-resolve',
  });

  const authUser = await getAuthenticatedAuthUser(ctx);

  if (!authUser) {
    console.info('[convex] authViewer resolve completed', {
      phase: 'convex-authviewer-resolve',
      hasAuthUser: false,
    });
    return null;
  }

  let discordAccount: DiscordAccountRecord | null;
  try {
    discordAccount = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'account',
      where: buildBetterAuthUserProviderLookupWhere(authUser.authUserId, 'discord'),
      select: ['accountId'],
    })) as DiscordAccountRecord | null;
  } catch (error) {
    console.error('[convex] authViewer discord lookup failed', {
      phase: 'convex-authviewer-discord-lookup',
      authUserId: authUser.authUserId,
      error: serializeAuthViewerError(error),
    });
    throw error;
  }

  const viewer = {
    authUserId: authUser.authUserId,
    name: authUser.name ?? null,
    email: authUser.email ?? null,
    image: authUser.image ?? null,
    discordUserId: discordAccount?.accountId ?? null,
  };

  console.info('[convex] authViewer resolve completed', {
    phase: 'convex-authviewer-resolve',
    hasAuthUser: true,
    hasDiscordAccount: Boolean(viewer.discordUserId),
  });

  return viewer;
}

export const getViewer = query({
  args: {},
  returns: v.union(v.null(), ViewerValue),
  handler: async (ctx) => {
    return resolveViewer(ctx);
  },
});

export const assertViewerOwnsTenant = query({
  args: {
    ownerAuthUserId: v.string(),
  },
  returns: v.object({
    viewer: ViewerValue,
    ownsTenant: v.literal(true),
  }),
  handler: async (ctx, args) => {
    const viewer = await resolveViewer(ctx);
    if (!viewer) {
      throw new ConvexError('Unauthenticated');
    }

    const creatorProfile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q: any) => q.eq('authUserId', args.ownerAuthUserId))
      .first();

    if (!creatorProfile || creatorProfile.authUserId !== viewer.authUserId) {
      throw new ConvexError('Forbidden');
    }

    return {
      viewer,
      ownsTenant: true as const,
    };
  },
});

/**
 * Look up the Discord user ID for the given Better Auth user.
 * Requires the server API secret for access (not a user-authenticated query).
 * Used by the Bun API to populate discordUserId in verification begin flows.
 */
export const getDiscordUserIdByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const record = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'account',
      where: buildBetterAuthUserProviderLookupWhere(args.authUserId, 'discord'),
      select: ['accountId'],
    })) as DiscordAccountRecord | null;
    return record?.accountId ?? null;
  },
});
