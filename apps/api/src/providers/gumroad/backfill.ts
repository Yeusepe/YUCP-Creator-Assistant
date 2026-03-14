import { createLogger } from '@yucp/shared';
import type { BackfillPlugin, BackfillRecord } from '../types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const GUMROAD_API_BASE = 'https://api.gumroad.com/v2';
const MAX_RATE_LIMIT_RETRIES = 10;

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
  pageDelayMs: 1500,

  async fetchPage(accessToken, productRef, cursor, pageSize) {
    const page = cursor ? Number.parseInt(cursor, 10) : 1;
    let retries = 0;

    while (true) {
      const res = await fetch(
        `${GUMROAD_API_BASE}/sales?access_token=${encodeURIComponent(accessToken)}&product_id=${encodeURIComponent(productRef)}&page=${page}&per_page=${pageSize}`,
        { headers: { 'Content-Type': 'application/json' } }
      );

      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
        logger.warn('Gumroad rate limit', { waitMs, retries });
        await new Promise((r) => setTimeout(r, waitMs));
        if (retries >= MAX_RATE_LIMIT_RETRIES) {
          throw new Error(`Gumroad rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries`);
        }
        retries++;
        continue;
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
          return {
            authUserId: '',
            provider: 'gumroad',
            externalOrderId: String(s.sale_id ?? s.id ?? ''),
            buyerEmailHash: normalized ? await sha256Hex(normalized) : undefined,
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
    }
  },
};
