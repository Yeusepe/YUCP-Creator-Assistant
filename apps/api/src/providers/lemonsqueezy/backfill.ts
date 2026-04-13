/**
 * Lemon Squeezy provider plugin
 *
 * Products: fetches via LemonSqueezyApiClient.getProducts (page-based)
 * Backfill: two-phase, subscriptions first, then order-items
 *   Phase cursor: JSON-encoded { phase: 'subscriptions' | 'orders'; page: number }
 */

import {
  detectProviderRateLimitError,
  withProviderRateLimitRetries,
} from '@yucp/providers/core/rateLimit';
import { LemonSqueezyApiClient } from '@yucp/providers/lemonsqueezy';
import { normalizeEmail, sha256Hex } from '@yucp/shared/crypto';
import { encrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import type { BackfillPlugin, BackfillRecord } from '../types';

const PURCHASE_BUYER_EMAIL_PURPOSE = 'purchase-buyer-email';

const MAX_RATE_LIMIT_RETRIES = 10;

type LSCursor = { phase: 'subscriptions' | 'orders'; page: number };

export const backfill: BackfillPlugin = {
  pageDelayMs: 250,

  async fetchPage(apiKey, productRef, cursor, pageSize, encryptionSecret) {
    const state: LSCursor = cursor
      ? (JSON.parse(cursor) as LSCursor)
      : { phase: 'subscriptions', page: 1 };

    const client = new LemonSqueezyApiClient({ apiToken: apiKey });

    if (state.phase === 'subscriptions') {
      const { subscriptions, pagination } = await withProviderRateLimitRetries({
        providerName: 'LemonSqueezy',
        maxRetries: MAX_RATE_LIMIT_RETRIES,
        operation: () =>
          client.getSubscriptions({
            productId: productRef,
            page: state.page,
            perPage: pageSize,
          }),
        getRateLimitError: (error) =>
          detectProviderRateLimitError(error, {
            providerName: 'LemonSqueezy',
            fallbackWaitMs: 5_000,
          }),
        onRetry: ({ waitMs, retries }) => {
          logger.warn('LemonSqueezy rate limit (subscriptions)', { waitMs, retries });
        },
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
    } else {
      // Orders phase: paginate /order-items, fetch each order for email
      const { orderItems, pagination } = await withProviderRateLimitRetries({
        providerName: 'LemonSqueezy',
        maxRetries: MAX_RATE_LIMIT_RETRIES,
        operation: () =>
          client.getOrderItems({
            productId: productRef,
            page: state.page,
            perPage: pageSize,
          }),
        getRateLimitError: (error) =>
          detectProviderRateLimitError(error, {
            providerName: 'LemonSqueezy',
            fallbackWaitMs: 5_000,
          }),
        onRetry: ({ waitMs, retries }) => {
          logger.warn('LemonSqueezy rate limit (orders)', { waitMs, retries });
        },
      });

      const facts: BackfillRecord[] = [];
      for (const item of orderItems) {
        if (!item.orderId) continue;
        await new Promise((r) => setTimeout(r, 250));
        const order = await client.getOrder(item.orderId);
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
    }
  },
};
