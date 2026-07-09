import type { Id } from '../_generated/dataModel';
import { grantEntitlementFromFunnel } from '../entitlements';
import { resolveRoleSyncDiscordUserId } from '../lib/roleSyncIdentity';
import {
  buildRoleRemovalIdempotencyKey,
  buildRoleSyncIdempotencyKey,
  enqueueRoleRemoval,
  enqueueRoleSync,
} from '../lib/roleSyncEnqueue';

export { normalizeEmail, sha256Hex } from '@yucp/shared/crypto';

/**
 * Find subjectId by email hash via external_accounts + bindings.
 */
export async function findSubjectByEmailHash(
  ctx: any,
  authUserId: string,
  emailHash: string
): Promise<Id<'subjects'> | undefined> {
  const externalAccounts = await ctx.db
    .query('external_accounts')
    .withIndex('by_email_hash', (q: any) => q.eq('emailHash', emailHash))
    .filter((q: any) => q.eq(q.field('status'), 'active'))
    .collect();

  for (const ext of externalAccounts) {
    const binding = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_external', (q: any) =>
        q.eq('authUserId', authUserId).eq('externalAccountId', ext._id)
      )
      .filter((q: any) => q.eq(q.field('status'), 'active'))
      .first();
    if (binding) {
      return binding.subjectId;
    }
  }

  return undefined;
}

/**
 * Project entitlement from purchase fact.
 * Respects verificationScope: in license mode, do not project.
 */
export async function projectEntitlementFromPurchaseFact(
  ctx: any,
  authUserId: string,
  subjectId: Id<'subjects'>,
  sourceProvider: string,
  providerProductId: string,
  sourceRef: string,
  purchasedAt: number
): Promise<void> {
  const creatorProfile = await ctx.db
    .query('creator_profiles')
    .withIndex('by_auth_user', (q: any) => q.eq('authUserId', authUserId))
    .first();
  const verificationScope = creatorProfile?.policy?.verificationScope ?? 'account';

  if (verificationScope === 'license') {
    return; // Do not project until subject proves ownership via license flow
  }

  const catalogProducts = await ctx.db
    .query('product_catalog')
    .withIndex('by_auth_user', (q: any) => q.eq('authUserId', authUserId))
    .filter((q: any) => q.eq(q.field('providerProductRef'), providerProductId))
    .filter((q: any) => q.eq(q.field('status'), 'active'))
    .collect();
  const catalogProduct = catalogProducts[0];

  const productId = catalogProduct?.productId ?? providerProductId;
  const catalogProductId = catalogProduct?._id;

  const now = Date.now();
  await grantEntitlementFromFunnel(ctx, {
    authUserId,
    subjectId,
    productId,
    sourceProvider,
    sourceReference: sourceRef,
    catalogProductId,
    policySnapshotVersion: 1,
    grantedAt: purchasedAt,
    now,
    existingLookup: { mode: 'sourceReference' },
    reactivation: { allowTerminal: true },
    roleSync: {
      mode: 'primaryDiscordUserId',
      lifecycleAt: now,
      requireDiscordUserId: true,
      missingSubject: 'skip',
      skipDiscordUserIdPrefixes: ['gumroad:', 'jinxxy:'],
    },
  });
}

/**
 * Revoke entitlement for a purchase fact.
 */
export async function revokeEntitlementForPurchaseFact(
  ctx: any,
  authUserId: string,
  purchaseFact: any,
  sourceRef: string
): Promise<void> {
  const entitlement = await ctx.db
    .query('entitlements')
    .withIndex('by_auth_user_subject', (q: any) =>
      q.eq('authUserId', authUserId).eq('subjectId', purchaseFact.subjectId)
    )
    .filter((q: any) => q.eq(q.field('sourceReference'), sourceRef))
    .filter((q: any) => q.eq(q.field('status'), 'active'))
    .first();

  if (entitlement) {
    const now = Date.now();
    await ctx.db.patch(entitlement._id, {
      status: 'refunded',
      revokedAt: now,
      updatedAt: now,
    });

    const subject = await ctx.db.get(purchaseFact.subjectId);
    const discordUserId = resolveRoleSyncDiscordUserId(subject ?? {});
    if (discordUserId) {
      await emitRoleRemovalJobs(
        ctx,
        authUserId,
        purchaseFact.subjectId,
        entitlement.productId,
        discordUserId,
        entitlement._id,
        now
      );
    }
  }
}

export async function emitRoleSyncJob(
  ctx: any,
  authUserId: string,
  subjectId: Id<'subjects'>,
  discordUserId: string,
  entitlementId: Id<'entitlements'>,
  lifecycleAt?: number
): Promise<void> {
  const idempotencyKey = buildRoleSyncIdempotencyKey({
    authUserId,
    subjectId,
    entitlementId,
    ...(lifecycleAt !== undefined ? { lifecycle: { kind: 'grant', at: lifecycleAt } } : {}),
  });
  await enqueueRoleSync(ctx, {
    authUserId,
    subjectId,
    entitlementId,
    discordUserId,
    idempotencyKey,
  });
}

export async function emitRoleRemovalJobs(
  ctx: any,
  authUserId: string,
  subjectId: Id<'subjects'>,
  productId: string,
  discordUserId: string,
  entitlementId?: Id<'entitlements'>,
  lifecycleAt?: number
): Promise<void> {
  const roleRules = await ctx.db
    .query('role_rules')
    .withIndex('by_auth_user', (q: any) => q.eq('authUserId', authUserId))
    .filter((q: any) => q.eq(q.field('productId'), productId))
    .filter((q: any) => q.eq(q.field('enabled'), true))
    .filter((q: any) => q.eq(q.field('removeOnRevoke'), true))
    .collect();

  for (const rule of roleRules) {
    if (!rule.verifiedRoleId) {
      console.warn('[convex] Skipping role removal for misconfigured role rule', {
        roleRuleId: rule._id,
        authUserId,
        guildId: rule.guildId,
        reason: 'missing_verified_role_id',
      });
      continue;
    }
    const idempotencyKey = buildRoleRemovalIdempotencyKey({
      authUserId,
      subjectId,
      guildId: rule.guildId,
      productId,
      roleId: rule.verifiedRoleId,
      entitlementId,
      ...(lifecycleAt !== undefined ? { lifecycle: { kind: 'revoke', at: lifecycleAt } } : {}),
    });
    await enqueueRoleRemoval(ctx, {
      authUserId,
      subjectId,
      entitlementId,
      guildId: rule.guildId,
      roleId: rule.verifiedRoleId,
      discordUserId,
      idempotencyKey,
    });
  }
}
