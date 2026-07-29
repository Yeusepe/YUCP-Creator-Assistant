import { CATALOG_SYNC_PROVIDER_KEYS } from '@yucp/providers/providerMetadata';
import type { ProviderKey } from '@yucp/providers/types';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, type MutationCtx } from './_generated/server';

const RECONCILIATION_PAGE_SIZE = 100;
const CATALOG_SYNC_PROVIDER_SET = new Set<string>(CATALOG_SYNC_PROVIDER_KEYS);

export type CatalogMaterializationSourceKind = 'owner' | 'collaborator';

export interface EnqueueCatalogMaterializationArgs {
  authUserId: string;
  provider: string;
  sourceConnectionId: string;
  sourceKind: CatalogMaterializationSourceKind;
  sourceUpdatedAt: number;
}

function supportsCatalogMaterialization(provider: string): provider is ProviderKey {
  return CATALOG_SYNC_PROVIDER_SET.has(provider);
}

export async function enqueueCatalogMaterialization(
  ctx: MutationCtx,
  args: EnqueueCatalogMaterializationArgs
): Promise<boolean> {
  if (!supportsCatalogMaterialization(args.provider)) {
    return false;
  }

  const idempotencyKey = [
    'catalog_materialization',
    args.sourceKind,
    args.sourceConnectionId,
    args.sourceUpdatedAt,
  ].join(':');
  const existing = await ctx.db
    .query('outbox_jobs')
    .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
    .first();
  if (existing) {
    return false;
  }

  const now = Date.now();
  await ctx.db.insert('outbox_jobs', {
    authUserId: args.authUserId,
    jobType: 'catalog_materialization',
    payload: {
      provider: args.provider,
      sourceConnectionId: args.sourceConnectionId,
      sourceKind: args.sourceKind,
    },
    status: 'pending',
    idempotencyKey,
    retryCount: 0,
    maxRetries: 5,
    createdAt: now,
    updatedAt: now,
  });
  return true;
}

export const reconcileActiveConnections = internalMutation({
  args: {
    phase: v.optional(v.union(v.literal('owner'), v.literal('collaborator'))),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    enqueued: v.number(),
    done: v.boolean(),
    phase: v.union(v.literal('owner'), v.literal('collaborator')),
  }),
  handler: async (ctx, args) => {
    let enqueued = 0;
    const phase = args.phase ?? 'owner';

    if (phase === 'owner') {
      const page = await ctx.db.query('provider_connections').paginate({
        cursor: args.cursor ?? null,
        numItems: RECONCILIATION_PAGE_SIZE,
      });
      for (const connection of page.page) {
        const provider = connection.providerKey ?? connection.provider;
        if (connection.status !== 'active' || !supportsCatalogMaterialization(provider)) {
          continue;
        }
        if (
          await enqueueCatalogMaterialization(ctx, {
            authUserId: connection.authUserId,
            provider,
            sourceConnectionId: String(connection._id),
            sourceKind: 'owner',
            sourceUpdatedAt: connection.updatedAt,
          })
        ) {
          enqueued += 1;
        }
      }
      await ctx.scheduler.runAfter(
        0,
        internal.catalogMaterialization.reconcileActiveConnections,
        page.isDone
          ? { phase: 'collaborator', cursor: null }
          : { phase: 'owner', cursor: page.continueCursor }
      );
      return { enqueued, done: false, phase };
    } else {
      const page = await ctx.db.query('collaborator_connections').paginate({
        cursor: args.cursor ?? null,
        numItems: RECONCILIATION_PAGE_SIZE,
      });
      for (const connection of page.page) {
        if (
          connection.status !== 'active' ||
          !supportsCatalogMaterialization(connection.provider)
        ) {
          continue;
        }
        if (
          await enqueueCatalogMaterialization(ctx, {
            authUserId: connection.ownerAuthUserId,
            provider: connection.provider,
            sourceConnectionId: String(connection._id),
            sourceKind: 'collaborator',
            sourceUpdatedAt: connection.updatedAt ?? connection.createdAt,
          })
        ) {
          enqueued += 1;
        }
      }
      if (!page.isDone) {
        await ctx.scheduler.runAfter(
          0,
          internal.catalogMaterialization.reconcileActiveConnections,
          { phase: 'collaborator', cursor: page.continueCursor }
        );
      }
      return { enqueued, done: page.isDone, phase };
    }
  },
});
