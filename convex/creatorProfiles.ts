/**
 * Creator Profiles - Creator organizations (user-first architecture)
 *
 * Creator profiles are created when a creator completes onboarding (e.g. Discord bot install).
 * All creator-scoped data (verification sessions, guild links, entitlements) references a creator
 * profile via authUserId (Better Auth user ID).
 *
 * Requires CONVEX_API_SECRET for API-to-Convex calls.
 */

import { ConvexError, v } from 'convex/values';
import { components } from './_generated/api';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalQuery, mutation, query } from './_generated/server';
import { ApiActorBindingV, requireDelegatedAuthUserActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';
import { requireCreatorWorkspaceActor } from './lib/creatorWorkspaceAccess';

const DELIVERY_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PUBLIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type CreatorNamespaceKind = 'public' | 'delivery';

function validateCreatorSlug(slug: string, kind: CreatorNamespaceKind): string {
  const normalized = slug.trim().toLowerCase();
  const pattern = kind === 'delivery' ? DELIVERY_SLUG_PATTERN : PUBLIC_SLUG_PATTERN;
  const maxLength = kind === 'delivery' ? 63 : 64;
  if (slug !== normalized || normalized.length > maxLength || !pattern.test(normalized)) {
    throw new ConvexError(
      kind === 'delivery'
        ? 'Private VPM subdomain must use lowercase letters, numbers, and hyphens'
        : 'Public handle must use lowercase letters, numbers, and hyphens'
    );
  }
  return normalized;
}

async function findCreatorNamespaceOwner(
  ctx: QueryCtx | MutationCtx,
  slug: string
): Promise<string | null> {
  const [publicNamespace, deliveryNamespace, publicProfile, deliveryProfile] = await Promise.all([
    ctx.db
      .query('creator_namespaces')
      .withIndex('by_kind_slug', (q) => q.eq('kind', 'public').eq('slug', slug))
      .first(),
    ctx.db
      .query('creator_namespaces')
      .withIndex('by_kind_slug', (q) => q.eq('kind', 'delivery').eq('slug', slug))
      .first(),
    ctx.db
      .query('creator_profiles')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .first(),
    ctx.db
      .query('creator_profiles')
      .withIndex('by_delivery_slug', (q) => q.eq('deliverySlug', slug))
      .first(),
  ]);
  const owners = new Set(
    [publicNamespace, deliveryNamespace, publicProfile, deliveryProfile]
      .map((candidate) =>
        candidate
          ? 'creatorAuthUserId' in candidate
            ? candidate.creatorAuthUserId
            : candidate.authUserId
          : null
      )
      .filter((owner): owner is string => owner !== null)
  );
  if (owners.size > 1) {
    throw new ConvexError('Creator namespace ownership is inconsistent');
  }
  return owners.values().next().value ?? null;
}

async function assertCreatorNamespaceAvailable(
  ctx: QueryCtx | MutationCtx,
  slug: string,
  authUserId: string
): Promise<void> {
  const owner = await findCreatorNamespaceOwner(ctx, slug);
  if (owner && owner !== authUserId) {
    throw new ConvexError('Creator namespace is already in use');
  }
}

async function setActiveCreatorNamespace(
  ctx: MutationCtx,
  input: {
    authUserId: string;
    kind: CreatorNamespaceKind;
    previousSlug?: string;
    slug: string;
    now: number;
  }
): Promise<void> {
  const activeNamespaces = await ctx.db
    .query('creator_namespaces')
    .withIndex('by_creator_kind_status', (q) =>
      q.eq('creatorAuthUserId', input.authUserId).eq('kind', input.kind).eq('status', 'active')
    )
    .collect();
  for (const namespace of activeNamespaces) {
    if (namespace.slug !== input.slug) {
      await ctx.db.patch(namespace._id, { status: 'alias', updatedAt: input.now });
    }
  }

  if (input.previousSlug && input.previousSlug !== input.slug) {
    const previous = await ctx.db
      .query('creator_namespaces')
      .withIndex('by_kind_slug', (q) =>
        q.eq('kind', input.kind).eq('slug', input.previousSlug as string)
      )
      .first();
    if (previous) {
      if (previous.creatorAuthUserId !== input.authUserId) {
        throw new ConvexError('Creator namespace is already in use');
      }
      await ctx.db.patch(previous._id, { status: 'alias', updatedAt: input.now });
    } else {
      await ctx.db.insert('creator_namespaces', {
        creatorAuthUserId: input.authUserId,
        kind: input.kind,
        slug: input.previousSlug,
        status: 'alias',
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
  }

  const target = await ctx.db
    .query('creator_namespaces')
    .withIndex('by_kind_slug', (q) => q.eq('kind', input.kind).eq('slug', input.slug))
    .first();
  if (target) {
    if (target.creatorAuthUserId !== input.authUserId) {
      throw new ConvexError('Creator namespace is already in use');
    }
    await ctx.db.patch(target._id, { status: 'active', updatedAt: input.now });
    return;
  }
  await ctx.db.insert('creator_namespaces', {
    creatorAuthUserId: input.authUserId,
    kind: input.kind,
    slug: input.slug,
    status: 'active',
    createdAt: input.now,
    updatedAt: input.now,
  });
}

const PolicyInput = v.optional(
  v.object({
    maxBindingsPerProduct: v.optional(v.number()),
    allowTransfer: v.optional(v.boolean()),
    transferCooldownHours: v.optional(v.number()),
    allowSharedUse: v.optional(v.boolean()),
    maxUnityInstallations: v.optional(v.number()),
    autoVerifyOnJoin: v.optional(v.boolean()),
    revocationBehavior: v.optional(v.string()),
    gracePeriodHours: v.optional(v.number()),
    requireFullProductLinkSetOnSetup: v.optional(v.boolean()),
    allowCatalogLinkResolution: v.optional(v.boolean()),
    manualReviewRequired: v.optional(v.boolean()),
    discordRoleFreshnessMinutes: v.optional(v.number()),
    allowCatalogBackedVerification: v.optional(v.boolean()),
    autoDiscoverSupportedProductsForRememberedPurchaser: v.optional(v.boolean()),
    // Discord onboarding config
    logChannelId: v.optional(v.string()),
    verificationScope: v.optional(v.union(v.literal('account'), v.literal('license'))),
    shareVerificationWithServers: v.optional(v.boolean()),
    shareVerificationScope: v.optional(v.string()),
    duplicateVerificationBehavior: v.optional(
      v.union(v.literal('block'), v.literal('notify'), v.literal('allow'))
    ),
    duplicateVerificationNotifyChannelId: v.optional(v.string()),
    suspiciousAccountBehavior: v.optional(
      v.union(v.literal('quarantine'), v.literal('notify'), v.literal('revoke'))
    ),
    suspiciousNotifyChannelId: v.optional(v.string()),
    enableDiscordRoleFromOtherServers: v.optional(v.boolean()),
    allowedSourceGuildIds: v.optional(v.array(v.string())),
    allowMismatchedEmails: v.optional(v.boolean()),
  })
);

/**
 * Create (or return existing) creator profile. Called by API after creator onboarding.
 * Returns the Convex _id of the creator_profiles document.
 */
export const createCreatorProfile = mutation({
  args: {
    apiSecret: v.string(),
    name: v.string(),
    ownerDiscordUserId: v.string(),
    authUserId: v.string(),
    slug: v.optional(v.string()),
    policy: PolicyInput,
  },
  returns: v.id('creator_profiles'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const name = args.name.trim();
    if (name.length > 100) throw new ConvexError('name must be 100 characters or fewer');
    if (args.slug) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.slug) || args.slug.length > 64) {
        throw new ConvexError(
          'Slug must be lowercase alphanumeric with hyphens, max 64 characters'
        );
      }
    }

    const existing = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (existing) {
      return existing._id;
    }

    if (args.slug) {
      const [slugOwner, deliverySlugOwner] = await Promise.all([
        ctx.db
          .query('creator_profiles')
          .withIndex('by_slug', (q) => q.eq('slug', args.slug))
          .first(),
        ctx.db
          .query('creator_profiles')
          .withIndex('by_delivery_slug', (q) => q.eq('deliverySlug', args.slug))
          .first(),
      ]);
      if (slugOwner || deliverySlugOwner) {
        throw new ConvexError('Slug is already in use');
      }
    }

    return await ctx.db.insert('creator_profiles', {
      authUserId: args.authUserId,
      name: name,
      ownerDiscordUserId: args.ownerDiscordUserId,
      slug: args.slug,
      status: 'active',
      policy: args.policy,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Update the creator-facing identity and both owned URL namespaces.
 *
 * Namespace changes are append-only from a routing perspective. Previous values become aliases
 * so old buyer links and private VPM repository URLs remain valid.
 */
export const updateIdentity = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    name: v.string(),
    publicSlug: v.string(),
    deliverySlug: v.string(),
  },
  returns: v.object({
    name: v.string(),
    publicSlug: v.string(),
    deliverySlug: v.string(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const name = args.name.trim();
    if (!name) {
      throw new ConvexError('Creator name is required');
    }
    if (name.length > 100) {
      throw new ConvexError('Creator name must be 100 characters or fewer');
    }
    const publicSlug = validateCreatorSlug(args.publicSlug, 'public');
    const deliverySlug = validateCreatorSlug(args.deliverySlug, 'delivery');
    await assertCreatorNamespaceAvailable(ctx, publicSlug, args.authUserId);
    if (deliverySlug !== publicSlug) {
      await assertCreatorNamespaceAvailable(ctx, deliverySlug, args.authUserId);
    }

    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!profile || profile.status !== 'active') {
      throw new ConvexError('Creator profile is not available');
    }

    const now = Date.now();
    await setActiveCreatorNamespace(ctx, {
      authUserId: args.authUserId,
      kind: 'public',
      previousSlug: profile.slug,
      slug: publicSlug,
      now,
    });
    await setActiveCreatorNamespace(ctx, {
      authUserId: args.authUserId,
      kind: 'delivery',
      previousSlug: profile.deliverySlug,
      slug: deliverySlug,
      now,
    });
    await ctx.db.patch(profile._id, {
      name,
      slug: publicSlug,
      deliverySlug,
      updatedAt: now,
    });

    const activeVpmLinks = await ctx.db
      .query('creator_vpm_links')
      .withIndex('by_creator_status', (q) =>
        q.eq('creatorAuthUserId', args.authUserId).eq('status', 'active')
      )
      .collect();
    for (const link of activeVpmLinks) {
      if (link.creatorSlug !== deliverySlug) {
        await ctx.db.patch(link._id, { creatorSlug: deliverySlug, updatedAt: now });
      }
    }

    return { name, publicSlug, deliverySlug };
  },
});

/**
 * Assign the initial DNS label used by creator-owned private delivery hosts.
 *
 * Convex mutations are serializable, so checking both namespace indexes and patching the
 * profile in one mutation prevents two creators from claiming the same label.
 */
export const ensureDeliverySlug = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    proposedSlugs: v.array(v.string()),
  },
  returns: v.object({
    created: v.boolean(),
    slug: v.string(),
  }),
  handler: async (ctx, args): Promise<{ created: boolean; slug: string }> => {
    requireApiSecret(args.apiSecret);
    await requireCreatorWorkspaceActor(ctx, args.actor, args.authUserId);
    if (args.proposedSlugs.length === 0 || args.proposedSlugs.length > 8) {
      throw new ConvexError('Creator delivery slug candidates are invalid');
    }
    const proposedSlugs = [...new Set(args.proposedSlugs)];
    if (
      proposedSlugs.some(
        (slug) => slug !== slug.trim().toLowerCase() || !DELIVERY_SLUG_PATTERN.test(slug)
      )
    ) {
      throw new ConvexError('Creator delivery slug candidate is invalid');
    }

    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!profile || profile.status !== 'active') {
      throw new ConvexError('Creator profile is not available');
    }

    if (profile.deliverySlug && DELIVERY_SLUG_PATTERN.test(profile.deliverySlug)) {
      const owners = await ctx.db
        .query('creator_profiles')
        .withIndex('by_delivery_slug', (q) => q.eq('deliverySlug', profile.deliverySlug))
        .collect();
      if (owners.length === 1 && owners[0]?._id === profile._id) {
        await assertCreatorNamespaceAvailable(ctx, profile.deliverySlug, args.authUserId);
        await setActiveCreatorNamespace(ctx, {
          authUserId: args.authUserId,
          kind: 'delivery',
          previousSlug: profile.deliverySlug,
          slug: profile.deliverySlug,
          now: Date.now(),
        });
        return { created: false, slug: profile.deliverySlug };
      }
    }

    for (const slug of proposedSlugs) {
      const namespaceOwner = await findCreatorNamespaceOwner(ctx, slug);
      if (namespaceOwner && namespaceOwner !== args.authUserId) {
        continue;
      }
      const [deliveryOwners, publicOwners] = await Promise.all([
        ctx.db
          .query('creator_profiles')
          .withIndex('by_delivery_slug', (q) => q.eq('deliverySlug', slug))
          .collect(),
        ctx.db
          .query('creator_profiles')
          .withIndex('by_slug', (q) => q.eq('slug', slug))
          .collect(),
      ]);
      const deliveryAvailable =
        deliveryOwners.length === 0 ||
        (deliveryOwners.length === 1 && deliveryOwners[0]?._id === profile._id);
      const publicNamespaceAvailable =
        publicOwners.length === 0 ||
        (publicOwners.length === 1 && publicOwners[0]?._id === profile._id);
      if (deliveryAvailable && publicNamespaceAvailable) {
        const now = Date.now();
        await setActiveCreatorNamespace(ctx, {
          authUserId: args.authUserId,
          kind: 'delivery',
          previousSlug: profile.deliverySlug,
          slug,
          now,
        });
        await ctx.db.patch(profile._id, {
          deliverySlug: slug,
          updatedAt: now,
        });
        return { created: profile.deliverySlug !== slug, slug };
      }
    }

    throw new ConvexError('Creator delivery slug candidates are already in use');
  },
});

