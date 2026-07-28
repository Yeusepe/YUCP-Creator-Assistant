import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { ApiActorBindingV, requireServiceActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';

const DEFAULT_CHANNEL = 'stable';
const DEFAULT_EDITION = 'standard';
const MAX_EDITIONS_PER_PACKAGE = 64;

function editionOf(version: Pick<Doc<'package_versions_ref'>, 'editionId'>): string {
  return version.editionId ?? DEFAULT_EDITION;
}

function sharedText(values: ReadonlyArray<string | undefined>): string | undefined {
  const first = values[0];
  if (first === undefined || !values.every((value) => value === first)) {
    return undefined;
  }
  return first;
}

function canonicalBootstrapMedia(
  media: NonNullable<Doc<'package_versions_ref'>['bootstrapMedia']>
): NonNullable<Doc<'package_versions_ref'>['bootstrapMedia']> {
  return [...media].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.localPath.localeCompare(right.localPath) ||
      left.sha256.localeCompare(right.sha256) ||
      left.objectKey.localeCompare(right.objectKey) ||
      left.providerVersion.localeCompare(right.providerVersion)
  );
}

function bootstrapMediaKey(
  media: NonNullable<Doc<'package_versions_ref'>['bootstrapMedia']>
): string {
  return JSON.stringify(canonicalBootstrapMedia(media));
}

function canonicalJson(value: unknown): string {
  function canonicalize(input: unknown): unknown {
    if (Array.isArray(input)) {
      return input.map(canonicalize);
    }
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)])
      );
    }
    return input;
  }
  return JSON.stringify(canonicalize(value));
}

const RELEASE_PUBLICATION_FIELDS = [
  'activeContentDigest',
  'activePolicyVersion',
  'bindingRoot',
  'commonRoot',
  'logicalBytes',
  'logicalFiles',
  'manifestSha256',
  'protectedFiles',
  'protectedSourceRoot',
  'protectionPolicyDigest',
  'protectionPolicyId',
  'releaseRoot',
  'vpmDependencies',
  'vpmRepositories',
] as const;

function hasCompleteReleasePublication(version: Doc<'package_versions_ref'>): boolean {
  return RELEASE_PUBLICATION_FIELDS.every((field) => version[field] !== undefined);
}

function immutableVersionPayload(
  version: Pick<
    Doc<'package_versions_ref'>,
    | 'activeContentDigest'
    | 'activePolicyVersion'
    | 'bindingRoot'
    | 'bootstrapMedia'
    | 'catalogProductId'
    | 'channel'
    | 'commonRoot'
    | 'createdAt'
    | 'editionId'
    | 'logicalBytes'
    | 'logicalFiles'
    | 'manifestSha256'
    | 'packageId'
    | 'packageMetadata'
    | 'protectedFiles'
    | 'protectedSourceRoot'
    | 'protectionPolicyDigest'
    | 'protectionPolicyId'
    | 'releaseRoot'
    | 'version'
    | 'versionId'
    | 'vpmDependencies'
    | 'vpmRepositories'
  >
): unknown {
  return {
    activeContentDigest: version.activeContentDigest,
    activePolicyVersion: version.activePolicyVersion,
    bindingRoot: version.bindingRoot,
    bootstrapMedia: version.bootstrapMedia ?? [],
    catalogProductId: version.catalogProductId,
    channel: version.channel ?? DEFAULT_CHANNEL,
    commonRoot: version.commonRoot,
    createdAt: version.createdAt,
    editionId: editionOf(version),
    logicalBytes: version.logicalBytes,
    logicalFiles: version.logicalFiles,
    manifestSha256: version.manifestSha256,
    packageId: version.packageId,
    packageMetadata: version.packageMetadata,
    protectedFiles: version.protectedFiles,
    protectedSourceRoot: version.protectedSourceRoot,
    protectionPolicyDigest: version.protectionPolicyDigest,
    protectionPolicyId: version.protectionPolicyId,
    releaseRoot: version.releaseRoot,
    version: version.version,
    versionId: version.versionId,
    vpmDependencies: version.vpmDependencies,
    vpmRepositories: version.vpmRepositories,
  };
}

