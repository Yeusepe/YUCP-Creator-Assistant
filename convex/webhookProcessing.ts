/**
 * Webhook Processing - Normalization Pipeline
 *
 * Processes pending webhook events: normalize to purchase_facts,
 * link subject by email, project entitlements (respecting verificationScope),
 * emit role_sync jobs.
 *
 * Plan Phase 3: event → purchase_facts → link subject → entitlements → role_sync
 */

import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';

/**
 * Get IDs of pending webhook events for processing.
 */
export const getPendingEventIds = internalQuery({
  args: {
    apiSecret: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.id('webhook_events')),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = Math.min(args.limit ?? 10, 50);
    const events = await ctx.db
      .query('webhook_events')
      .withIndex('by_status', (q) => q.eq('status', 'pending'))
      .order('asc')
      .take(limit);
    return events.map((e) => e._id);
  },
});

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

/**
 * SHA-256 hash of string, hex-encoded.
 */
async function sha256Hex(input: string): Promise<string> {
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
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Process a single webhook event.
 * Internal mutation - idempotent per event.
 */
export const processWebhookEvent = internalMutation({
  args: {
    apiSecret: v.string(),
    eventId: v.id('webhook_events'),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const event = await ctx.db.get(args.eventId);
    if (!event) {
      return { success: false, error: 'Event not found' };
    }
    if (event.status !== 'pending') {
      return { success: true }; // Already processed
    }
    if (!event.tenantId) {
      await ctx.db.patch(args.eventId, {
        status: 'failed',
        errorMessage: 'Missing tenantId',
        processedAt: Date.now(),
      });
      return { success: false, error: 'Missing tenantId' };
    }

    const tenantId = event.tenantId;
    const provider = event.provider as 'gumroad' | 'jinxxy';
    const rawPayload = event.rawPayload as Record<string, unknown>;

    try {
      if (provider === 'gumroad') {
        await processGumroadEvent(ctx, tenantId, event, rawPayload);
      } else if (provider === 'jinxxy') {
        await processJinxxyEvent(ctx, tenantId, event, rawPayload);
      } else {
        await ctx.db.patch(args.eventId, {
          status: 'failed',
          errorMessage: `Unsupported provider: ${provider}`,
          processedAt: Date.now(),
        });
        return { success: false, error: `Unsupported provider: ${provider}` };
      }

      await ctx.db.patch(args.eventId, {
        status: 'processed',
        processedAt: Date.now(),
      });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.db.patch(args.eventId, {
        status: 'failed',
        errorMessage: msg,
        processedAt: Date.now(),
      });
      return { success: false, error: msg };
    }
  },
});

async function processGumroadEvent(
  ctx: any,
  tenantId: Id<'tenants'>,
  event: any,
  payload: Record<string, unknown>
): Promise<void> {
  const saleId = (payload.sale_id ?? payload.order_number) as string;
  const productId = (payload.product_id ?? payload.short_product_id ?? '') as string;
  const email = (payload.email ?? '') as string;
  const refunded = payload.refunded === true || payload.refunded === 'true';
  const eventType = event.eventType as string;

  if (!saleId || !productId) {
    throw new Error('Gumroad: missing sale_id or product_id');
  }

  const lifecycleStatus = refunded ? 'refunded' : 'active';
  const buyerEmailNormalized = email ? normalizeEmail(email) : undefined;
  const buyerEmailHash = buyerEmailNormalized
    ? await sha256Hex(buyerEmailNormalized)
    : undefined;

  const saleTimestamp = payload.sale_timestamp
    ? parseInt(String(payload.sale_timestamp), 10) * 1000
    : Date.now();

  const existing = await ctx.db
    .query('purchase_facts')
    .withIndex('by_tenant_provider_order', (q: any) =>
      q.eq('tenantId', tenantId).eq('provider', 'gumroad').eq('externalOrderId', saleId)
    )
    .first();

  const now = Date.now();
  const sourceRef = `gumroad:${saleId}`;

  if (existing) {
    await ctx.db.patch(existing._id, {
      lifecycleStatus,
      paymentStatus: refunded ? 'refunded' : existing.paymentStatus,
      updatedAt: now,
      rawSourceEventId: event._id,
    });

    if (refunded && existing.subjectId) {
      await revokeEntitlementForPurchaseFact(ctx, tenantId, existing, sourceRef);
    }
  } else {
    if (refunded) {
      return; // Refund for unknown sale - nothing to update
    }

    const subjectId = buyerEmailHash
      ? await findSubjectByEmailHash(ctx, tenantId, buyerEmailHash)
      : undefined;

    await ctx.db.insert('purchase_facts', {
      tenantId,
      provider: 'gumroad',
      externalOrderId: saleId,
      buyerEmailNormalized,
      buyerEmailHash,
      providerProductId: productId,
      paymentStatus: 'paid',
      lifecycleStatus: 'active',
      purchasedAt: saleTimestamp,
      rawSourceEventId: event._id,
      subjectId,
      createdAt: now,
      updatedAt: now,
    });

    if (subjectId) {
      await projectEntitlementFromPurchaseFact(
        ctx,
        tenantId,
        subjectId,
        productId,
        sourceRef,
        saleTimestamp
      );
    }
  }
}

async function processJinxxyEvent(
  ctx: any,
  tenantId: Id<'tenants'>,
  event: any,
  payload: Record<string, unknown>
): Promise<void> {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) {
    throw new Error('Jinxxy: missing data');
  }

  const orderId = String(data.id ?? '');
  const email = (data.email ?? '') as string;
  const paymentStatus = (data.payment_status ?? '') as string;
  const createdAt = data.created_at as string | undefined;
  const purchasedAt = createdAt
    ? new Date(createdAt).getTime()
    : Date.now();

  const orderItems = (data.order_items ?? []) as Array<{
    id: string;
    target_type: string;
    target_id: string;
    name?: string;
  }>;

  const buyerEmailNormalized = email ? normalizeEmail(email) : undefined;
  const buyerEmailHash = buyerEmailNormalized
    ? await sha256Hex(buyerEmailNormalized)
    : undefined;

  const subjectId = buyerEmailHash
    ? await findSubjectByEmailHash(ctx, tenantId, buyerEmailHash)
    : undefined;

  const now = Date.now();

  for (const item of orderItems) {
    if (item.target_type !== 'DIGITAL_PRODUCT') continue;

    const externalLineItemId = item.id;
    const providerProductId = item.target_id;
    const sourceRef = `jinxxy:${orderId}:${externalLineItemId}`;

    const existing = await ctx.db
      .query('purchase_facts')
      .withIndex('by_tenant_provider_order', (q: any) =>
        q.eq('tenantId', tenantId).eq('provider', 'jinxxy').eq('externalOrderId', orderId)
      )
      .filter((q: any) => q.eq(q.field('externalLineItemId'), externalLineItemId))
      .first();

    const isPaid = paymentStatus === 'PAID';

    if (existing) {
      const lifecycleStatus = isPaid ? 'active' : 'refunded';
      await ctx.db.patch(existing._id, {
        paymentStatus: paymentStatus.toLowerCase(),
        lifecycleStatus,
        updatedAt: now,
        rawSourceEventId: event._id,
        subjectId: subjectId ?? existing.subjectId,
      });
      if (!isPaid && existing.subjectId) {
        await revokeEntitlementForPurchaseFact(ctx, tenantId, existing, sourceRef);
      }
    } else if (isPaid) {
      await ctx.db.insert('purchase_facts', {
        tenantId,
        provider: 'jinxxy',
        externalOrderId: orderId,
        externalLineItemId,
        buyerEmailNormalized,
        buyerEmailHash,
        providerProductId,
        paymentStatus: paymentStatus.toLowerCase(),
        lifecycleStatus: 'active',
        purchasedAt,
        rawSourceEventId: event._id,
        subjectId,
        createdAt: now,
        updatedAt: now,
      });

      if (subjectId) {
        await projectEntitlementFromPurchaseFact(
          ctx,
          tenantId,
          subjectId,
          providerProductId,
          sourceRef,
          purchasedAt
        );
      }
    }
  }
}

