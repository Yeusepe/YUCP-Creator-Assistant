/**
 * Internal Backfill API Route
 *
 * POST /api/internal/backfill-product
 * Called by Convex action backfillProductPurchases when BACKFILL_API_URL is set.
 * Fetches sales from Gumroad/Jinxxy/LemonSqueezy, decrypts tokens, ingests into purchase_facts.
 *
 * Architecture: Extensible adapter registry. Adding a new provider = implement one adapter
 * class + register in ADAPTERS. No changes needed to the main handler or pagination logic.
 */

import { JinxxyApiClient } from '@yucp/providers/jinxxy';
import { LemonSqueezyApiClient } from '@yucp/providers/lemonsqueezy';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { decrypt } from '../lib/encrypt';
import { loadEnv } from '../lib/env';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const BATCH_SIZE = 100;

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

// ============================================================================
// ADAPTER INTERFACE
// ============================================================================

export interface BackfillRecord {
  authUserId: string;
  provider: string;
  externalOrderId: string;
  externalLineItemId?: string;
  buyerEmailHash: string | undefined;
  providerUserId?: string;
  providerProductId: string;
  paymentStatus: string;
  lifecycleStatus: 'active' | 'refunded' | 'cancelled' | 'disputed';
  purchasedAt: number;
}

const MAX_RATE_LIMIT_RETRIES = 10;

interface BackfillProviderAdapter {
  /**
   * Fetch one page of purchase facts.
   * @param creds Provider credentials (decrypted)
   * @param productRef Provider-specific product identifier
   * @param cursor Opaque string representing pagination state; null = first page
   * @param pageSize Number of items per page
   * @returns Batch of records and next cursor (null = last page)
   */
  fetchPage(
    creds: string,
    productRef: string,
    cursor: string | null,
    pageSize: number
  ): Promise<{ facts: BackfillRecord[]; nextCursor: string | null }>;

  /** Retrieve the decrypted credential string for this provider */
  getCredential(
    convex: ReturnType<typeof getConvexClientFromUrl>,
    apiSecret: string,
    authUserId: string,
    encryptionSecret: string
  ): Promise<string | null>;

  /** Milliseconds to pause between pages to avoid rate limits */
  readonly pageDelayMs: number;
}

// ============================================================================
// GUMROAD ADAPTER
// ============================================================================

class GumroadBackfillAdapter implements BackfillProviderAdapter {
  readonly pageDelayMs = 1500;

  async getCredential(
    convex: ReturnType<typeof getConvexClientFromUrl>,
    apiSecret: string,
    authUserId: string,
    encryptionSecret: string
  ): Promise<string | null> {
    const conn = await convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret,
      authUserId,
      provider: 'gumroad',
    });
    if (!conn?.gumroadAccessTokenEncrypted) return null;
    return decrypt(conn.gumroadAccessTokenEncrypted, encryptionSecret);
  }

  async fetchPage(
    accessToken: string,
    productRef: string,
    cursor: string | null,
    pageSize: number
  ): Promise<{ facts: BackfillRecord[]; nextCursor: string | null }> {
    const page = cursor ? Number.parseInt(cursor, 10) : 1;
    let retries = 0;

    while (true) {
      const res = await fetch(
        `https://api.gumroad.com/v2/sales?product_id=${encodeURIComponent(productRef)}&page=${page}&per_page=${pageSize}`,
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
            authUserId: '', // injected by runBackfill
            provider: 'gumroad',
            externalOrderId: String(s.sale_id ?? s.id ?? ''),
            buyerEmailHash: normalized ? await sha256Hex(normalized) : undefined,
            providerProductId: String(s.product_id ?? ''),
            paymentStatus: s.refunded === true || s.refunded === 'true' ? 'refunded' : 'paid',
            lifecycleStatus:
              s.refunded === true || s.refunded === 'true'
                ? ('refunded' as const)
                : ('active' as const),
            purchasedAt: s.created_at
              ? new Date(s.created_at as string).getTime()
              : typeof s.sale_timestamp === 'number'
                ? (s.sale_timestamp as number) * 1000
                : Date.now(),
          };
        })
      );

      return {
        facts,
        nextCursor: data.next_page_url ? String(page + 1) : null,
      };
    }
  }
}

