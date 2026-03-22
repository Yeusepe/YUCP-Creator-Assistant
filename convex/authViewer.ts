import { ConvexError, v } from 'convex/values';
import { components } from './_generated/api';
import { type QueryCtx, query } from './_generated/server';
import { authComponent } from './auth';
import { buildBetterAuthUserProviderLookupWhere } from './lib/betterAuthAdapter';

const ViewerValue = v.object({
  authUserId: v.string(),
  name: v.union(v.string(), v.null()),
  email: v.union(v.string(), v.null()),
  image: v.union(v.string(), v.null()),
  discordUserId: v.union(v.string(), v.null()),
});

interface AuthUserRecord {
  id?: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

interface DiscordAccountRecord {
  accountId?: string;
}

async function resolveViewer(ctx: QueryCtx) {
  const authUser = (await authComponent.getAuthUser(ctx)) as AuthUserRecord | null;

  if (!authUser?.id) {
    return null;
  }

  const discordAccount = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'account',
    where: buildBetterAuthUserProviderLookupWhere(authUser.id, 'discord'),
    select: ['accountId'],
  })) as DiscordAccountRecord | null;

  return {
    authUserId: authUser.id,
    name: authUser.name ?? null,
    email: authUser.email ?? null,
    image: authUser.image ?? null,
    discordUserId: discordAccount?.accountId ?? null,
  };
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