/**
 * Find subjectId by email hash via external_accounts + bindings.
 */
async function findSubjectByEmailHash(
  ctx: any,
  tenantId: Id<'tenants'>,
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
      .withIndex('by_tenant_external', (q: any) =>
        q.eq('tenantId', tenantId).eq('externalAccountId', ext._id)
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
async function projectEntitlementFromPurchaseFact(
  ctx: any,
  tenantId: Id<'tenants'>,
  subjectId: Id<'subjects'>,
  providerProductId: string,
  sourceRef: string,
  purchasedAt: number
): Promise<void> {
  const tenant = await ctx.db.get(tenantId);
  const verificationScope = tenant?.policy?.verificationScope ?? 'account';

  if (verificationScope === 'license') {
    return; // Do not project until subject proves ownership via license flow
  }

  const catalogProducts = await ctx.db
    .query('product_catalog')
    .withIndex('by_tenant', (q: any) => q.eq('tenantId', tenantId))
    .filter((q: any) => q.eq(q.field('providerProductRef'), providerProductId))
    .filter((q: any) => q.eq(q.field('status'), 'active'))
    .collect();
  const catalogProduct = catalogProducts[0];

  const productId = catalogProduct?.productId ?? providerProductId;
  const catalogProductId = catalogProduct?._id;

  const existing = await ctx.db
    .query('entitlements')
    .withIndex('by_tenant_subject', (q: any) =>
      q.eq('tenantId', tenantId).eq('subjectId', subjectId)
    )
    .filter((q: any) => q.eq(q.field('sourceReference'), sourceRef))
    .first();

  if (existing && existing.status === 'active') {
    return; // Idempotent
  }

  const now = Date.now();
  const policySnapshotVersion = 1;

  if (existing) {
    await ctx.db.patch(existing._id, {
      status: 'active',
      revokedAt: undefined,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert('entitlements', {
      tenantId,
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
  if (discordUserId && !discordUserId.startsWith('gumroad:') && !discordUserId.startsWith('jinxxy:')) {
    await emitRoleSyncJob(ctx, tenantId, subjectId, discordUserId);
  }
}

/**
 * Revoke entitlement for a purchase fact.
 */
async function revokeEntitlementForPurchaseFact(
  ctx: any,
  tenantId: Id<'tenants'>,
  purchaseFact: any,
  sourceRef: string
): Promise<void> {
  const entitlement = await ctx.db
    .query('entitlements')
    .withIndex('by_tenant_subject', (q: any) =>
      q.eq('tenantId', tenantId).eq('subjectId', purchaseFact.subjectId)
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
    if (discordUserId && !discordUserId.startsWith('gumroad:') && !discordUserId.startsWith('jinxxy:')) {
      await emitRoleRemovalJobs(ctx, tenantId, purchaseFact.subjectId, entitlement.productId, discordUserId);
    }
  }
}

async function emitRoleSyncJob(
  ctx: any,
  tenantId: Id<'tenants'>,
  subjectId: Id<'subjects'>,
  discordUserId: string
): Promise<void> {
  const now = Date.now();
  const idempotencyKey = `role_sync:${tenantId}:${subjectId}:${now}`;

  const existing = await ctx.db
    .query('outbox_jobs')
    .withIndex('by_idempotency', (q: any) => q.eq('idempotencyKey', idempotencyKey))
    .first();
  if (existing) return;

  await ctx.db.insert('outbox_jobs', {
    tenantId,
    jobType: 'role_sync',
    payload: { subjectId, discordUserId },
    status: 'pending',
    idempotencyKey,
    targetDiscordUserId: discordUserId,
    retryCount: 0,
    maxRetries: 5,
    createdAt: now,
    updatedAt: now,
  });
}

async function emitRoleRemovalJobs(
  ctx: any,
  tenantId: Id<'tenants'>,
  subjectId: Id<'subjects'>,
  productId: string,
  discordUserId: string
): Promise<void> {
  const roleRules = await ctx.db
    .query('role_rules')
    .withIndex('by_tenant', (q: any) => q.eq('tenantId', tenantId))
    .filter((q: any) => q.eq(q.field('productId'), productId))
    .filter((q: any) => q.eq(q.field('enabled'), true))
    .filter((q: any) => q.eq(q.field('removeOnRevoke'), true))
    .collect();

  const now = Date.now();
  for (const rule of roleRules) {
    const idempotencyKey = `role_removal:${tenantId}:${subjectId}:${rule.guildId}:${productId}:${now}`;
    const existing = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_idempotency', (q: any) => q.eq('idempotencyKey', idempotencyKey))
      .first();
    if (existing) continue;

    await ctx.db.insert('outbox_jobs', {
      tenantId,
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

/**
 * Process up to N pending webhook events.
 * Internal action - fetches pending events and calls processWebhookEvent for each.
 * Called by scheduled job or via public processPendingWebhookEventsAction.
 */
export const processPendingWebhookEvents = internalAction({
  args: {
    apiSecret: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    processed: v.number(),
    failed: v.number(),
    errors: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = Math.min(args.limit ?? 10, 50);

    const events = await ctx.runQuery(
      internal.webhookProcessing.getPendingEventIds,
      { apiSecret: args.apiSecret, limit }
    );

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const eventId of events) {
      const result = await ctx.runMutation(
        internal.webhookProcessing.processWebhookEvent,
        { apiSecret: args.apiSecret, eventId }
      );
      if (result.success) {
        processed++;
      } else {
        failed++;
        if (result.error) errors.push(result.error);
      }
    }

    return { processed, failed, errors };
  },
});

