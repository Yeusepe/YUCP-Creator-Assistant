import type { Id } from '../_generated/dataModel';
import {
  findSubjectByEmailHash,
  normalizeEmail,
  projectEntitlementFromPurchaseFact,
  revokeEntitlementForPurchaseFact,
  sha256Hex,
} from './_helpers';
import { PII_PURPOSES } from '../lib/credentialKeys';
import { encryptPii } from '../lib/piiCrypto';

/**
 * Find subjectId by Jinxxy user ID via external_accounts + bindings.
 * Jinxxy external accounts often lack emailHash, so this fallback matches
 * by providerUserId when the order's user.id matches a linked Jinxxy account.
 */
async function findSubjectByJinxxyUserId(
  ctx: any,
  authUserId: string,
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
    .withIndex('by_auth_user_external', (q: any) =>
      q.eq('authUserId', authUserId).eq('externalAccountId', ext._id)
    )
    .filter((q: any) => q.eq(q.field('status'), 'active'))
    .first();
  return binding?.subjectId;
}

export async function processJinxxyEvent(
  ctx: any,
  authUserId: string,
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
  const purchasedAt = createdAt ? new Date(createdAt).getTime() : Date.now();

  const orderItems = (data.order_items ?? []) as Array<{
    id: string;
    target_type: string;
    target_id: string;
    name?: string;
  }>;

  const normalized = email ? normalizeEmail(email) : undefined;
  const buyerEmailHash = normalized ? await sha256Hex(normalized) : undefined;
  const buyerEmailEncrypted = await encryptPii(normalized, PII_PURPOSES.purchaseBuyerEmail);

  const jinxxyUserId = (data.user as { id?: string })?.id;

  const subjectId =
    (buyerEmailHash ? await findSubjectByEmailHash(ctx, authUserId, buyerEmailHash) : undefined) ??
    (jinxxyUserId ? await findSubjectByJinxxyUserId(ctx, authUserId, jinxxyUserId) : undefined);

  const now = Date.now();

  for (const item of orderItems) {
    if (item.target_type !== 'DIGITAL_PRODUCT') continue;

    const externalLineItemId = item.id;
    const providerProductId = item.target_id;
    const sourceRef = `jinxxy:${orderId}:${externalLineItemId}`;

    const existing = await ctx.db
      .query('purchase_facts')
      .withIndex('by_auth_user_provider_order', (q: any) =>
        q.eq('authUserId', authUserId).eq('provider', 'jinxxy').eq('externalOrderId', orderId)
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
        await revokeEntitlementForPurchaseFact(ctx, authUserId, existing, sourceRef);
      } else if (isPaid && resolvedSubjectId && !existing.subjectId) {
        // Previously had no subjectId (e.g. email not linked); now we have it via Jinxxy user ID
        await projectEntitlementFromPurchaseFact(
          ctx,
          authUserId,
          resolvedSubjectId,
          providerProductId,
          sourceRef,
          purchasedAt
        );
      }
    } else if (isPaid) {
      await ctx.db.insert('purchase_facts', {
        authUserId,
        provider: 'jinxxy',
        externalOrderId: orderId,
        externalLineItemId,
        buyerEmailHash,
        buyerEmailEncrypted,
        providerUserId: jinxxyUserId,
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
          authUserId,
          subjectId,
          providerProductId,
          sourceRef,
          purchasedAt
        );
      }
    }
  }
}