async function resolveUniqueCatalogProductEdition(
  ctx: QueryCtx,
  catalogProductId: Id<'product_catalog'>,
  requestedPackageId: string | undefined
): Promise<{ editionId: string; packageId: string } | null> {
  const product = await ctx.db.get(catalogProductId);
  if (!product || product.status === 'hidden') {
    return null;
  }
  const bindings = await ctx.db
    .query('package_catalog_bindings')
    .withIndex('by_catalog_product_status', (q) =>
      q.eq('catalogProductId', catalogProductId).eq('status', 'active')
    )
    .take(2);
  if (bindings.length !== 1) {
    return null;
  }
  const binding = bindings[0];
  if (
    !binding ||
    binding.creatorAuthUserId !== product.authUserId ||
    (requestedPackageId !== undefined && binding.packageId !== requestedPackageId)
  ) {
    return null;
  }
  const registration = await ctx.db
    .query('package_registry')
    .withIndex('by_package_id', (q) => q.eq('packageId', binding.packageId))
    .unique();
  if (
    !registration ||
    registration.status === 'archived' ||
    registration.yucpUserId !== product.authUserId
  ) {
    return null;
  }
  const editions = await ctx.db
    .query('package_editions')
    .withIndex('by_creator_package', (q) =>
      q.eq('creatorAuthUserId', product.authUserId).eq('packageId', binding.packageId)
    )
    .take(MAX_EDITIONS_PER_PACKAGE + 1);
  if (editions.length > MAX_EDITIONS_PER_PACKAGE) {
    return null;
  }
  const matchingEditions = editions.filter(
    (edition) => edition.status === 'active' && edition.catalogProductIds.includes(catalogProductId)
  );
  if (matchingEditions.length !== 1 || !matchingEditions[0]) {
    return null;
  }
  return {
    editionId: matchingEditions[0].editionId,
    packageId: binding.packageId,
  };
}

async function resolveDownloadScope(
  ctx: QueryCtx,
  input: {
    catalogProductId?: Id<'product_catalog'>;
    editionId?: string;
    packageId?: string;
  }
): Promise<{ editionId: string; packageId: string } | null> {
  if (input.catalogProductId) {
    const resolved = await resolveUniqueCatalogProductEdition(
      ctx,
      input.catalogProductId,
      input.packageId
    );
    if (!resolved || (input.editionId !== undefined && input.editionId !== resolved.editionId)) {
      return null;
    }
    return resolved;
  }
  if (!input.packageId || !input.editionId) {
    return null;
  }
  return {
    editionId: input.editionId,
    packageId: input.packageId,
  };
}

async function requirePublicationEdition(
  ctx: MutationCtx,
  input: {
    catalogProductId: Id<'product_catalog'>;
    editionId: string;
    packageId: string;
  }
): Promise<void> {
  const registration = await ctx.db
    .query('package_registry')
    .withIndex('by_package_id', (q) => q.eq('packageId', input.packageId))
    .unique();
  if (!registration || registration.status === 'archived') {
    throw new Error('Active package registration is required');
  }
  const product = await ctx.db.get(input.catalogProductId);
  if (!product || product.status === 'hidden' || product.authUserId !== registration.yucpUserId) {
    throw new Error('Active creator-owned catalog product is required');
  }
  const edition = await ctx.db
    .query('package_editions')
    .withIndex('by_creator_package_edition', (q) =>
      q
        .eq('creatorAuthUserId', registration.yucpUserId)
        .eq('packageId', input.packageId)
        .eq('editionId', input.editionId)
    )
    .unique();
  if (
    !edition ||
    edition.status !== 'active' ||
    !edition.catalogProductIds.includes(input.catalogProductId)
  ) {
    throw new Error('Package edition does not contain the catalog product');
  }
}

