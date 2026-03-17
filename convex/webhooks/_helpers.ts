import type { Id } from '../_generated/dataModel';

/**
 * SHA-256 hash of string, hex-encoded.
 */
export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Normalize email for hashing: lowercase, trim.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

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

  const existing = await ctx.db
    .query('entitlements')
    .withIndex('by_auth_user_subject', (q: any) =>
      q.eq('authUserId', authUserId).eq('subjectId', subjectId)
    )
    .filter((q: any) => q.eq(q.field('sourceReference'), sourceRef))
    .first();

  if (existing && existing.status === 'active') {
    return; // Idempotent
  }

  const now = Date.now();
  const policySnapshotVersion = 1;

  let entitlementId: Id<'entitlements'>;
  if (existing) {
    await ctx.db.patch(existing._id, {
      status: 'active',
      revokedAt: undefined,
      updatedAt: now,
    });
    entitlementId = existing._id;
  } else {
    entitlementId = await ctx.db.insert('entitlements', {
      authUserId,
      subjectId,
      productId,
      sourceProvider: catalogProduct?.provider ?? 'gumroad',
      sourceReference: sourceRef,
      catalogProductId,
      status: 'active',
      policySnapshotVersion,
      grantedAt: purchasedAt,
      updatedAt: now,
    });
  }

  const subject = await ctx.db.get(subjectId);
  const discordUserId = subject?.primaryDiscordUserId;
  if (
    discordUserId &&
    !discordUserId.startsWith('gumroad:') &&
    !discordUserId.startsWith('jinxxy:')
  ) {
    await emitRoleSyncJob(ctx, authUserId, subjectId, discordUserId, entitlementId);
  }
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
    const discordUserId = subject?.primaryDiscordUserId;
    if (
      discordUserId &&
      !discordUserId.startsWith('gumroad:') &&
      !discordUserId.startsWith('jinxxy:')
    ) {
      await emitRoleRemovalJobs(
        ctx,
        authUserId,
        purchaseFact.subjectId,
        entitlement.productId,
        discordUserId
      );
    }
  }
}

export async function emitRoleSyncJob(
  ctx: any,
  authUserId: string,
  subjectId: Id<'subjects'>,
  discordUserId: string,
  entitlementId: Id<'entitlements'>
): Promise<void> {
  const now = Date.now();
  const idempotencyKey = `role_sync:${authUserId}:${subjectId}:${entitlementId}:${now}`;

  const existing = await ctx.db
    .query('outbox_jobs')
    .withIndex('by_idempotency', (q: any) => q.eq('idempotencyKey', idempotencyKey))
    .first();
  if (existing) return;

  await ctx.db.insert('outbox_jobs', {
    authUserId,
    jobType: 'role_sync',
    payload: { subjectId, discordUserId, entitlementId },
    status: 'pending',
    idempotencyKey,
    targetDiscordUserId: discordUserId,
    retryCount: 0,
    maxRetries: 5,
    createdAt: now,
    updatedAt: now,
  });
}

export async function emitRoleRemovalJobs(
  ctx: any,
  authUserId: string,
  subjectId: Id<'subjects'>,
  productId: string,
  discordUserId: string
): Promise<void> {
  const roleRules = await ctx.db
    .query('role_rules')
    .withIndex('by_auth_user', (q: any) => q.eq('authUserId', authUserId))
    .filter((q: any) => q.eq(q.field('productId'), productId))
    .filter((q: any) => q.eq(q.field('enabled'), true))
    .filter((q: any) => q.eq(q.field('removeOnRevoke'), true))
    .collect();

  const now = Date.now();
  for (const rule of roleRules) {
    const idempotencyKey = `role_removal:${authUserId}:${subjectId}:${rule.guildId}:${productId}:${now}`;
    const existing = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_idempotency', (q: any) => q.eq('idempotencyKey', idempotencyKey))
      .first();
    if (existing) continue;

    await ctx.db.insert('outbox_jobs', {
      authUserId,
      jobType: 'role_removal',
      payload: {
        subjectId,
        guildId: rule.guildId,
        roleId: rule.verifiedRoleId,
        discordUserId,
      },
      status: 'pending',
      idempotencyKey,
      targetGuildId: rule.guildId,
      targetDiscordUserId: discordUserId,
      retryCount: 0,
      maxRetries: 5,
      createdAt: now,
      updatedAt: now,
    });
  }
}
