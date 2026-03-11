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
    const provider = (event.providerKey ?? event.provider) as 'gumroad' | 'jinxxy' | 'lemonsqueezy';
    const rawPayload = event.rawPayload as Record<string, unknown>;

    try {
      if (provider === 'gumroad') {
        await processGumroadEvent(ctx, tenantId, event, rawPayload);
      } else if (provider === 'jinxxy') {
        await processJinxxyEvent(ctx, tenantId, event, rawPayload);
      } else if (provider === 'lemonsqueezy') {
        await processLemonEvent(ctx, tenantId, event, rawPayload);
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

  const jinxxyUserId = (data.user as { id?: string })?.id;

  const subjectId =
    (buyerEmailHash
      ? await findSubjectByEmailHash(ctx, tenantId, buyerEmailHash)
      : undefined) ??
    (jinxxyUserId
      ? await findSubjectByJinxxyUserId(ctx, tenantId, jinxxyUserId)
      : undefined);

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
      const resolvedSubjectId = subjectId ?? existing.subjectId;
      await ctx.db.patch(existing._id, {
        paymentStatus: paymentStatus.toLowerCase(),
        lifecycleStatus,
        updatedAt: now,
        rawSourceEventId: event._id,
        subjectId: resolvedSubjectId,
      });
      if (!isPaid && existing.subjectId) {
        await revokeEntitlementForPurchaseFact(ctx, tenantId, existing, sourceRef);
      } else if (isPaid && resolvedSubjectId && !existing.subjectId) {
        // Previously had no subjectId (e.g. email not linked); now we have it via Jinxxy user ID
        await projectEntitlementFromPurchaseFact(
          ctx,
          tenantId,
          resolvedSubjectId,
          providerProductId,
          sourceRef,
          purchasedAt
        );
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

async function resolveLemonCatalogProduct(
  ctx: any,
  tenantId: Id<'tenants'>,
  providerRefs: string[]
): Promise<{ catalogProductId?: Id<'product_catalog'>; productId?: string }> {
  for (const ref of providerRefs.filter(Boolean)) {
    const mapping = await ctx.db
      .query('provider_catalog_mappings')
      .withIndex('by_external_variant', (q: any) =>
        q.eq('providerKey', 'lemonsqueezy').eq('externalVariantId', ref)
      )
      .first();
    if (mapping?.catalogProductId || mapping?.localProductId) {
      return {
        catalogProductId: mapping.catalogProductId,
        productId: mapping.localProductId,
      };
    }
  }

  const catalogProducts = await ctx.db
    .query('product_catalog')
    .withIndex('by_tenant', (q: any) => q.eq('tenantId', tenantId))
    .filter((q: any) => q.eq(q.field('status'), 'active'))
    .collect();

  for (const ref of providerRefs.filter(Boolean)) {
    const match = catalogProducts.find(
      (entry: any) => entry.provider === 'lemonsqueezy' && entry.providerProductRef === ref
    );
    if (match) {
      return { catalogProductId: match._id, productId: match.productId };
    }
  }

  return { productId: providerRefs.find(Boolean) };
}

async function projectCanonicalEntitlement(
  ctx: any,
  tenantId: Id<'tenants'>,
  subjectId: Id<'subjects'>,
  provider: 'lemonsqueezy',
  sourceRef: string,
  productId: string,
  catalogProductId: Id<'product_catalog'> | undefined,
  grantedAt: number
): Promise<void> {
  const existing = await ctx.db
    .query('entitlements')
    .withIndex('by_tenant_subject', (q: any) =>
      q.eq('tenantId', tenantId).eq('subjectId', subjectId)
    )
    .filter((q: any) => q.eq(q.field('sourceReference'), sourceRef))
    .first();

  if (existing?.status === 'active') {
    return;
  }

  const now = Date.now();
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
      tenantId,
      subjectId,
      productId,
      sourceProvider: provider,
      sourceReference: sourceRef,
      catalogProductId,
      status: 'active',
      policySnapshotVersion: 1,
      grantedAt,
      updatedAt: now,
    });
  }

  const subject = await ctx.db.get(subjectId);
  const discordUserId = subject?.primaryDiscordUserId;
  if (discordUserId && !discordUserId.startsWith('gumroad:') && !discordUserId.startsWith('jinxxy:')) {
    await emitRoleSyncJob(ctx, tenantId, subjectId, discordUserId, entitlementId);
  }
}