/**
 * Get creator profile by slug. Used for human-friendly URL resolution.
 */
export const getCreatorBySlug = query({
  args: {
    apiSecret: v.string(),
    slug: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('creator_profiles'),
      slug: v.optional(v.string()),
      name: v.string(),
      status: v.string(),
      createdAt: v.number(),
      authUserId: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const namespace = await ctx.db
      .query('creator_namespaces')
      .withIndex('by_kind_slug', (q) => q.eq('kind', 'public').eq('slug', args.slug))
      .first();
    const profile = namespace
      ? await ctx.db
          .query('creator_profiles')
          .withIndex('by_auth_user', (q) => q.eq('authUserId', namespace.creatorAuthUserId))
          .first()
      : await ctx.db
          .query('creator_profiles')
          .withIndex('by_slug', (q) => q.eq('slug', args.slug))
          .first();
    if (!profile) return null;
    return {
      _id: profile._id,
      slug: profile.slug,
      name: profile.name,
      status: profile.status,
      createdAt: profile.createdAt,
      authUserId: profile.authUserId,
    };
  },
});

/**
 * Resolve a current or historical private delivery hostname to its creator and canonical label.
 */
export const resolveDeliveryNamespace = query({
  args: {
    apiSecret: v.string(),
    creatorSlug: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      authUserId: v.string(),
      canonicalSlug: v.string(),
      status: v.union(v.literal('active'), v.literal('alias')),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const namespace = await ctx.db
      .query('creator_namespaces')
      .withIndex('by_kind_slug', (q) => q.eq('kind', 'delivery').eq('slug', args.creatorSlug))
      .first();
    const profile = namespace
      ? await ctx.db
          .query('creator_profiles')
          .withIndex('by_auth_user', (q) => q.eq('authUserId', namespace.creatorAuthUserId))
          .first()
      : await ctx.db
          .query('creator_profiles')
          .withIndex('by_delivery_slug', (q) => q.eq('deliverySlug', args.creatorSlug))
          .first();
    if (!profile || profile.status !== 'active' || !profile.deliverySlug) {
      return null;
    }
    return {
      authUserId: profile.authUserId,
      canonicalSlug: profile.deliverySlug,
      status: namespace?.status ?? 'active',
    };
  },
});