// ============================================================================
// JINXXY ADAPTER
// ============================================================================

class JinxxyBackfillAdapter implements BackfillProviderAdapter {
  readonly pageDelayMs = 600;

  async getCredential(
    convex: ReturnType<typeof getConvexClientFromUrl>,
    apiSecret: string,
    authUserId: string,
    encryptionSecret: string
  ): Promise<string | null> {
    const conn = await convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret,
      authUserId,
      provider: 'jinxxy',
    });
    if (!conn?.jinxxyApiKeyEncrypted) return null;
    return decrypt(conn.jinxxyApiKeyEncrypted, encryptionSecret);
  }

  async fetchPage(
    apiKey: string,
    productRef: string,
    cursor: string | null,
    pageSize: number
  ): Promise<{ facts: BackfillRecord[]; nextCursor: string | null }> {
    const page = cursor ? Number.parseInt(cursor, 10) : 1;
    const client = new JinxxyApiClient({ apiKey });
    let retries = 0;

    while (true) {
      try {
        // Jinxxy /licenses does not support product_id or customer_id filtering.
        // Fetch all licenses (paginated) and filter client-side by product_id.
        const { licenses, pagination } = await client.getLicenses({
          page,
          per_page: pageSize,
        });

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
          purchasedAt: Date.now(),
        }));

        return {
          facts,
          nextCursor: pagination?.has_next ? String(page + 1) : null,
        };
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
  }
}

// ============================================================================
// LEMONSQUEEZY ADAPTER (two-phase: subscriptions → order-items)
// ============================================================================

type LSCursor = { phase: 'subscriptions' | 'orders'; page: number };

class LemonSqueezyBackfillAdapter implements BackfillProviderAdapter {
  readonly pageDelayMs = 250;

