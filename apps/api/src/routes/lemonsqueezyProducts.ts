/**
 * Lemon Squeezy Products API Route
 *
 * POST /api/lemonsqueezy/products
 * Fetches products from the Lemon Squeezy API for a tenant (for product add flow).
 * Uses the decrypted tenant API token; returns product id and name.
 */

import { LemonSqueezyApiClient } from '@yucp/providers/lemonsqueezy';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { decrypt } from '../lib/encrypt';
import { loadEnv } from '../lib/env';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

export interface LemonSqueezyProductsRequest {
  apiSecret: string;
  tenantId: string;
}

export interface LemonSqueezyProductItem {
  id: string;
  name: string;
}

export interface LemonSqueezyProductsResponse {
  products: LemonSqueezyProductItem[];
  error?: string;
}

export async function handleLemonSqueezyProducts(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await request.json()) as LemonSqueezyProductsRequest;
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
      provider: 'lemonsqueezy',
    });

    if (!conn?.lemonApiTokenEncrypted) {
      return new Response(
        JSON.stringify({
          products: [],
          error:
            'Lemon Squeezy not connected. Use /creator setup to connect your Lemon Squeezy account.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let apiToken: string;
    try {
      apiToken = await decrypt(conn.lemonApiTokenEncrypted, encryptionSecret);
    } catch (err) {
      logger.error('Failed to decrypt Lemon Squeezy API token', { tenantId, err });
      return new Response(
        JSON.stringify({
          products: [],
          error:
            'Failed to decrypt stored Lemon Squeezy API key. Re-add your key via /creator setup.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const client = new LemonSqueezyApiClient({ apiToken });

    const products: LemonSqueezyProductItem[] = [];
    let page = 1;
    while (true) {
      const { products: pageProducts, pagination } = await client.getProducts({
        page,
        perPage: 50,
      });

      for (const p of pageProducts) {
        if (p.id && p.name) {
          products.push({ id: p.id, name: p.name });
        }
      }

      if (!pagination.nextPage) break;
      page = pagination.nextPage;
    }

    return new Response(JSON.stringify({ products }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Lemon Squeezy products fetch failed', {
      error: msg,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new Response(
      JSON.stringify({
        products: [],
        error: sanitizePublicErrorMessage(msg, 'Could not load Lemon Squeezy products right now.'),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