export const upsertReadyVersion = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    packageId: v.string(),
    editionId: v.optional(v.string()),
    version: v.string(),
    versionId: v.string(),
    activeContentDigest: v.string(),
    activePolicyVersion: v.string(),
    bindingRoot: v.string(),
    bootstrapMedia: v.optional(
      v.array(
        v.object({
          bucketName: v.string(),
          byteSize: v.number(),
          contentType: v.union(v.literal('image/png'), v.literal('image/jpeg')),
          kind: v.union(
            v.literal('icon'),
            v.literal('banner'),
            v.literal('gallery'),
            v.literal('product-link')
          ),
          label: v.optional(v.string()),
          localPath: v.string(),
          objectKey: v.string(),
          ordinal: v.optional(v.number()),
          providerVersion: v.string(),
          sha256: v.string(),
          url: v.optional(v.string()),
        })
      )
    ),
    commonRoot: v.string(),
    logicalBytes: v.number(),
    logicalFiles: v.number(),
    manifestSha256: v.string(),
    packageMetadata: v.optional(
      v.object({
        author: v.string(),
        description: v.optional(v.string()),
        packageName: v.string(),
        tagline: v.optional(v.string()),
        version: v.string(),
      })
    ),
    protectedFiles: v.array(
      v.object({
        materializerType: v.string(),
        normalizedPath: v.string(),
        required: v.boolean(),
        sourceSha256: v.string(),
      })
    ),
    protectedSourceRoot: v.string(),
    protectionPolicyDigest: v.string(),
    protectionPolicyId: v.string(),
    releaseRoot: v.string(),
    vpmDependencies: v.record(v.string(), v.string()),
    vpmRepositories: v.record(v.string(), v.string()),
    channel: v.optional(v.string()),
    catalogProductId: v.optional(v.id('product_catalog')),
    createdAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<'package_versions_ref'>> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    const editionId = args.editionId ?? DEFAULT_EDITION;
    if (args.catalogProductId) {
      await requirePublicationEdition(ctx, {
        catalogProductId: args.catalogProductId,
        editionId,
        packageId: args.packageId,
      });
    }

    const existing = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_version_id', (q) => q.eq('versionId', args.versionId))
      .first();
    if (existing) {
      if (
        existing.packageId !== args.packageId ||
        editionOf(existing) !== (args.editionId ?? DEFAULT_EDITION) ||
        existing.version !== args.version
      ) {
        throw new Error('Package version durable identity conflict');
      }
      const retryPayload = immutableVersionPayload({
        ...args,
        bootstrapMedia: args.bootstrapMedia ?? [],
        channel: args.channel ?? DEFAULT_CHANNEL,
        createdAt: existing.createdAt,
        editionId,
      });
      const publicationPatch = {
        activeContentDigest: args.activeContentDigest,
        activePolicyVersion: args.activePolicyVersion,
        bindingRoot: args.bindingRoot,
        bootstrapMedia: args.bootstrapMedia ?? [],
        catalogProductId: args.catalogProductId,
        channel: args.channel ?? DEFAULT_CHANNEL,
        commonRoot: args.commonRoot,
        editionId,
        logicalBytes: args.logicalBytes,
        logicalFiles: args.logicalFiles,
        manifestSha256: args.manifestSha256,
        packageMetadata: args.packageMetadata,
        protectedFiles: args.protectedFiles,
        protectedSourceRoot: args.protectedSourceRoot,
        protectionPolicyDigest: args.protectionPolicyDigest,
        protectionPolicyId: args.protectionPolicyId,
        releaseRoot: args.releaseRoot,
        vpmDependencies: args.vpmDependencies,
        vpmRepositories: args.vpmRepositories,
      };
      if (existing.state === 'DELETED') {
        if (existing.deletedAt !== undefined && args.createdAt <= existing.deletedAt) {
          return existing._id;
        }

        const channel = args.channel ?? DEFAULT_CHANNEL;
        const currentReadyVersions = await ctx.db
          .query('package_versions_ref')
          .withIndex('by_package_edition_channel', (q) =>
            q
              .eq('packageId', args.packageId)
              .eq('editionId', editionId)
              .eq('channel', channel)
              .eq('state', 'READY')
          )
          .take(2);
        if (currentReadyVersions.length > 1) {
          throw new Error('Package edition has multiple current releases');
        }
        const hasCurrentReadyAtOrAfter = currentReadyVersions.some(
          (current) => current.createdAt >= args.createdAt
        );
        for (const current of currentReadyVersions) {
          if (current.createdAt < args.createdAt) {
            await ctx.db.patch(current._id, { state: 'SUPERSEDED' });
          }
        }

        await ctx.db.patch(existing._id, {
          ...publicationPatch,
          createdAt: args.createdAt,
          deletedAt: undefined,
          state: hasCurrentReadyAtOrAfter ? 'SUPERSEDED' : 'READY',
        });
        return existing._id;
      }
      if (!hasCompleteReleasePublication(existing)) {
        for (const [field, value] of Object.entries(publicationPatch)) {
          const current = existing[field as keyof typeof existing];
          if (current !== undefined && canonicalJson(current) !== canonicalJson(value)) {
            throw new Error(`Package version immutable payload conflict at ${field}`);
          }
        }
        await ctx.db.patch(existing._id, publicationPatch);
        return existing._id;
      }
      if (canonicalJson(immutableVersionPayload(existing)) !== canonicalJson(retryPayload)) {
        throw new Error('Package version immutable payload conflict');
      }
      return existing._id;
    }

    const channel = args.channel ?? DEFAULT_CHANNEL;
    const logicalConflicts = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_package_edition_version', (q) =>
        q.eq('packageId', args.packageId).eq('editionId', editionId).eq('version', args.version)
      )
      .take(2);
    if (logicalConflicts.length > 0) {
      throw new Error('Package version logical identity conflict');
    }

    const currentReadyVersions = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_package_edition_channel', (q) =>
        q
          .eq('packageId', args.packageId)
          .eq('editionId', editionId)
          .eq('channel', channel)
          .eq('state', 'READY')
      )
      .take(2);
    if (currentReadyVersions.length > 1) {
      throw new Error('Package edition has multiple current releases');
    }
    const hasCurrentReadyAtOrAfter = currentReadyVersions.some(
      (current) => current.createdAt >= args.createdAt
    );

    for (const current of currentReadyVersions) {
      if (current.createdAt < args.createdAt) {
        await ctx.db.patch(current._id, { state: 'SUPERSEDED' });
      }
    }

    return await ctx.db.insert('package_versions_ref', {
      packageId: args.packageId,
      editionId,
      version: args.version,
      versionId: args.versionId,
      activeContentDigest: args.activeContentDigest,
      activePolicyVersion: args.activePolicyVersion,
      bindingRoot: args.bindingRoot,
      bootstrapMedia: args.bootstrapMedia ?? [],
      commonRoot: args.commonRoot,
      logicalBytes: args.logicalBytes,
      logicalFiles: args.logicalFiles,
      manifestSha256: args.manifestSha256,
      packageMetadata: args.packageMetadata,
      protectedFiles: args.protectedFiles,
      protectedSourceRoot: args.protectedSourceRoot,
      protectionPolicyDigest: args.protectionPolicyDigest,
      protectionPolicyId: args.protectionPolicyId,
      releaseRoot: args.releaseRoot,
      vpmDependencies: args.vpmDependencies,
      vpmRepositories: args.vpmRepositories,
      channel,
      state: hasCurrentReadyAtOrAfter ? 'SUPERSEDED' : 'READY',
      catalogProductId: args.catalogProductId,
      createdAt: args.createdAt,
    });
  },
});