/**
 * Get creator profile by authUserId.
 */
export const getCreatorProfile = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('creator_profiles'),
      _creationTime: v.number(),
      authUserId: v.string(),
      name: v.string(),
      ownerDiscordUserId: v.string(),
      slug: v.optional(v.string()),
      deliverySlug: v.optional(v.string()),
      status: v.string(),
      policy: v.optional(v.any()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
  },
});

/**
 * Update creator policy (partial). Used by bot during onboarding.
 */
export const updateCreatorPolicy = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    policy: PolicyInput,
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!profile) throw new Error('Creator profile not found');
    const now = Date.now();
    const merged = {
      ...profile.policy,
      ...args.policy,
    };
    await ctx.db.patch(profile._id, {
      policy: merged,
      updatedAt: now,
    });
  },
});

/**
 * Get creator profile by authUserId. Used when creator logs in.
 */
export const getCreatorByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('creator_profiles'),
      _creationTime: v.number(),
      authUserId: v.string(),
      name: v.string(),
      ownerDiscordUserId: v.string(),
      slug: v.optional(v.string()),
      status: v.string(),
      policy: v.optional(v.any()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
  },
});

/**
 * Get Discord user ID from Better Auth user ID.
 * Finds the linked Discord OAuth account via the Better Auth component adapter.
 * Must be internalQuery since it calls an internal component function.
 */
