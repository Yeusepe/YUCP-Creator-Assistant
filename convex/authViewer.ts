import { ConvexError, v } from 'convex/values';
import { components } from './_generated/api';
import { type QueryCtx, query } from './_generated/server';
import { getAuthenticatedAuthUser } from './lib/authUser';
import {
  buildBetterAuthUserLookupWhere,
  buildBetterAuthUserProviderLookupWhere,
} from './lib/betterAuthAdapter';
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

interface BetterAuthUserRecord {
  _id?: string;
  id?: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
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

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBetterAuthUserId(user: BetterAuthUserRecord | null, fallbackId: string): string | null {
  return getNonEmptyString(user?.id) ?? getNonEmptyString(user?._id) ?? getNonEmptyString(fallbackId);
}

async function resolveDiscordUserId(ctx: QueryCtx, authUserId: string): Promise<string | null> {
  try {
    const discordAccount = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'account',
      where: buildBetterAuthUserProviderLookupWhere(authUserId, 'discord'),
      select: ['accountId'],
    })) as DiscordAccountRecord | null;
    return discordAccount?.accountId ?? null;
  } catch (error) {
    console.error('[convex] authViewer discord lookup failed', {
      phase: 'convex-authviewer-discord-lookup',
      authUserId,
      error: serializeAuthViewerError(error),
    });
    throw error;
  }
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

  const discordUserId = await resolveDiscordUserId(ctx, authUser.authUserId);

  const viewer = {
    authUserId: authUser.authUserId,
    name: authUser.name ?? null,
    email: authUser.email ?? null,
    image: authUser.image ?? null,
    discordUserId,
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

export const getViewerByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.union(v.null(), ViewerValue),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: buildBetterAuthUserLookupWhere(args.authUserId),
      select: ['id', 'name', 'email', 'image'],
    })) as BetterAuthUserRecord | null;
    if (!user) {
      return null;
    }

    const normalizedAuthUserId = normalizeBetterAuthUserId(user, args.authUserId);
    if (!normalizedAuthUserId) {
      return null;
    }

    const discordUserId = await resolveDiscordUserId(ctx, normalizedAuthUserId);
    return {
      authUserId: normalizedAuthUserId,
      name: user?.name ?? null,
      email: user?.email ?? null,
      image: user?.image ?? null,
      discordUserId,
    };
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