  async getCredential(
    convex: ReturnType<typeof getConvexClientFromUrl>,
    apiSecret: string,
    authUserId: string,
    encryptionSecret: string
  ): Promise<string | null> {
    const conn = await convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret,
      authUserId,
      provider: 'lemonsqueezy',
    });
    if (!conn?.lemonApiTokenEncrypted) return null;
    return decrypt(conn.lemonApiTokenEncrypted, encryptionSecret);
  }

  async fetchPage(
    apiKey: string,
    productRef: string,
    cursor: string | null,
    pageSize: number
  ): Promise<{ facts: BackfillRecord[]; nextCursor: string | null }> {
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
              const isCancelled = sub.status === 'cancelled' || sub.status === 'expired';
              return {
                authUserId: '',
                provider: 'lemonsqueezy',
                externalOrderId: sub.orderId ?? sub.id,
                buyerEmailHash: normalized ? await sha256Hex(normalized) : undefined,
                providerProductId: productRef,
                paymentStatus: 'paid',
                lifecycleStatus: (isCancelled ? 'cancelled' : 'active') as
                  | 'active'
                  | 'cancelled'
                  | 'refunded'
                  | 'disputed',
                purchasedAt: sub.createdAt ? new Date(sub.createdAt).getTime() : Date.now(),
              };
            })
          );

          // Determine next cursor
          let nextCursor: string | null = null;
          if (pagination.nextPage) {
            nextCursor = JSON.stringify({ phase: 'subscriptions', page: pagination.nextPage });
          } else {
            // Transition to orders phase
            nextCursor = JSON.stringify({ phase: 'orders', page: 1 });
          }

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
      // orders phase: paginate /order-items → fetch each order for email
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
            // Fetch the order to get the user email
            await new Promise((r) => setTimeout(r, 250));
            let order = null;
            try {
              order = await client.getOrder(item.orderId);
            } catch (err) {
              logger.warn('LemonSqueezy getOrder failed, skipping order item', {
                orderId: item.orderId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            if (!order) continue;
            const email = order.userEmail ?? '';
            const normalized = email ? normalizeEmail(email) : undefined;
            facts.push({
              authUserId: '',
              provider: 'lemonsqueezy',
              externalOrderId: item.orderId,
              externalLineItemId: item.id,
              buyerEmailHash: normalized ? await sha256Hex(normalized) : undefined,
              providerProductId: productRef,
              paymentStatus: order.refunded ? 'refunded' : 'paid',
              lifecycleStatus: (order.refunded ? 'refunded' : 'active') as
                | 'active'
                | 'refunded'
                | 'disputed',
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
  }
}

// ============================================================================
// ADAPTER REGISTRY, add new providers here
// ============================================================================

const ADAPTERS: Record<string, BackfillProviderAdapter> = {
  gumroad: new GumroadBackfillAdapter(),
  jinxxy: new JinxxyBackfillAdapter(),
  lemonsqueezy: new LemonSqueezyBackfillAdapter(),
};

// ============================================================================
// SHARED PAGINATION RUNNER
// ============================================================================

async function runBackfill(
  adapter: BackfillProviderAdapter,
  convex: ReturnType<typeof getConvexClientFromUrl>,
  apiSecret: string,
  authUserId: string,
  provider: string,
  productId: string,
  providerProductRef: string,
  creds: string,
  pageSize: number
): Promise<{ totalInserted: number; totalSkipped: number }> {
  let cursor: string | null = null;
  let totalInserted = 0;
  let totalSkipped = 0;

  while (true) {
    const { facts, nextCursor } = await adapter.fetchPage(
      creds,
      providerProductRef,
      cursor,
      pageSize
    );

    if (facts.length > 0) {
      // Inject authUserId (adapters set it to '' to avoid coupling)
      const withUser = facts.map((f) => ({ ...f, authUserId }));

      const result = await convex.mutation(api.backgroundSync.ingestBackfillPurchaseFactsBatch, {
        apiSecret,
        authUserId,
        provider,
        purchases: withUser,
      });
      totalInserted += result.inserted;
      totalSkipped += result.skipped;
    }

    if (!nextCursor) break;
    cursor = nextCursor;
    await new Promise((r) => setTimeout(r, adapter.pageDelayMs));
  }

  return { totalInserted, totalSkipped };
}

// ============================================================================
// PUBLIC TYPES & HANDLER
// ============================================================================

export type BackfillProvider = keyof typeof ADAPTERS;

export interface BackfillRequest {
  apiSecret: string;
  authUserId: string;
  productId: string;
  provider: string;
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
    const { apiSecret, authUserId, productId, provider, providerProductRef } = body;

    if (!apiSecret || !authUserId || !productId || !provider || !providerProductRef) {
      return new Response(
        JSON.stringify({
          error:
            'Missing required fields: apiSecret, authUserId, productId, provider, providerProductRef',
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

    const adapter = ADAPTERS[provider];
    if (!adapter) {
      return new Response(JSON.stringify({ error: `Unsupported provider: ${provider}` }), {
        status: 400,
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

    const creds = await adapter.getCredential(convex, apiSecret, authUserId, encryptionSecret);
    if (!creds) {
      return new Response(
        JSON.stringify({ error: `${provider} credentials not found for tenant` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { totalInserted, totalSkipped } = await runBackfill(
      adapter,
      convex,
      apiSecret,
      authUserId,
      provider,
      productId,
      providerProductRef,
      creds,
      BATCH_SIZE
    );

    logger.info('Backfill complete', {
      provider,
      authUserId,
      providerProductRef,
      totalInserted,
      totalSkipped,
    });

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
