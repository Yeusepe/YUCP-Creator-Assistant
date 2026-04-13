import {
  detectProviderRateLimitError,
  withProviderRateLimitRetries,
} from '@yucp/providers/core/rateLimit';
import { JinxxyApiClient } from '@yucp/providers/jinxxy';
import { logger } from '../../lib/logger';
import type { BackfillPlugin, BackfillRecord } from '../types';

const MAX_RATE_LIMIT_RETRIES = 10;

export const backfill: BackfillPlugin = {
  pageDelayMs: 600,

  async fetchPage(apiKey, productRef, cursor, pageSize, _encryptionSecret) {
    const page = cursor ? Number.parseInt(cursor, 10) : 1;
    const client = new JinxxyApiClient({ apiKey });

    return withProviderRateLimitRetries({
      providerName: 'Jinxxy',
      maxRetries: MAX_RATE_LIMIT_RETRIES,
      operation: async () => {
        // Jinxxy /licenses does not support product_id filtering, filter client-side
        const { licenses, pagination } = await client.getLicenses({ page, per_page: pageSize });

        const filtered = licenses.filter((l) => l.product_id === productRef);

        const facts: BackfillRecord[] = filtered.map((license) => ({
          authUserId: '',
          provider: 'jinxxy',
          externalOrderId: license.order_id ?? license.id,
          buyerEmailHash: undefined,
          providerUserId: license.customer_id ?? undefined,
          providerProductId: license.product_id,
          paymentStatus: 'completed',
          lifecycleStatus: 'active',
          purchasedAt: license.created_at ? new Date(license.created_at).getTime() : Date.now(),
        }));

        return { facts, nextCursor: pagination?.has_next ? String(page + 1) : null };
      },
      getRateLimitError: (error) =>
        detectProviderRateLimitError(error, {
          providerName: 'Jinxxy',
          fallbackWaitMs: 60_000,
        }),
      onRetry: ({ waitMs, retries }) => {
        logger.warn('Jinxxy rate limit, waiting', { waitMs, retries });
      },
    });
  },
};
