/**
 * Lemon Squeezy provider plugin
 *
 * Products: fetches via LemonSqueezyApiClient.getProducts (page-based)
 * Backfill: two-phase — subscriptions first, then order-items
 *   Phase cursor: JSON-encoded { phase: 'subscriptions' | 'orders'; page: number }
 */

import { LemonSqueezyApiClient } from '@yucp/providers/lemonsqueezy';
import { createLogger } from '@yucp/shared';
import { encrypt } from '../../lib/encrypt';
import type { BackfillPlugin, BackfillRecord } from '../types';

const PURCHASE_BUYER_EMAIL_PURPOSE = 'purchase-buyer-email';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const MAX_RATE_LIMIT_RETRIES = 10;

type LSCursor = { phase: 'subscriptions' | 'orders'; page: number };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const backfill: BackfillPlugin = {
  pageDelayMs: 250,

  async fetchPage(apiKey, productRef, cursor, pageSize, encryptionSecret) {
    const state: LSCursor = cursor
      ? (JSON.parse(cursor) as LSCursor)
      : { phase: 'subscriptions', page: 1 };

    const client = new LemonSqueezyApiClient({ apiToken: apiKey });

    if (state.phase === 'subscriptions') {
      let retries = 0;
      while (true) {
        try {
          const { subscriptions, pagination } = await client.getSubscriptions({
            productId: productRef,
            page: state.page,
            perPage: pageSize,
          });

          const facts: BackfillRecord[] = await Promise.all(
            subscriptions.map(async (sub) => {
              const email = sub.userEmail ?? '';
              const normalized = email ? normalizeEmail(email) : undefined;
              const buyerEmailHash = normalized ? await sha256Hex(normalized) : undefined;
              const buyerEmailEncrypted = normalized
                ? await encrypt(normalized, encryptionSecret, PURCHASE_BUYER_EMAIL_PURPOSE)
                : undefined;
              const isCancelled = sub.status === 'cancelled' || sub.status === 'expired';
              return {
                authUserId: '',
                provider: 'lemonsqueezy',
                externalOrderId: sub.orderId ?? sub.id,
                buyerEmailHash,
                buyerEmailEncrypted,
                providerProductId: productRef,
                paymentStatus: 'paid',
                lifecycleStatus: (isCancelled
                  ? 'cancelled'
                  : 'active') as BackfillRecord['lifecycleStatus'],
                purchasedAt: sub.createdAt ? new Date(sub.createdAt).getTime() : Date.now(),
              };
            })
          );

          const nextCursor: string | null = pagination.nextPage
            ? JSON.stringify({ phase: 'subscriptions', page: pagination.nextPage })
            : JSON.stringify({ phase: 'orders', page: 1 });

          return { facts, nextCursor };
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message.includes('429') || err.message.toLowerCase().includes('rate limit'))
          ) {
            const waitMs = 5_000;
            logger.warn('LemonSqueezy rate limit (subscriptions)', { waitMs, retries });
            await new Promise((r) => setTimeout(r, waitMs));
            if (retries >= MAX_RATE_LIMIT_RETRIES) {
              throw new Error(
                `LemonSqueezy rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries`
              );
            }
            retries++;
            continue;
          }
          throw err;
        }
      }
    } else {
      // Orders phase: paginate /order-items, fetch each order for email
      let retries = 0;
      while (true) {
        try {
          const { orderItems, pagination } = await client.getOrderItems({
            productId: productRef,
            page: state.page,
            perPage: pageSize,
          });

          const facts: BackfillRecord[] = [];
          for (const item of orderItems) {
            if (!item.orderId) continue;
            await new Promise((r) => setTimeout(r, 250));
            let order = null;
            try {
              order = await client.getOrder(item.orderId);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
                logger.warn('LemonSqueezy getOrder not found, skipping order item', {
                  orderId: item.orderId,
                  error: msg,
                });
              } else {
                // Transient error — rethrow so the page is not advanced past this order.
                throw err;
              }
            }
            if (!order) continue;
            const email = order.userEmail ?? '';
            const normalized = email ? normalizeEmail(email) : undefined;
            const buyerEmailHash = normalized ? await sha256Hex(normalized) : undefined;
            const buyerEmailEncrypted = normalized
              ? await encrypt(normalized, encryptionSecret, PURCHASE_BUYER_EMAIL_PURPOSE)
              : undefined;
            facts.push({
              authUserId: '',
              provider: 'lemonsqueezy',
              externalOrderId: item.orderId,
              externalLineItemId: item.id,
              buyerEmailHash,
              buyerEmailEncrypted,
              providerProductId: productRef,
              paymentStatus: order.refunded ? 'refunded' : 'paid',
              lifecycleStatus: (order.refunded
                ? 'refunded'
                : 'active') as BackfillRecord['lifecycleStatus'],
              purchasedAt: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
            });
          }

          return {
            facts,
            nextCursor: pagination.nextPage
              ? JSON.stringify({ phase: 'orders', page: pagination.nextPage })
              : null,
          };
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message.includes('429') || err.message.toLowerCase().includes('rate limit'))
          ) {
            const waitMs = 5_000;
            logger.warn('LemonSqueezy rate limit (orders)', { waitMs, retries });
            await new Promise((r) => setTimeout(r, waitMs));
            if (retries >= MAX_RATE_LIMIT_RETRIES) {
              throw new Error(
                `LemonSqueezy rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries`
              );
            }
            retries++;
            continue;
          }
          throw err;
        }
      }
    }
  },
};