export const markVersionDeleted = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    versionId: v.string(),
    deletedAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<'package_versions_ref'> | null> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);

    const existing = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_version_id', (q) => q.eq('versionId', args.versionId))
      .first();
    if (!existing) {
      return null;
    }
    if (existing.state === 'DELETED') {
      return existing._id;
    }

    await ctx.db.patch(existing._id, {
      state: 'DELETED',
      deletedAt: args.deletedAt,
    });
    if (existing.state !== 'READY') {
      return existing._id;
    }

    const fallback = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_package_edition_channel_created', (q) =>
        q
          .eq('packageId', existing.packageId)
          .eq('editionId', editionOf(existing))
          .eq('channel', existing.channel)
          .eq('state', 'SUPERSEDED')
      )
      .order('desc')
      .first();
    if (fallback) {
      await ctx.db.patch(fallback._id, { state: 'READY' });
    }
    return existing._id;
  },
});

export const resolveDownloadableVersion = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    catalogProductId: v.optional(v.id('product_catalog')),
    packageId: v.optional(v.string()),
    editionId: v.optional(v.string()),
    channel: v.optional(v.string()),
    releaseRoot: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Doc<'package_versions_ref'> | null> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);

    const scope = await resolveDownloadScope(ctx, args);
    if (!scope) {
      return null;
    }
    const channel = args.channel ?? DEFAULT_CHANNEL;
    const releaseRoot = args.releaseRoot;
    if (releaseRoot) {
      const [ready, superseded] = await Promise.all(
        (['READY', 'SUPERSEDED'] as const).map(
          async (state) =>
            await ctx.db
              .query('package_versions_ref')
              .withIndex('by_release_package_edition_channel_state', (q) =>
                q
                  .eq('releaseRoot', releaseRoot)
                  .eq('packageId', scope.packageId)
                  .eq('editionId', scope.editionId)
                  .eq('channel', channel)
                  .eq('state', state)
              )
              .take(2)
        )
      );
      const exactMatches = [...ready, ...superseded];
      if (exactMatches.length !== 1) {
        return null;
      }
      return exactMatches[0] ?? null;
    }

    const candidates = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_package_edition_channel', (q) =>
        q
          .eq('packageId', scope.packageId)
          .eq('editionId', scope.editionId)
          .eq('channel', channel)
          .eq('state', 'READY')
      )
      .take(2);
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  },
});

