/**
 * Gumroad Products API Route
 *
 * POST /api/gumroad/products
 * Fetches products from Gumroad API for a tenant (for autosetup and product add flow).
 * Uses decrypted Gumroad OAuth token; returns product.id and product.name.
 */

import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { decrypt } from '../lib/encrypt';
import { loadEnv } from '../lib/env';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const GUMROAD_API_BASE = 'https://api.gumroad.com/v2';
const HARD_PAGE_LIMIT = 100;

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

export interface GumroadProductsRequest {
  apiSecret: string;
  tenantId: string;
}

export interface GumroadProductItem {
  id: string;
  name: string;
}

export interface GumroadProductsResponse {
  products: GumroadProductItem[];
  error?: string;
}

interface GumroadApiProduct {
  id: string;
  name: string;
}

interface GumroadProductsApiResponse {
  success: boolean;
  products?: GumroadApiProduct[];
  next_page_url?: string;
  message?: string;
}

export async function handleGumroadProducts(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await request.json()) as GumroadProductsRequest;
    const { apiSecret, tenantId } = body;

    if (!apiSecret || !tenantId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: apiSecret, tenantId' }),
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

    const encryptionSecret = loadEnv().BETTER_AUTH_SECRET;
    if (!encryptionSecret) {
      return new Response(JSON.stringify({ error: 'BETTER_AUTH_SECRET not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const convex = getConvexClientFromUrl(convexUrl);

    const conn = await convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret,
      tenantId,
      provider: 'gumroad',
    });

    if (!conn?.gumroadAccessTokenEncrypted) {
      return new Response(
        JSON.stringify({
          products: [],
          error: 'Gumroad not connected. Link your Gumroad account in /creator setup.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let accessToken: string;
    try {
      accessToken = await decrypt(conn.gumroadAccessTokenEncrypted, encryptionSecret);
    } catch (err) {
      logger.error('Failed to decrypt Gumroad access token', { tenantId, err });
      return new Response(
        JSON.stringify({
          products: [],
          error: 'Failed to decrypt stored Gumroad token. Reconnect Gumroad in /creator setup.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const products: GumroadProductItem[] = [];
    let nextPageUrl: string | undefined = `${GUMROAD_API_BASE}/products`;

    while (nextPageUrl && products.length < HARD_PAGE_LIMIT * 10) {
      const separator = nextPageUrl.includes('?') ? '&' : '?';
      const url = `${nextPageUrl}${separator}access_token=${encodeURIComponent(accessToken)}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
        logger.warn('Gumroad rate limit, waiting', { waitMs });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gumroad API error: ${response.status} ${text}`);
      }

      const data = (await response.json()) as GumroadProductsApiResponse;

      if (!data.success) {
        throw new Error(data.message ?? 'Gumroad API returned an error');
      }

      const pageProducts = data.products ?? [];
      for (const p of pageProducts) {
        if (p.id && p.name) {
          products.push({ id: p.id, name: p.name });
        }
      }

      nextPageUrl = data.next_page_url;
      if (!nextPageUrl || pageProducts.length === 0) break;
    }

    return new Response(JSON.stringify({ products }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Gumroad products fetch failed', {
      error: msg,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new Response(
      JSON.stringify({
        products: [],
        error: sanitizePublicErrorMessage(msg, 'Could not load Gumroad products right now.'),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
