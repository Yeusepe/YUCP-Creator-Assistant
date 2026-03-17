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
 * Upsert a Payhip product entry into `provider_catalog_mappings`.
 * Called from processPayhipEvent whenever a purchase webhook fires so that product
 * names discovered from real sales are stored and available for the products UI.
 */
async function upsertPayhipCatalogMapping(
  ctx: any,
  authUserId: string,
  connectionId: Id<'provider_connections'>,
  product: { permalink: string; displayName?: string; productPermalink?: string }
): Promise<void> {
  const existing = await ctx.db
    .query('provider_catalog_mappings')
    .withIndex('by_connection', (q: any) => q.eq('providerConnectionId', connectionId))
    .filter((q: any) => q.eq(q.field('externalProductId'), product.permalink))
    .first();

  const now = Date.now();
  if (existing) {
    if (!existing.displayName && product.displayName) {
      await ctx.db.patch(existing._id, {
        displayName: product.displayName,
        metadata: {
          ...(typeof existing.metadata === 'object' && existing.metadata !== null
            ? existing.metadata
            : {}),
          productPermalink:
            product.productPermalink ?? (existing.metadata as any)?.productPermalink,
        },
        updatedAt: now,
      });
    }
  } else {
    await ctx.db.insert('provider_catalog_mappings', {
      authUserId,
      providerConnectionId: connectionId,
      providerKey: 'payhip',
      externalProductId: product.permalink,
      displayName: product.displayName,
      status: 'active',
      metadata: { productPermalink: product.productPermalink },
      createdAt: now,
      updatedAt: now,
    });
  }
}

/**
 * Process a Payhip webhook event.
 *
 * Handles `paid` and `refunded` events. Each transaction can have multiple items.
 * The canonical product identifier is `items[].product_key` (the permalink, e.g. "RGsF"),
 * matching the `product_link` field returned by the Payhip license key verify API.
 * The numeric `product_id` is used only for per-line-item deduplication.
 *
 * Also upserts each product into `provider_catalog_mappings` so that names discovered
 * from webhook events are available for product-listing even before any manual setup.
 */
export async function processPayhipEvent(
  ctx: any,
  authUserId: string,
  event: any,
  payload: Record<string, unknown>
): Promise<void> {
  const transactionId = String(payload.id ?? '');
  const email = String(payload.email ?? '');
  const eventType = String(payload.type ?? '');
  const dateSec = typeof payload.date === 'number' ? payload.date : 0;
  const purchasedAt = dateSec > 0 ? dateSec * 1000 : Date.now();

  const items = (payload.items ?? []) as Array<{
    product_id?: string;
    product_key?: string;
    product_name?: string;
    product_permalink?: string;
  }>;

  if (!transactionId) {
    throw new Error('Payhip webhook missing id field');
  }

  const normalized = email ? normalizeEmail(email) : undefined;
  const buyerEmailHash = normalized ? await sha256Hex(normalized) : undefined;
  const buyerEmailEncrypted = await encryptPii(normalized, PII_PURPOSES.purchaseBuyerEmail);
  const subjectId = buyerEmailHash
    ? await findSubjectByEmailHash(ctx, authUserId, buyerEmailHash)
    : undefined;

  const now = Date.now();

  // Upsert catalog mappings so product names are discoverable
  const conn = await ctx.db
    .query('provider_connections')
    .withIndex('by_auth_user_provider', (q: any) =>
      q.eq('authUserId', authUserId).eq('provider', 'payhip')
    )
    .first();

  if (conn) {
    for (const item of items) {
      const permalink = item.product_key;
      if (!permalink) continue;
      await upsertPayhipCatalogMapping(ctx, authUserId, conn._id, {
        permalink,
        displayName: item.product_name,
        productPermalink: item.product_permalink,
      });
    }
  }

  if (eventType === 'paid') {
    for (const item of items) {
      const permalink = item.product_key;
      if (!permalink) continue;

      const externalLineItemId = item.product_id ? String(item.product_id) : permalink;
      const sourceRef = `payhip:${transactionId}:${externalLineItemId}`;

      const existing = await ctx.db
        .query('purchase_facts')
        .withIndex('by_auth_user_provider_order', (q: any) =>
          q
            .eq('authUserId', authUserId)
            .eq('provider', 'payhip')
            .eq('externalOrderId', transactionId)
        )
        .filter((q: any) => q.eq(q.field('externalLineItemId'), externalLineItemId))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          lifecycleStatus: 'active',
          paymentStatus: 'paid',
          subjectId: subjectId ?? existing.subjectId,
          rawSourceEventId: event._id,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('purchase_facts', {
          authUserId,
          provider: 'payhip',
          externalOrderId: transactionId,
          externalLineItemId,
          buyerEmailHash,
          buyerEmailEncrypted,
          providerProductId: permalink,
          paymentStatus: 'paid',
          lifecycleStatus: 'active',
          purchasedAt,
          rawSourceEventId: event._id,
          subjectId,
          createdAt: now,
          updatedAt: now,
        });
      }

      if (subjectId) {
        await projectEntitlementFromPurchaseFact(
          ctx,
          authUserId,
          subjectId,
          permalink,
          sourceRef,
          purchasedAt
        );
      }
    }
  } else if (eventType === 'refunded') {
    for (const item of items) {
      const permalink = item.product_key;
      if (!permalink) continue;

      const externalLineItemId = item.product_id ? String(item.product_id) : permalink;
      const sourceRef = `payhip:${transactionId}:${externalLineItemId}`;

      const existing = await ctx.db
        .query('purchase_facts')
        .withIndex('by_auth_user_provider_order', (q: any) =>
          q
            .eq('authUserId', authUserId)
            .eq('provider', 'payhip')
            .eq('externalOrderId', transactionId)
        )
        .filter((q: any) => q.eq(q.field('externalLineItemId'), externalLineItemId))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          lifecycleStatus: 'refunded',
          paymentStatus: 'refunded',
          rawSourceEventId: event._id,
          updatedAt: now,
        });
        if (existing.subjectId) {
          await revokeEntitlementForPurchaseFact(ctx, authUserId, existing, sourceRef);
        }
      }
    }
  }
  // subscription.created / subscription.deleted, out of scope for v1, silently ignored
}
