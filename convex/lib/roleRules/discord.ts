/**
 * Business logic for Discord cross-server role product mutations.
 *
 * Kept in a lib helper so the Convex export in role_rules.ts stays a thin wrapper
 * while this file can be tested and reasoned about independently.
 */

import type { GenericMutationCtx } from 'convex/server';
import type { DataModel, Id } from '../../_generated/dataModel';
import { enqueueVerifyPromptRefreshJob } from '../verifyPrompt';
import { requireApiSecret } from './queries';

type MutationCtx = GenericMutationCtx<DataModel>;

export function buildDiscordRoleKey(
  sourceGuildId: string,
  requiredRoleIds: string[],
  requiredRoleMatchMode?: 'any' | 'all'
): string {
  if (requiredRoleIds.length === 0) {
    throw new Error('At least one required role is needed');
  }
  if (requiredRoleIds.length === 1) {
    return `discord_role:${sourceGuildId}:${requiredRoleIds[0]}`;
  }
  const mode = requiredRoleMatchMode ?? 'any';
  const sorted = [...requiredRoleIds].sort();
  return `discord_role:${sourceGuildId}:${mode}:${sorted.join(',')}`;
}

export interface AddProductFromDiscordRoleArgs {
  apiSecret: string;
  authUserId: string;
  sourceGuildId: string;
  sourceGuildName?: string;
  requiredRoleId?: string;
  requiredRoleIds?: string[];
  requiredRoleMatchMode?: 'any' | 'all';
  guildId: string;
  guildLinkId: Id<'guild_links'>;
  verifiedRoleId?: string;
  verifiedRoleIds?: string[];
  /** Human-readable name (e.g. "Member (My Server)"), resolved by bot at add time */
  displayName?: string;
}

export async function addProductFromDiscordRoleImpl(
  ctx: MutationCtx,
  args: AddProductFromDiscordRoleArgs
): Promise<{ productId: string; ruleId: Id<'role_rules'> }> {
  requireApiSecret(args.apiSecret);

  const reqIds = args.requiredRoleIds ?? (args.requiredRoleId ? [args.requiredRoleId] : []);
  if (reqIds.length === 0) {
    throw new Error('At least one required role is needed');
  }

  const productId = buildDiscordRoleKey(args.sourceGuildId, reqIds, args.requiredRoleMatchMode);
  const now = Date.now();

  const existing = await ctx.db
    .query('role_rules')
    .withIndex('by_auth_user_guild', (q) =>
      q.eq('authUserId', args.authUserId).eq('guildId', args.guildId)
    )
    .filter((q) => q.eq(q.field('productId'), productId))
    .first();

  if (existing) {
    const patch: {
      displayName?: string;
      sourceGuildName?: string;
      updatedAt: number;
    } = { updatedAt: Date.now() };
    if (args.displayName && existing.displayName !== args.displayName) {
      patch.displayName = args.displayName;
    }
    if (args.sourceGuildName && existing.sourceGuildName !== args.sourceGuildName) {
      patch.sourceGuildName = args.sourceGuildName;
    }
    if (Object.keys(patch).length > 1) {
      await ctx.db.patch(existing._id, patch);
    }
    return { productId, ruleId: existing._id };
  }

  const roleIds = args.verifiedRoleIds ?? (args.verifiedRoleId ? [args.verifiedRoleId] : []);
  if (roleIds.length === 0) {
    throw new Error('At least one verified role is required');
  }
  const verifiedRoleId = roleIds[0];

  const ruleId = await ctx.db.insert('role_rules', {
    authUserId: args.authUserId,
    guildId: args.guildId,
    guildLinkId: args.guildLinkId,
    productId,
    verifiedRoleId,
    verifiedRoleIds: roleIds.length > 1 ? roleIds : undefined,
    removeOnRevoke: true,
    priority: 0,
    enabled: true,
    sourceGuildId: args.sourceGuildId,
    sourceGuildName: args.sourceGuildName,
    requiredRoleId: reqIds.length === 1 ? reqIds[0] : undefined,
    requiredRoleIds: reqIds.length > 1 ? reqIds : undefined,
    requiredRoleMatchMode: reqIds.length > 1 ? (args.requiredRoleMatchMode ?? 'any') : undefined,
    displayName: args.displayName,
    createdAt: now,
    updatedAt: now,
  });

  // Schedule retroactive sync so existing members with the source role get the target role.
  // Use ruleId in idempotency key so re-adds (after remove) create a fresh job.
  const idempotencyKey = `retroactive_rule_sync:${args.authUserId}:${productId}:${ruleId}`;
  await ctx.db.insert('outbox_jobs', {
    authUserId: args.authUserId,
    jobType: 'retroactive_rule_sync',
    payload: { authUserId: args.authUserId, productId },
    status: 'pending',
    idempotencyKey,
    retryCount: 0,
    maxRetries: 5,
    createdAt: now,
    updatedAt: now,
  });

  await enqueueVerifyPromptRefreshJob(ctx, {
    authUserId: args.authUserId,
    guildId: args.guildId,
    guildLinkId: args.guildLinkId,
  });

  return { productId, ruleId };
}
