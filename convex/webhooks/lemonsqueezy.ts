import type { Id } from '../_generated/dataModel';
import {
  emitRoleRemovalJobs,
  emitRoleSyncJob,
  findSubjectByEmailHash,
  normalizeEmail,
  sha256Hex,
} from './_helpers';

async function resolveLemonCatalogProduct(
  ctx: any,
  authUserId: string,
  providerRefs: string[]
): Promise<{ catalogProductId?: Id<'product_catalog'>; productId?: string }> {
  for (const ref of providerRefs.filter(Boolean)) {
    const mapping = await ctx.db
      .query('provider_catalog_mappings')
      .withIndex('by_external_variant', (q: any) =>
        q.eq('providerKey', 'lemonsqueezy').eq('externalVariantId', ref)
      )
      .filter((q: any) => q.eq(q.field('authUserId'), authUserId))
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
    .withIndex('by_auth_user', (q: any) => q.eq('authUserId', authUserId))
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
  authUserId: string,
  subjectId: Id<'subjects'>,
  provider: 'lemonsqueezy',
  sourceRef: string,
  productId: string,
  catalogProductId: Id<'product_catalog'> | undefined,
  grantedAt: number
): Promise<void> {
  const existing = await ctx.db
    .query('entitlements')
    .withIndex('by_auth_user_subject', (q: any) =>
      q.eq('authUserId', authUserId).eq('subjectId', subjectId)
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
      authUserId,
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
  if (
    discordUserId &&
    !discordUserId.startsWith('gumroad:') &&
    !discordUserId.startsWith('jinxxy:') &&
    !discordUserId.startsWith('lemonsqueezy:')
  ) {
    await emitRoleSyncJob(ctx, authUserId, subjectId, discordUserId, entitlementId);
  }
}

async function revokeCanonicalEntitlementBySource(
  ctx: any,
  authUserId: string,
  subjectId: Id<'subjects'> | undefined,
  sourceRef: string
): Promise<void> {
  if (!subjectId) return;
  const entitlement = await ctx.db
    .query('entitlements')
    .withIndex('by_auth_user_subject', (q: any) =>
      q.eq('authUserId', authUserId).eq('subjectId', subjectId)
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
  if (
    discordUserId &&
    !discordUserId.startsWith('gumroad:') &&
    !discordUserId.startsWith('jinxxy:') &&
    !discordUserId.startsWith('lemonsqueezy:')
  ) {
    await emitRoleRemovalJobs(ctx, authUserId, subjectId, entitlement.productId, discordUserId);
  }
}

export async function processLemonEvent(
  ctx: any,
  authUserId: string,
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
  const subjectId = emailHash
    ? await findSubjectByEmailHash(ctx, authUserId, emailHash)
    : undefined;
  const now = Date.now();

  if (eventType.startsWith('order_')) {
    const variantId =
      attributes.first_order_item && typeof attributes.first_order_item === 'object'
        ? String((attributes.first_order_item as any).variant_id ?? '')
        : '';
    const productId =
      attributes.first_order_item && typeof attributes.first_order_item === 'object'
        ? String((attributes.first_order_item as any).product_id ?? '')
        : '';
    const resolved = await resolveLemonCatalogProduct(ctx, authUserId, [variantId, productId]);
    const transactionStatus =
      eventType === 'order_refunded' || attributes.refunded === true ? 'refunded' : 'paid';

    const existing = await ctx.db
      .query('provider_transactions')
      .withIndex('by_external_id', (q: any) =>
        q.eq('providerKey', 'lemonsqueezy').eq('externalTransactionId', objectId)
      )
      .filter((q: any) => q.eq(q.field('authUserId'), authUserId))
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
              ? String(
                  (attributes.first_order_item as any).id ?? existing.externalOrderItemId ?? ''
                )
              : existing.externalOrderItemId,
          externalStoreId:
            typeof attributes.store_id === 'number'
              ? String(attributes.store_id)
              : existing.externalStoreId,
          externalProductId: productId || existing.externalProductId,
          externalVariantId: variantId || existing.externalVariantId,
          externalCustomerId:
            typeof attributes.customer_id === 'number'
              ? String(attributes.customer_id)
              : existing.externalCustomerId,
          customerEmail: normalizedEmail ?? existing.customerEmail,
          customerEmailHash: emailHash ?? existing.customerEmailHash,
          currency:
            typeof attributes.currency === 'string' ? attributes.currency : existing.currency,
          amountSubtotal:
            typeof attributes.subtotal === 'number' ? attributes.subtotal : existing.amountSubtotal,
          amountTotal:
            typeof attributes.total === 'number' ? attributes.total : existing.amountTotal,
          status: transactionStatus,
          purchasedAt: Number.parseInt(
            String(Date.parse(String(attributes.created_at ?? '')) || existing.purchasedAt || now),
            10
          ),
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
          authUserId,
          providerConnectionId: connectionId,
          providerKey: 'lemonsqueezy',
          externalTransactionId: objectId,
          externalOrderNumber:
            typeof attributes.order_number === 'number'
              ? String(attributes.order_number)
              : undefined,
          externalOrderItemId:
            attributes.first_order_item && typeof attributes.first_order_item === 'object'
              ? String((attributes.first_order_item as any).id ?? '')
              : undefined,
          externalStoreId:
            typeof attributes.store_id === 'number' ? String(attributes.store_id) : undefined,
          externalProductId: productId || undefined,
          externalVariantId: variantId || undefined,
          externalCustomerId:
            typeof attributes.customer_id === 'number' ? String(attributes.customer_id) : undefined,
          customerEmail: normalizedEmail,
          customerEmailHash: emailHash,
          currency: typeof attributes.currency === 'string' ? attributes.currency : undefined,
          amountSubtotal: typeof attributes.subtotal === 'number' ? attributes.subtotal : undefined,
          amountTotal: typeof attributes.total === 'number' ? attributes.total : undefined,
          status: transactionStatus,
          purchasedAt:
            typeof attributes.created_at === 'string'
              ? new Date(attributes.created_at).getTime()
              : now,
          refundedAt:
            typeof attributes.refunded_at === 'string'
              ? new Date(attributes.refunded_at).getTime()
              : undefined,
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
        authUserId,
        subjectId,
        providerKey: 'lemonsqueezy',
        providerConnectionId: connectionId,
        transactionId,
        sourceReference: sourceRef,
        evidenceType: transactionStatus === 'refunded' ? 'purchase.refunded' : 'purchase.recorded',
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
        authUserId,
        subjectId,
        'lemonsqueezy',
        sourceRef,
        resolved.productId,
        resolved.catalogProductId,
        typeof attributes.created_at === 'string' ? new Date(attributes.created_at).getTime() : now
      );
    } else if (transactionStatus === 'refunded') {
      await revokeCanonicalEntitlementBySource(ctx, authUserId, subjectId, sourceRef);
    }
    return;
  }

  if (eventType.startsWith('subscription_')) {
    const variantId =
      typeof attributes.variant_id === 'number' ? String(attributes.variant_id) : '';
    const productId =
      typeof attributes.product_id === 'number' ? String(attributes.product_id) : '';
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
    const resolved = await resolveLemonCatalogProduct(ctx, authUserId, [variantId, productId]);

    const existing = await ctx.db
      .query('provider_memberships')
      .withIndex('by_external_id', (q: any) =>
        q.eq('providerKey', 'lemonsqueezy').eq('externalMembershipId', objectId)
      )
      .filter((q: any) => q.eq(q.field('authUserId'), authUserId))
      .first();
    const membershipId = existing?._id
      ? (await ctx.db.patch(existing._id, {
          providerConnectionId: connectionId,
          externalTransactionId:
            typeof attributes.order_id === 'number'
              ? String(attributes.order_id)
              : existing.externalTransactionId,
          externalProductId: productId || existing.externalProductId,
          externalVariantId: variantId || existing.externalVariantId,
          externalCustomerId:
            typeof attributes.customer_id === 'number'
              ? String(attributes.customer_id)
              : existing.externalCustomerId,
          customerEmail: normalizedEmail ?? existing.customerEmail,
          customerEmailHash: emailHash ?? existing.customerEmailHash,
          status,
          startedAt:
            typeof attributes.created_at === 'string'
              ? new Date(attributes.created_at).getTime()
              : existing.startedAt,
          renewsAt:
            typeof attributes.renews_at === 'string'
              ? new Date(attributes.renews_at).getTime()
              : existing.renewsAt,
          endsAt:
            typeof attributes.ends_at === 'string'
              ? new Date(attributes.ends_at).getTime()
              : existing.endsAt,
          cancelledAt: status === 'cancelled' || status === 'expired' ? now : existing.cancelledAt,
          rawWebhookEventId: event._id,
          metadata: { payload },
          updatedAt: now,
        }),
        existing._id)
      : await ctx.db.insert('provider_memberships', {
          authUserId,
          providerConnectionId: connectionId,
          providerKey: 'lemonsqueezy',
          externalMembershipId: objectId,
          externalTransactionId:
            typeof attributes.order_id === 'number' ? String(attributes.order_id) : undefined,
          externalProductId: productId || undefined,
          externalVariantId: variantId || undefined,
          externalCustomerId:
            typeof attributes.customer_id === 'number' ? String(attributes.customer_id) : undefined,
          customerEmail: normalizedEmail,
          customerEmailHash: emailHash,
          status,
          startedAt:
            typeof attributes.created_at === 'string'
              ? new Date(attributes.created_at).getTime()
              : now,
          renewsAt:
            typeof attributes.renews_at === 'string'
              ? new Date(attributes.renews_at).getTime()
              : undefined,
          endsAt:
            typeof attributes.ends_at === 'string'
              ? new Date(attributes.ends_at).getTime()
              : undefined,
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
        authUserId,
        subjectId,
        providerKey: 'lemonsqueezy',
        providerConnectionId: connectionId,
        membershipId,
        sourceReference: sourceRef,
        evidenceType: evidenceStatus === 'revoked' ? 'subscription.ended' : 'subscription.updated',
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
        authUserId,
        subjectId,
        'lemonsqueezy',
        sourceRef,
        resolved.productId,
        resolved.catalogProductId,
        typeof attributes.created_at === 'string' ? new Date(attributes.created_at).getTime() : now
      );
    } else if (evidenceStatus === 'revoked') {
      await revokeCanonicalEntitlementBySource(ctx, authUserId, subjectId, sourceRef);
    }
    return;
  }

  if (eventType.startsWith('license_key_')) {
    const variantId =
      typeof attributes.variant_id === 'number' ? String(attributes.variant_id) : '';
    const productId =
      typeof attributes.product_id === 'number' ? String(attributes.product_id) : '';
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
      .filter((q: any) => q.eq(q.field('authUserId'), authUserId))
      .first();
    const licenseId = existing?._id
      ? (await ctx.db.patch(existing._id, {
          providerConnectionId: connectionId,
          externalTransactionId:
            typeof attributes.order_id === 'number'
              ? String(attributes.order_id)
              : existing.externalTransactionId,
          externalProductId: productId || existing.externalProductId,
          externalVariantId: variantId || existing.externalVariantId,
          externalCustomerId:
            typeof attributes.customer_id === 'number'
              ? String(attributes.customer_id)
              : existing.externalCustomerId,
          customerEmail: normalizedEmail ?? existing.customerEmail,
          customerEmailHash: emailHash ?? existing.customerEmailHash,
          licenseKeyHash:
            typeof attributes.key === 'string'
              ? await sha256Hex(attributes.key)
              : existing.licenseKeyHash,
          shortKey:
            typeof attributes.key_short === 'string' ? attributes.key_short : existing.shortKey,
          status: licenseStatus,
          issuedAt:
            typeof attributes.created_at === 'string'
              ? new Date(attributes.created_at).getTime()
              : existing.issuedAt,
          expiresAt:
            typeof attributes.expires_at === 'string'
              ? new Date(attributes.expires_at).getTime()
              : existing.expiresAt,
          lastValidatedAt: now,
          revokedAt:
            licenseStatus === 'disabled' || licenseStatus === 'expired' ? now : existing.revokedAt,
          rawWebhookEventId: event._id,
          metadata: { payload },
          updatedAt: now,
        }),
        existing._id)
      : await ctx.db.insert('provider_licenses', {
          authUserId,
          providerConnectionId: connectionId,
          providerKey: 'lemonsqueezy',
          externalLicenseId: objectId,
          externalTransactionId:
            typeof attributes.order_id === 'number' ? String(attributes.order_id) : undefined,
          externalProductId: productId || undefined,
          externalVariantId: variantId || undefined,
          externalCustomerId:
            typeof attributes.customer_id === 'number' ? String(attributes.customer_id) : undefined,
          customerEmail: normalizedEmail,
          customerEmailHash: emailHash,
          licenseKeyHash:
            typeof attributes.key === 'string' ? await sha256Hex(attributes.key) : undefined,
          shortKey: typeof attributes.key_short === 'string' ? attributes.key_short : undefined,
          status: licenseStatus,
          issuedAt:
            typeof attributes.created_at === 'string'
              ? new Date(attributes.created_at).getTime()
              : now,
          expiresAt:
            typeof attributes.expires_at === 'string'
              ? new Date(attributes.expires_at).getTime()
              : undefined,
          lastValidatedAt: now,
          revokedAt: licenseStatus === 'disabled' || licenseStatus === 'expired' ? now : undefined,
          rawWebhookEventId: event._id,
          metadata: { payload },
          createdAt: now,
          updatedAt: now,
        });

    const resolved = await resolveLemonCatalogProduct(ctx, authUserId, [variantId, productId]);
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
        authUserId,
        subjectId,
        providerKey: 'lemonsqueezy',
        providerConnectionId: connectionId,
        licenseId,
        sourceReference: sourceRef,
        evidenceType: evidenceStatus === 'active' ? 'license.issued' : 'license.revoked',
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
        authUserId,
        subjectId,
        'lemonsqueezy',
        sourceRef,
        resolved.productId,
        resolved.catalogProductId,
        typeof attributes.created_at === 'string' ? new Date(attributes.created_at).getTime() : now
      );
    } else if (evidenceStatus === 'revoked') {
      await revokeCanonicalEntitlementBySource(ctx, authUserId, subjectId, sourceRef);
    }
  }
}
