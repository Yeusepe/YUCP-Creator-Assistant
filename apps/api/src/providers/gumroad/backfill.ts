import {
  ProviderRateLimitError,
  parseRetryAfterMs,
  withProviderRateLimitRetries,
} from '@yucp/providers/core/rateLimit';
import { normalizeEmail, sha256Hex } from '@yucp/shared/crypto';
import { encrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import type { BackfillPlugin, BackfillRecord } from '../types';

const GUMROAD_API_BASE = 'https://api.gumroad.com/v2';
const MAX_RATE_LIMIT_RETRIES = 10;
const PURCHASE_BUYER_EMAIL_PURPOSE = 'purchase-buyer-email';

export const backfill: BackfillPlugin = {
  pageDelayMs: 1500,

  async fetchPage(accessToken, productRef, cursor, pageSize, encryptionSecret) {
    const page = cursor ? Number.parseInt(cursor, 10) : 1;

    return withProviderRateLimitRetries({
      providerName: 'Gumroad',
      maxRetries: MAX_RATE_LIMIT_RETRIES,
      operation: async () => {
        const res = await fetch(
          `${GUMROAD_API_BASE}/sales?product_id=${encodeURIComponent(productRef)}&page=${page}&per_page=${pageSize}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (res.status === 429) {
          throw new ProviderRateLimitError(
            'Gumroad',
            parseRetryAfterMs(res.headers.get('Retry-After'), 5_000)
          );
        }

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Gumroad API error: ${res.status} ${text}`);
        }

        const data = (await res.json()) as {
          sales?: Array<Record<string, unknown>>;
          next_page_url?: string;
        };
        const sales = data.sales ?? [];

        const facts: BackfillRecord[] = await Promise.all(
          sales.map(async (s) => {
            const email = (s.email ?? '') as string;
            const normalized = email ? normalizeEmail(email) : undefined;
            const buyerEmailHash = normalized ? await sha256Hex(normalized) : undefined;
            const buyerEmailEncrypted = normalized
              ? await encrypt(normalized, encryptionSecret, PURCHASE_BUYER_EMAIL_PURPOSE)
              : undefined;
            return {
              authUserId: '',
              provider: 'gumroad',
              externalOrderId: String(s.sale_id ?? s.id ?? ''),
              buyerEmailHash,
              buyerEmailEncrypted,
              providerProductId: String(s.product_id ?? ''),
              paymentStatus: s.refunded === true || s.refunded === 'true' ? 'refunded' : 'paid',
              lifecycleStatus: (s.refunded === true || s.refunded === 'true'
                ? 'refunded'
                : 'active') as BackfillRecord['lifecycleStatus'],
              purchasedAt:
                s.created_at && !Number.isNaN(new Date(s.created_at as string).getTime())
                  ? new Date(s.created_at as string).getTime()
                  : typeof s.sale_timestamp === 'number'
                    ? (s.sale_timestamp as number) * 1000
                    : Date.now(),
            };
          })
        );

        return { facts, nextCursor: data.next_page_url ? String(page + 1) : null };
      },
      getRateLimitError: (error) => (error instanceof ProviderRateLimitError ? error : null),
      onRetry: ({ waitMs, retries }) => {
        logger.warn('Gumroad rate limit', { waitMs, retries });
      },
    });
  },
};
