import { JinxxyApiClient } from '@yucp/providers/jinxxy';
import { createLogger } from '@yucp/shared';
import type { BackfillPlugin, BackfillRecord } from '../types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const MAX_RATE_LIMIT_RETRIES = 10;

export const backfill: BackfillPlugin = {
  pageDelayMs: 600,

  async fetchPage(apiKey, productRef, cursor, pageSize) {
    const page = cursor ? Number.parseInt(cursor, 10) : 1;
    const client = new JinxxyApiClient({ apiKey });
    let retries = 0;

    while (true) {
      try {
        // Jinxxy /licenses does not support product_id filtering — filter client-side
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
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes('429') || err.message.toLowerCase().includes('rate limit'))
        ) {
          const waitMs = 60_000;
          logger.warn('Jinxxy rate limit, waiting', { waitMs, retries });
          await new Promise((r) => setTimeout(r, waitMs));
          if (retries >= MAX_RATE_LIMIT_RETRIES) {
            throw new Error(`Jinxxy rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries`);
          }
          retries++;
          continue;
        }
        throw err;
      }
    }
  },
};
