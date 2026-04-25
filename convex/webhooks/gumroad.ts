import { buildGumroadTierRefFromPurchaseSelection } from '../../packages/providers/src/gumroad/types';
import { PII_PURPOSES } from '../lib/credentialKeys';
import { encryptPii } from '../lib/piiCrypto';
import {
  findSubjectByEmailHash,
  normalizeEmail,
  projectEntitlementFromPurchaseFact,
  revokeEntitlementForPurchaseFact,
  sha256Hex,
} from './_helpers';

export async function processGumroadEvent(
  ctx: any,
  authUserId: string,
  event: any,
  payload: Record<string, unknown>
): Promise<void> {
  const saleId = (payload.sale_id ?? payload.order_number) as string;
  const productId = (payload.product_id ?? payload.short_product_id ?? '') as string;
  const email = (payload.email ?? '') as string;
  const refunded = payload.refunded === true || payload.refunded === 'true';
  const _eventType = event.eventType as string;

  if (!saleId || !productId) {
    throw new Error('Gumroad: missing sale_id or product_id');
  }

  const lifecycleStatus = refunded ? 'refunded' : 'active';
  const normalized = email ? normalizeEmail(email) : undefined;
  const buyerEmailHash = normalized ? await sha256Hex(normalized) : undefined;
  const buyerEmailEncrypted = await encryptPii(normalized, PII_PURPOSES.purchaseBuyerEmail);

  const saleTimestamp = payload.sale_timestamp
    ? Number.parseInt(String(payload.sale_timestamp), 10) * 1000
    : Date.now();
  const externalVariantId = buildGumroadTierRefFromPurchaseSelection({
    productId,
    variants: payload.variants,
    recurrence: payload.recurrence,
  });

  const existing = await ctx.db
    .query('purchase_facts')
    .withIndex('by_auth_user_provider_order', (q: any) =>
      q.eq('authUserId', authUserId).eq('provider', 'gumroad').eq('externalOrderId', saleId)
    )
    .first();

  const now = Date.now();
  const sourceRef = `gumroad:${saleId}`;

  if (existing) {
    await ctx.db.patch(existing._id, {
      lifecycleStatus,
      externalVariantId: externalVariantId ?? existing.externalVariantId,
      paymentStatus: refunded ? 'refunded' : existing.paymentStatus,
      updatedAt: now,
      rawSourceEventId: event._id,
    });

    if (refunded && existing.subjectId) {
      await revokeEntitlementForPurchaseFact(ctx, authUserId, existing, sourceRef);
    }
  } else {
    if (refunded) {
      return; // Refund for unknown sale - nothing to update
    }

    const subjectId = buyerEmailHash
      ? await findSubjectByEmailHash(ctx, authUserId, buyerEmailHash)
      : undefined;

    await ctx.db.insert('purchase_facts', {
      authUserId,
      provider: 'gumroad',
      externalOrderId: saleId,
      buyerEmailHash,
      buyerEmailEncrypted,
      providerProductId: productId,
      externalVariantId,
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
        authUserId,
        subjectId,
        productId,
        sourceRef,
        saleTimestamp
      );
    }
  }
}
