import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import {
  ApiActorBindingV,
  requireDelegatedAuthUserActor,
  requireServiceActor,
} from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';

const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PACKAGE_ID_PATTERN = /^[a-z0-9\-_./:]{1,128}$/;

type ActiveCreatorVpmLink = {
  createdAt: number;
  linkId: string;
  packageId: string;
  status: 'active';
};

function serializeActiveLink(link: Doc<'creator_vpm_links'>): ActiveCreatorVpmLink {
  return {
    createdAt: link.createdAt,
    linkId: link.linkId,
    packageId: link.packageId,
    status: 'active',
  };
}

function validateLinkId(linkId: string): void {
  if (!LINK_ID_PATTERN.test(linkId)) {
    throw new ConvexError('VPM link ID is invalid');
  }
}

function validatePackageId(packageId: string): void {
  if (!PACKAGE_ID_PATTERN.test(packageId)) {
    throw new ConvexError('Package ID is invalid');
  }
}

async function requireOwnedPackage(
  ctx: QueryCtx | MutationCtx,
  input: {
    authUserId: string;
    packageId: string;
  }
): Promise<void> {
  validatePackageId(input.packageId);
  const registration = await ctx.db
    .query('package_registry')
    .withIndex('by_package_id', (q) => q.eq('packageId', input.packageId))
    .first();
  if (
    !registration ||
    registration.yucpUserId !== input.authUserId ||
    registration.status === 'archived'
  ) {
    throw new ConvexError('Package is not available');
  }
}

async function isLinkPackageAvailable(
  ctx: QueryCtx,
  link: Doc<'creator_vpm_links'>
): Promise<boolean> {
  const registration = await ctx.db
    .query('package_registry')
    .withIndex('by_package_id', (q) => q.eq('packageId', link.packageId))
    .first();
  if (
    !registration ||
    registration.yucpUserId !== link.creatorAuthUserId ||
    registration.status === 'archived'
  ) {
    return false;
  }
  const associations = await ctx.db
    .query('package_catalog_bindings')
    .withIndex('by_creator_package_status', (q) =>
      q
        .eq('creatorAuthUserId', link.creatorAuthUserId)
        .eq('packageId', link.packageId)
        .eq('status', 'active')
    )
    .first();
  if (!associations) {
    return false;
  }
  const release = await ctx.db
    .query('package_versions_ref')
    .withIndex('by_package_channel', (q) =>
      q.eq('packageId', link.packageId).eq('channel', 'stable').eq('state', 'READY')
    )
    .first();
  return Boolean(release);
}

export const getActiveForCreator = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      createdAt: v.number(),
      linkId: v.string(),
      packageId: v.string(),
      status: v.literal('active'),
    })
  ),
  handler: async (ctx, args): Promise<ActiveCreatorVpmLink | null> => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    await requireOwnedPackage(ctx, args);
    const link = await ctx.db
      .query('creator_vpm_links')
      .withIndex('by_creator_package_status', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', args.packageId)
          .eq('status', 'active')
      )
      .first();
    return link ? serializeActiveLink(link) : null;
  },
});

export const getActiveForPackageAccess = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      createdAt: v.number(),
      linkId: v.string(),
      packageId: v.string(),
      status: v.literal('active'),
    })
  ),
  handler: async (ctx, args): Promise<ActiveCreatorVpmLink | null> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    validatePackageId(args.packageId);
    const link = await ctx.db
      .query('creator_vpm_links')
      .withIndex('by_creator_package_status', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', args.packageId)
          .eq('status', 'active')
      )
      .first();
    if (!link || !(await isLinkPackageAvailable(ctx, link))) {
      return null;
    }
    return serializeActiveLink(link);
  },
});

export const ensureActive = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
    proposedLinkId: v.string(),
  },
  returns: v.object({
    created: v.boolean(),
    createdAt: v.number(),
    linkId: v.string(),
    packageId: v.string(),
    status: v.literal('active'),
  }),
  handler: async (ctx, args): Promise<ActiveCreatorVpmLink & { created: boolean }> => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    validateLinkId(args.proposedLinkId);
    await requireOwnedPackage(ctx, args);

    const existing = await ctx.db
      .query('creator_vpm_links')
      .withIndex('by_creator_package_status', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', args.packageId)
          .eq('status', 'active')
      )
      .first();
    if (existing) {
      return { ...serializeActiveLink(existing), created: false };
    }

    const duplicateLinkId = await ctx.db
      .query('creator_vpm_links')
      .withIndex('by_link_id', (q) => q.eq('linkId', args.proposedLinkId))
      .first();
    if (duplicateLinkId) {
      throw new ConvexError('VPM link ID is already in use');
    }

    const now = Date.now();
    await ctx.db.insert('creator_vpm_links', {
      creatorAuthUserId: args.authUserId,
      packageId: args.packageId,
      linkId: args.proposedLinkId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    return {
      created: true,
      createdAt: now,
      linkId: args.proposedLinkId,
      packageId: args.packageId,
      status: 'active',
    };
  },
});

export const revokeActive = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
  },
  returns: v.object({ revoked: v.boolean() }),
  handler: async (ctx, args): Promise<{ revoked: boolean }> => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    await requireOwnedPackage(ctx, args);
    const links = await ctx.db
      .query('creator_vpm_links')
      .withIndex('by_creator_package_status', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', args.packageId)
          .eq('status', 'active')
      )
      .collect();
    if (links.length === 0) {
      return { revoked: false };
    }
    const now = Date.now();
    for (const link of links) {
      await ctx.db.patch(link._id, {
        status: 'revoked',
        revokedAt: now,
        updatedAt: now,
      });
    }
    return { revoked: true };
  },
});

export const getActiveByLinkId = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    linkId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      createdAt: v.number(),
      linkId: v.string(),
      packageId: v.string(),
      status: v.literal('active'),
    })
  ),
  handler: async (ctx, args): Promise<ActiveCreatorVpmLink | null> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    if (!LINK_ID_PATTERN.test(args.linkId)) {
      return null;
    }
    const link = await ctx.db
      .query('creator_vpm_links')
      .withIndex('by_link_id', (q) => q.eq('linkId', args.linkId))
      .first();
    if (!link || link.status !== 'active') {
      return null;
    }
    if (!(await isLinkPackageAvailable(ctx, link))) {
      return null;
    }
    return serializeActiveLink(link);
  },
});