export const getDiscordUserIdFromAuthUser = internalQuery({
  args: {
    authUserId: v.string(),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const result = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'account',
      where: [
        { field: 'userId', operator: 'eq', value: args.authUserId },
        { field: 'providerId', operator: 'eq', value: 'discord', connector: 'AND' },
      ],
      paginationOpts: { cursor: null, numItems: 1 },
    });

    if (result?.page?.length > 0) {
      return result.page[0].providerAccountId as string;
    }

    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (subject) {
      return subject.primaryDiscordUserId;
    }

    return null;
  },
});

/**
 * Get creator profile by authUserId. Alias for public API surface.
 */
export const getByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('creator_profiles'),
      _creationTime: v.number(),
      authUserId: v.string(),
      name: v.string(),
      ownerDiscordUserId: v.string(),
      slug: v.optional(v.string()),
      status: v.string(),
      policy: v.optional(v.any()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
  },
});

/**
 * Patch the policy field of a creator profile. Returns the updated profile or null if not found.
 */
export const updatePolicy = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    policyPatch: v.any(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('creator_profiles'),
      _creationTime: v.number(),
      authUserId: v.string(),
      name: v.string(),
      ownerDiscordUserId: v.string(),
      slug: v.optional(v.string()),
      status: v.string(),
      policy: v.optional(v.any()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!profile) return null;
    const now = Date.now();
    const merged = { ...profile.policy, ...args.policyPatch };
    await ctx.db.patch(profile._id, { policy: merged, updatedAt: now });
    return await ctx.db.get(profile._id);
  },
});