async function revokeCanonicalEntitlementBySource(
  ctx: any,
  tenantId: Id<'tenants'>,
  subjectId: Id<'subjects'> | undefined,
  sourceRef: string
): Promise<void> {
  if (!subjectId) return;
  const entitlement = await ctx.db
    .query('entitlements')
    .withIndex('by_tenant_subject', (q: any) =>
      q.eq('tenantId', tenantId).eq('subjectId', subjectId)
    )
    .filter((q: any) => q.eq(q.field('sourceReference'), sourceRef))
    .filter((q: any) => q.eq(q.field('status'), 'active'))
    .first();

  if (!entitlement) return;

  const now = Date.now();
  await ctx.db.patch(entitlement._id, {
    status: 'refunded',
    revokedAt: now,
    updatedAt: now,
  });

  const subject = await ctx.db.get(subjectId);
  const discordUserId = subject?.primaryDiscordUserId;
  if (discordUserId && !discordUserId.startsWith('gumroad:') && !discordUserId.startsWith('jinxxy:')) {
    await emitRoleRemovalJobs(ctx, tenantId, subjectId, entitlement.productId, discordUserId);
  }
}

async function processLemonEvent(
  ctx: any,
  tenantId: Id<'tenants'>,
  event: any,
  payload: Record<string, unknown>
): Promise<void> {
  const connectionId = event.providerConnectionId as Id<'provider_connections'> | undefined;
  if (!connectionId) {
    throw new Error('Lemon Squeezy webhook missing providerConnectionId');
  }

  const meta = (payload.meta ?? {}) as Record<string, unknown>;
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const attributes = (data.attributes ?? {}) as Record<string, unknown>;
  const eventType = String(meta.event_name ?? event.eventType ?? '');
  const objectId = String(data.id ?? '');
  if (!objectId) {
    throw new Error('Lemon Squeezy webhook missing data.id');
  }

  const normalizedEmail =
    typeof attributes.user_email === 'string' && attributes.user_email
      ? normalizeEmail(attributes.user_email)
      : undefined;
  const emailHash = normalizedEmail ? await sha256Hex(normalizedEmail) : undefined;
  const subjectId = emailHash ? await findSubjectByEmailHash(ctx, tenantId, emailHash) : undefined;
  const now = Date.now();

  if (eventType.startsWith('order_')) {
    const variantId = attributes.first_order_item && typeof attributes.first_order_item === 'object'
      ? String((attributes.first_order_item as any).variant_id ?? '')
      : '';
    const productId = attributes.first_order_item && typeof attributes.first_order_item === 'object'
      ? String((attributes.first_order_item as any).product_id ?? '')
      : '';
    const resolved = await resolveLemonCatalogProduct(ctx, tenantId, [variantId, productId]);
    const transactionStatus = eventType === 'order_refunded' || attributes.refunded === true ? 'refunded' : 'paid';

    const existing = await ctx.db
      .query('provider_transactions')
      .withIndex('by_external_id', (q: any) =>
        q.eq('providerKey', 'lemonsqueezy').eq('externalTransactionId', objectId)
      )
      .first();
    const transactionId = existing?._id
      ? (await ctx.db.patch(existing._id, {
          providerConnectionId: connectionId,
          externalOrderNumber:
            typeof attributes.order_number === 'number'
              ? String(attributes.order_number)
              : existing.externalOrderNumber,
          externalOrderItemId:
            attributes.first_order_item && typeof attributes.first_order_item === 'object'
              ? String((attributes.first_order_item as any).id ?? existing.externalOrderItemId ?? '')
              : existing.externalOrderItemId,
          externalStoreId: typeof attributes.store_id === 'number' ? String(attributes.store_id) : existing.externalStoreId,
          externalProductId: productId || existing.externalProductId,
          externalVariantId: variantId || existing.externalVariantId,
          externalCustomerId: typeof attributes.customer_id === 'number' ? String(attributes.customer_id) : existing.externalCustomerId,
          customerEmail: normalizedEmail ?? existing.customerEmail,
          customerEmailHash: emailHash ?? existing.customerEmailHash,
          currency: typeof attributes.currency === 'string' ? attributes.currency : existing.currency,
          amountSubtotal: typeof attributes.subtotal === 'number' ? attributes.subtotal : existing.amountSubtotal,
          amountTotal: typeof attributes.total === 'number' ? attributes.total : existing.amountTotal,
          status: transactionStatus,
          purchasedAt: parseInt(String(Date.parse(String(attributes.created_at ?? '')) || existing.purchasedAt || now), 10),
          refundedAt:
            typeof attributes.refunded_at === 'string'
              ? new Date(attributes.refunded_at).getTime()
              : existing.refundedAt,
          rawWebhookEventId: event._id,
          metadata: { payload },
          updatedAt: now,
        }),
        existing._id)
      : await ctx.db.insert('provider_transactions', {
          tenantId,
          providerConnectionId: connectionId,
          providerKey: 'lemonsqueezy',
          externalTransactionId: objectId,
          externalOrderNumber:
            typeof attributes.order_number === 'number' ? String(attributes.order_number) : undefined,
          externalOrderItemId:
            attributes.first_order_item && typeof attributes.first_order_item === 'object'
              ? String((attributes.first_order_item as any).id ?? '')
              : undefined,
          externalStoreId: typeof attributes.store_id === 'number' ? String(attributes.store_id) : undefined,
          externalProductId: productId || undefined,
          externalVariantId: variantId || undefined,
          externalCustomerId: typeof attributes.customer_id === 'number' ? String(attributes.customer_id) : undefined,
          customerEmail: normalizedEmail,
          customerEmailHash: emailHash,
          currency: typeof attributes.currency === 'string' ? attributes.currency : undefined,
          amountSubtotal: typeof attributes.subtotal === 'number' ? attributes.subtotal : undefined,
          amountTotal: typeof attributes.total === 'number' ? attributes.total : undefined,
          status: transactionStatus,
          purchasedAt: typeof attributes.created_at === 'string' ? new Date(attributes.created_at).getTime() : now,
          refundedAt: typeof attributes.refunded_at === 'string' ? new Date(attributes.refunded_at).getTime() : undefined,
          rawWebhookEventId: event._id,
          metadata: { payload },
          createdAt: now,
          updatedAt: now,
        });

    const sourceRef = `lemonsqueezy:order:${objectId}`;
    const evidenceExisting = await ctx.db
      .query('entitlement_evidence')
      .withIndex('by_source_reference', (q: any) =>
        q.eq('providerKey', 'lemonsqueezy').eq('sourceReference', sourceRef)
      )
      .first();
    if (evidenceExisting) {
      await ctx.db.patch(evidenceExisting._id, {
        subjectId: subjectId ?? evidenceExisting.subjectId,
        providerConnectionId: connectionId,
        transactionId,
        status: transactionStatus === 'refunded' ? 'revoked' : 'active',
        productId: resolved.productId ?? evidenceExisting.productId,
        catalogProductId: resolved.catalogProductId ?? evidenceExisting.catalogProductId,
        rawWebhookEventId: event._id,
        metadata: { payload },
        observedAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('entitlement_evidence', {
        tenantId,
        subjectId,
        providerKey: 'lemonsqueezy',
        providerConnectionId: connectionId,
        transactionId,
        sourceReference: sourceRef,
        evidenceType:
          transactionStatus === 'refunded' ? 'purchase.refunded' : 'purchase.recorded',
        status: transactionStatus === 'refunded' ? 'revoked' : 'active',
        productId: resolved.productId,
        catalogProductId: resolved.catalogProductId,
        rawWebhookEventId: event._id,
        metadata: { payload },
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (subjectId && resolved.productId && transactionStatus !== 'refunded') {
      await projectCanonicalEntitlement(
        ctx,
        tenantId,
        subjectId,
        'lemonsqueezy',
        sourceRef,
        resolved.productId,
        resolved.catalogProductId,
        typeof attributes.created_at === 'string' ? new Date(attributes.created_at).getTime() : now
      );
    } else if (transactionStatus === 'refunded') {
      await revokeCanonicalEntitlementBySource(ctx, tenantId, subjectId, sourceRef);
    }
    return;
  }

  if (eventType.startsWith('subscription_')) {
    const variantId = typeof attributes.variant_id === 'number' ? String(attributes.variant_id) : '';
    const productId = typeof attributes.product_id === 'number' ? String(attributes.product_id) : '';
    const status =
      eventType === 'subscription_cancelled'
        ? 'cancelled'
        : eventType === 'subscription_expired'
          ? 'expired'
          : eventType === 'subscription_paused'
            ? 'paused'
            : attributes.status === 'on_trial'
              ? 'trialing'
              : 'active';
    const resolved = await resolveLemonCatalogProduct(ctx, tenantId, [variantId, productId]);

    const existing = await ctx.db
      .query('provider_memberships')
      .withIndex('by_external_id', (q: any) =>
        q.eq('providerKey', 'lemonsqueezy').eq('externalMembershipId', objectId)
      )
      .first();
    const membershipId = existing?._id
      ? (await ctx.db.patch(existing._id, {
          providerConnectionId: connectionId,
          externalTransactionId: typeof attributes.order_id === 'number' ? String(attributes.order_id) : existing.externalTransactionId,
          externalProductId: productId || existing.externalProductId,
          externalVariantId: variantId || existing.externalVariantId,
          externalCustomerId: typeof attributes.customer_id === 'number' ? String(attributes.customer_id) : existing.externalCustomerId,
          customerEmail: normalizedEmail ?? existing.customerEmail,
          customerEmailHash: emailHash ?? existing.customerEmailHash,
          status,
          startedAt: typeof attributes.created_at === 'string' ? new Date(attributes.created_at).getTime() : existing.startedAt,
          renewsAt: typeof attributes.renews_at === 'string' ? new Date(attributes.renews_at).getTime() : existing.renewsAt,
          endsAt: typeof attributes.ends_at === 'string' ? new Date(attributes.ends_at).getTime() : existing.endsAt,
          cancelledAt: status === 'cancelled' || status === 'expired' ? now : existing.cancelledAt,
          rawWebhookEventId: event._id,
          metadata: { payload },
          updatedAt: now,
        }),
        existing._id)
      : await ctx.db.insert('provider_memberships', {
          tenantId,
          providerConnectionId: connectionId,
          providerKey: 'lemonsqueezy',
          externalMembershipId: objectId,
          externalTransactionId: typeof attributes.order_id === 'number' ? String(attributes.order_id) : undefined,
          externalProductId: productId || undefined,
          externalVariantId: variantId || undefined,
          externalCustomerId: typeof attributes.customer_id === 'number' ? String(attributes.customer_id) : undefined,
          customerEmail: normalizedEmail,
          customerEmailHash: emailHash,
          status,
          startedAt: typeof attributes.created_at === 'string' ? new Date(attributes.created_at).getTime() : now,
          renewsAt: typeof attributes.renews_at === 'string' ? new Date(attributes.renews_at).getTime() : undefined,
          endsAt: typeof attributes.ends_at === 'string' ? new Date(attributes.ends_at).getTime() : undefined,
          cancelledAt: status === 'cancelled' || status === 'expired' ? now : undefined,
          rawWebhookEventId: event._id,
          metadata: { payload },
          createdAt: now,
          updatedAt: now,
        });

    const sourceRef = `lemonsqueezy:subscription:${objectId}`;
    const evidenceStatus = status === 'cancelled' || status === 'expired' ? 'revoked' : 'active';
    const evidenceExisting = await ctx.db
      .query('entitlement_evidence')
      .withIndex('by_source_reference', (q: any) =>
        q.eq('providerKey', 'lemonsqueezy').eq('sourceReference', sourceRef)
      )
      .first();
    if (evidenceExisting) {
      await ctx.db.patch(evidenceExisting._id, {
        subjectId: subjectId ?? evidenceExisting.subjectId,
        providerConnectionId: connectionId,
        membershipId,
        status: evidenceStatus,
        productId: resolved.productId ?? evidenceExisting.productId,
        catalogProductId: resolved.catalogProductId ?? evidenceExisting.catalogProductId,
        rawWebhookEventId: event._id,
        metadata: { payload },
        observedAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('entitlement_evidence', {
        tenantId,
        subjectId,
        providerKey: 'lemonsqueezy',
        providerConnectionId: connectionId,
        membershipId,
        sourceReference: sourceRef,
        evidenceType:
          evidenceStatus === 'revoked' ? 'subscription.ended' : 'subscription.updated',
        status: evidenceStatus,
        productId: resolved.productId,
        catalogProductId: resolved.catalogProductId,
        rawWebhookEventId: event._id,
        metadata: { payload },
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (subjectId && resolved.productId && evidenceStatus === 'active') {
      await projectCanonicalEntitlement(
        ctx,
        tenantId,
        subjectId,
        'lemonsqueezy',
        sourceRef,
        resolved.productId,
        resolved.catalogProductId,
        typeof attributes.created_at === 'string' ? new Date(attributes.created_at).getTime() : now
      );
    } else if (evidenceStatus === 'revoked') {
      await revokeCanonicalEntitlementBySource(ctx, tenantId, subjectId, sourceRef);
    }
    return;
  }

  if (eventType.startsWith('license_key_')) {
    const variantId = typeof attributes.variant_id === 'number' ? String(attributes.variant_id) : '';
    const productId = typeof attributes.product_id === 'number' ? String(attributes.product_id) : '';
    const licenseStatus =
      attributes.disabled === true || attributes.status === 'disabled'
        ? 'disabled'
        : attributes.status === 'expired'
          ? 'expired'
          : 'active';
    const existing = await ctx.db
      .query('provider_licenses')
      .withIndex('by_external_id', (q: any) =>
        q.eq('providerKey', 'lemonsqueezy').eq('externalLicenseId', objectId)
      )
      .first();
    const licenseId = existing?._id
      ? (await ctx.db.patch(existing._id, {
          providerConnectionId: connectionId,
          externalTransactionId: typeof attributes.order_id === 'number' ? String(attributes.order_id) : existing.externalTransactionId,
          externalProductId: productId || existing.externalProductId,
          externalVariantId: variantId || existing.externalVariantId,
          externalCustomerId: typeof attributes.customer_id === 'number' ? String(attributes.customer_id) : existing.externalCustomerId,
          customerEmail: normalizedEmail ?? existing.customerEmail,
          customerEmailHash: emailHash ?? existing.customerEmailHash,
          licenseKeyHash:
            typeof attributes.key === 'string'
              ? await sha256Hex(attributes.key)
              : existing.licenseKeyHash,
          shortKey: typeof attributes.key_short === 'string' ? attributes.key_short : existing.shortKey,
          status: licenseStatus,
          issuedAt: typeof attributes.created_at === 'string' ? new Date(attributes.created_at).getTime() : existing.issuedAt,
          expiresAt: typeof attributes.expires_at === 'string' ? new Date(attributes.expires_at).getTime() : existing.expiresAt,
          lastValidatedAt: now,
          revokedAt: licenseStatus === 'disabled' || licenseStatus === 'expired' ? now : existing.revokedAt,
          rawWebhookEventId: event._id,
          metadata: { payload },
          updatedAt: now,
        }),
        existing._id)
      : await ctx.db.insert('provider_licenses', {
          tenantId,
          providerConnectionId: connectionId,
          providerKey: 'lemonsqueezy',
          externalLicenseId: objectId,
          externalTransactionId: typeof attributes.order_id === 'number' ? String(attributes.order_id) : undefined,
          externalProductId: productId || undefined,
          externalVariantId: variantId || undefined,
          externalCustomerId: typeof attributes.customer_id === 'number' ? String(attributes.customer_id) : undefined,
          customerEmail: normalizedEmail,
          customerEmailHash: emailHash,
          licenseKeyHash: typeof attributes.key === 'string' ? await sha256Hex(attributes.key) : undefined,
          shortKey: typeof attributes.key_short === 'string' ? attributes.key_short : undefined,
          status: licenseStatus,
          issuedAt: typeof attributes.created_at === 'string' ? new Date(attributes.created_at).getTime() : now,
          expiresAt: typeof attributes.expires_at === 'string' ? new Date(attributes.expires_at).getTime() : undefined,
          lastValidatedAt: now,
          revokedAt: licenseStatus === 'disabled' || licenseStatus === 'expired' ? now : undefined,
          rawWebhookEventId: event._id,
          metadata: { payload },
          createdAt: now,
          updatedAt: now,
        });

    const resolved = await resolveLemonCatalogProduct(ctx, tenantId, [variantId, productId]);
    const sourceRef = `lemonsqueezy:license:${objectId}`;
    const evidenceStatus = licenseStatus === 'active' ? 'active' : 'revoked';
    const evidenceExisting = await ctx.db
      .query('entitlement_evidence')
      .withIndex('by_source_reference', (q: any) =>
        q.eq('providerKey', 'lemonsqueezy').eq('sourceReference', sourceRef)
      )
      .first();
    if (evidenceExisting) {
      await ctx.db.patch(evidenceExisting._id, {
        subjectId: subjectId ?? evidenceExisting.subjectId,
        providerConnectionId: connectionId,
        licenseId,
        status: evidenceStatus,
        productId: resolved.productId ?? evidenceExisting.productId,
        catalogProductId: resolved.catalogProductId ?? evidenceExisting.catalogProductId,
        rawWebhookEventId: event._id,
        metadata: { payload },
        observedAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('entitlement_evidence', {
        tenantId,
        subjectId,
        providerKey: 'lemonsqueezy',
        providerConnectionId: connectionId,
        licenseId,
        sourceReference: sourceRef,
        evidenceType:
          evidenceStatus === 'active' ? 'license.issued' : 'license.revoked',
        status: evidenceStatus,
        productId: resolved.productId,
        catalogProductId: resolved.catalogProductId,
        rawWebhookEventId: event._id,
        metadata: { payload },
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (subjectId && resolved.productId && evidenceStatus === 'active') {
      await projectCanonicalEntitlement(
        ctx,
        tenantId,
        subjectId,
        'lemonsqueezy',
        sourceRef,
        resolved.productId,
        resolved.catalogProductId,
        typeof attributes.created_at === 'string' ? new Date(attributes.created_at).getTime() : now
      );
    } else if (evidenceStatus === 'revoked') {
      await revokeCanonicalEntitlementBySource(ctx, tenantId, subjectId, sourceRef);
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
 * Find subjectId by Jinxxy user ID via external_accounts + bindings.
 * Jinxxy external accounts often lack emailHash, so this fallback matches
 * by providerUserId when the order's user.id matches a linked Jinxxy account.
 */
async function findSubjectByJinxxyUserId(
  ctx: any,
  tenantId: Id<'tenants'>,
  jinxxyUserId: string
): Promise<Id<'subjects'> | undefined> {
  const ext = await ctx.db
    .query('external_accounts')
    .withIndex('by_provider_user', (q: any) =>
      q.eq('provider', 'jinxxy').eq('providerUserId', jinxxyUserId)
    )
    .filter((q: any) => q.eq(q.field('status'), 'active'))
    .first();
  if (!ext) return undefined;

  const binding = await ctx.db
    .query('bindings')
    .withIndex('by_tenant_external', (q: any) =>
      q.eq('tenantId', tenantId).eq('externalAccountId', ext._id)
    )
    .filter((q: any) => q.eq(q.field('status'), 'active'))
    .first();
  return binding?.subjectId;
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
    await emitRoleSyncJob(ctx, tenantId, subjectId, discordUserId, entitlementId);
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
  discordUserId: string,
  entitlementId: Id<'entitlements'>
): Promise<void> {
  const now = Date.now();
  const idempotencyKey = `role_sync:${tenantId}:${subjectId}:${entitlementId}:${now}`;

  const existing = await ctx.db
    .query('outbox_jobs')
    .withIndex('by_idempotency', (q: any) => q.eq('idempotencyKey', idempotencyKey))
    .first();
  if (existing) return;

  await ctx.db.insert('outbox_jobs', {
    tenantId,
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

