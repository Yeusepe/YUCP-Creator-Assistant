/**
 * Internal Backfill API Route
 *
 * POST /api/internal/backfill-product
 * Called by Convex action backfillProductPurchases when BACKFILL_API_URL is set.
 * Fetches sales from Gumroad/Jinxxy, decrypts tokens, ingests into purchase_facts.
 */

import { JinxxyApiClient } from '@yucp/providers/jinxxy';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { decrypt } from '../lib/encrypt';
import { loadEnv } from '../lib/env';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const BATCH_SIZE = 100;
const PAGE_DELAY_MS = 1500;

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

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

export type BackfillProvider = 'gumroad' | 'jinxxy' | 'lemonsqueezy';

export interface BackfillRequest {
  apiSecret: string;
  tenantId: string;
  productId: string;
  provider: BackfillProvider;
  providerProductRef: string;
}

export async function handleBackfillProduct(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await request.json()) as BackfillRequest;
    const { apiSecret, tenantId, productId, provider, providerProductRef } = body;

    if (!apiSecret || !tenantId || !productId || !provider || !providerProductRef) {
      return new Response(
        JSON.stringify({
          error:
            'Missing required fields: apiSecret, tenantId, productId, provider, providerProductRef',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const expectedSecret = process.env.CONVEX_API_SECRET;
    if (!expectedSecret || !timingSafeEqual(apiSecret, expectedSecret)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const convexUrl = process.env.CONVEX_URL ?? process.env.CONVEX_DEPLOYMENT ?? '';
    if (!convexUrl) {
      return new Response(JSON.stringify({ error: 'CONVEX_URL not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const convex = getConvexClientFromUrl(convexUrl);

    const encryptionSecret = loadEnv().BETTER_AUTH_SECRET;
    if (!encryptionSecret) {
      return new Response(JSON.stringify({ error: 'BETTER_AUTH_SECRET not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let totalInserted = 0;
    let totalSkipped = 0;

    if (provider === 'gumroad') {
      const connWithToken = await convex.query(api.providerConnections.getConnectionForBackfill, {
        apiSecret,
        tenantId,
        provider: 'gumroad',
      });

      if (!connWithToken?.gumroadAccessTokenEncrypted) {
        return new Response(JSON.stringify({ error: 'Gumroad token not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const accessToken = await decrypt(
        connWithToken.gumroadAccessTokenEncrypted,
        encryptionSecret
      );

      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(
          `https://api.gumroad.com/v2/sales?product_id=${encodeURIComponent(providerProductRef)}&page=${page}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (res.status === 429) {
          const retryAfter = res.headers.get('Retry-After');
          const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
          logger.warn('Gumroad rate limit, waiting', { waitMs });
          await new Promise((r) => setTimeout(r, waitMs));
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

        if (sales.length === 0) {
          hasMore = false;
          break;
        }

        const purchases = await Promise.all(
          sales.map(async (s: Record<string, unknown>) => {
            const saleId = String(s.sale_id ?? s.id ?? '');
            const productIdVal = String(s.product_id ?? '');
            const email = (s.email ?? '') as string;
            const refunded = s.refunded === true || s.refunded === 'true';
            const saleTimestamp = s.created_at
              ? new Date(s.created_at as string).getTime()
              : typeof s.sale_timestamp === 'number'
                ? s.sale_timestamp * 1000
                : Date.now();

            const buyerEmailNormalized = email ? normalizeEmail(email) : undefined;
            const buyerEmailHash = buyerEmailNormalized
              ? await sha256Hex(buyerEmailNormalized)
              : undefined;

            return {
              tenantId,
              provider: 'gumroad' as const,
              externalOrderId: saleId,
              buyerEmailNormalized,
              buyerEmailHash,
              providerProductId: productIdVal,
              paymentStatus: refunded ? 'refunded' : 'paid',
              lifecycleStatus: (refunded ? 'refunded' : 'active') as
                | 'active'
                | 'refunded'
                | 'disputed',
              purchasedAt: saleTimestamp,
            };
          })
        );

        const result = await convex.mutation(api.backgroundSync.ingestBackfillPurchaseFactsBatch, {
          apiSecret,
          tenantId,
          provider: 'gumroad',
          purchases,
        });

        totalInserted += result.inserted;
        totalSkipped += result.skipped;

        hasMore = !!data.next_page_url;
        page++;
        if (hasMore) {
          await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
        }
      }
    } else if (provider === 'jinxxy') {
      const connWithKey = await convex.query(api.providerConnections.getConnectionForBackfill, {
        apiSecret,
        tenantId,
        provider: 'jinxxy',
      });

      if (!connWithKey?.jinxxyApiKeyEncrypted) {
        return new Response(JSON.stringify({ error: 'Jinxxy API key not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const apiKey = await decrypt(connWithKey.jinxxyApiKeyEncrypted, encryptionSecret);

      const client = new JinxxyApiClient({ apiKey });
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const { orders, pagination } = await client.getOrders({
          product_id: providerProductRef,
          page,
          per_page: BATCH_SIZE,
        });

        const purchases = [];
        for (const order of orders) {
          if (order.product_id !== providerProductRef) continue;
          const isPaid = order.status === 'completed';
          const purchasedAt = order.created_at ? new Date(order.created_at).getTime() : Date.now();
          const email = order.email ?? '';
          const buyerEmailNormalized = email ? normalizeEmail(email) : undefined;
          const buyerEmailHash = buyerEmailNormalized
            ? await sha256Hex(buyerEmailNormalized)
            : undefined;

          purchases.push({
            tenantId,
            provider: 'jinxxy' as const,
            externalOrderId: order.id,
            buyerEmailNormalized,
            buyerEmailHash,
            providerProductId: order.product_id,
            paymentStatus: order.status?.toLowerCase() ?? 'completed',
            lifecycleStatus: (isPaid ? 'active' : 'refunded') as 'active' | 'refunded' | 'disputed',
            purchasedAt,
          });
        }

        if (purchases.length > 0) {
          const result = await convex.mutation(
            api.backgroundSync.ingestBackfillPurchaseFactsBatch,
            {
              apiSecret,
              tenantId,
              provider: 'jinxxy',
              purchases,
            }
          );
          totalInserted += result.inserted;
          totalSkipped += result.skipped;
        }

        hasMore = pagination?.has_next ?? false;
        page++;
        if (hasMore) {
          await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
        }
      }
    } else {
      return new Response(JSON.stringify({ error: `Unsupported provider: ${provider}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({ success: true, inserted: totalInserted, skipped: totalSkipped }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Backfill failed', {
      error: msg,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new Response(
      JSON.stringify({
        error: sanitizePublicErrorMessage(msg, 'Backfill failed. Try again in a moment.'),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