export const resolveInstalledVersion = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    catalogProductId: v.optional(v.id('product_catalog')),
    packageId: v.optional(v.string()),
    editionId: v.optional(v.string()),
    channel: v.optional(v.string()),
    releaseRoot: v.string(),
  },
  handler: async (ctx, args): Promise<Doc<'package_versions_ref'> | null> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);

    const scope = await resolveDownloadScope(ctx, args);
    if (!scope) {
      return null;
    }
    const channel = args.channel ?? DEFAULT_CHANNEL;
    const matches = await Promise.all(
      (['READY', 'SUPERSEDED', 'DELETED'] as const).map(
        async (state) =>
          await ctx.db
            .query('package_versions_ref')
            .withIndex('by_release_package_edition_channel_state', (q) =>
              q
                .eq('releaseRoot', args.releaseRoot)
                .eq('packageId', scope.packageId)
                .eq('editionId', scope.editionId)
                .eq('channel', channel)
                .eq('state', state)
            )
            .take(2)
      )
    );
    const exactMatches = matches.flat();
    return exactMatches.length === 1 ? (exactMatches[0] ?? null) : null;
  },
});

export const resolvePublicBootstrapPresentation = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    catalogProductId: v.optional(v.id('product_catalog')),
    packageId: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);

    const channel = args.channel ?? DEFAULT_CHANNEL;
    let candidates: Doc<'package_versions_ref'>[];
    if (args.packageId) {
      candidates = await ctx.db
        .query('package_versions_ref')
        .withIndex('by_package_channel', (q) =>
          q
            .eq('packageId', args.packageId as string)
            .eq('channel', channel)
            .eq('state', 'READY')
        )
        .collect();
      if (args.catalogProductId) {
        candidates = candidates.filter(
          (candidate) => candidate.catalogProductId === args.catalogProductId
        );
      }
    } else if (args.catalogProductId) {
      candidates = (
        await ctx.db
          .query('package_versions_ref')
          .withIndex('by_catalog_product', (q) =>
            q
              .eq('catalogProductId', args.catalogProductId as Id<'product_catalog'>)
              .eq('state', 'READY')
          )
          .collect()
      ).filter((candidate) => candidate.channel === channel);
    } else {
      return null;
    }
    if (candidates.length === 0) {
      return null;
    }

    const packageIds = new Set(candidates.map((candidate) => candidate.packageId));
    if (packageIds.size !== 1) {
      return null;
    }
    const packageId = candidates[0]?.packageId;
    if (!packageId) {
      return null;
    }
    const creatorAuthUserId = args.catalogProductId
      ? (await ctx.db.get(args.catalogProductId))?.authUserId
      : (
          await ctx.db
            .query('package_registry')
            .withIndex('by_package_id', (q) => q.eq('packageId', packageId))
            .first()
        )?.yucpUserId;
    if (!creatorAuthUserId) {
      return null;
    }
    const activeEditionIds = new Set(
      (
        await ctx.db
          .query('package_editions')
          .withIndex('by_creator_package', (q) =>
            q.eq('creatorAuthUserId', creatorAuthUserId).eq('packageId', packageId)
          )
          .collect()
      )
        .filter((edition) => edition.status === 'active')
        .map((edition) => edition.editionId)
    );
    if (activeEditionIds.size === 0) {
      return null;
    }
    candidates = candidates.filter((candidate) => activeEditionIds.has(editionOf(candidate)));
    if (candidates.length === 0) {
      return null;
    }

    const metadata = candidates.map((candidate) => candidate.packageMetadata);
    const author = sharedText(metadata.map((value) => value?.author));
    const description = sharedText(metadata.map((value) => value?.description));
    const packageName = sharedText(metadata.map((value) => value?.packageName));
    const tagline = sharedText(metadata.map((value) => value?.tagline));
    const latestCandidate = candidates.reduce((latest, candidate) =>
      candidate.createdAt > latest.createdAt ? candidate : latest
    );
    const version = latestCandidate.packageMetadata?.version ?? latestCandidate.version;
    const packageMetadata = {
      ...(author ? { author } : {}),
      ...(description ? { description } : {}),
      ...(packageName ? { packageName } : {}),
      ...(tagline ? { tagline } : {}),
      version,
    };
    const hasMetadata = Object.keys(packageMetadata).length > 0;
    const firstMedia = canonicalBootstrapMedia(candidates[0]?.bootstrapMedia ?? []);
    const sharedMediaKey = bootstrapMediaKey(firstMedia);
    const bootstrapMedia = candidates.every(
      (candidate) => bootstrapMediaKey(candidate.bootstrapMedia ?? []) === sharedMediaKey
    )
      ? firstMedia
      : [];

    return {
      bootstrapMedia,
      createdAt: Math.max(...candidates.map((candidate) => candidate.createdAt)),
      ...(hasMetadata ? { packageMetadata } : {}),
    };
  },
});
