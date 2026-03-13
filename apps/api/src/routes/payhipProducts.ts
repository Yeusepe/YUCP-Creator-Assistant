/**
 * Payhip Products API Route
 *
 * POST /api/payhip/products
 * Returns the list of Payhip products known for a creator.
 *
 * Products are discovered from two sources:
 * 1. Manually added product-secret-keys (via POST /api/connect/payhip/product-key),
 *    available immediately at setup time, before any webhooks fire.
 * 2. provider_catalog_mappings entries upserted from past webhook events,
 *    include the human-readable product name from the webhook payload.
 *
 * The `permalink` (product_key, e.g., "RGsF") is the canonical product identifier
 * because it matches the `product_link` returned by the Payhip license-key verify API.
 * The full product URL is always constructible as `https://payhip.com/b/{permalink}`.
 */

import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
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

export interface PayhipProductsRequest {
  apiSecret: string;
  authUserId: string;
}

export interface PayhipProductItem {
  /** Product permalink / product_key (e.g., "RGsF"), canonical Payhip product identifier */
  id: string;
  /** Human-readable product name (populated once a purchase webhook has been received) */
  name?: string;
  /** Full Payhip product URL (e.g., "https://payhip.com/b/RGsF") */
  productUrl: string;
  /** Whether a per-product secret key has been configured (required for license verification) */
  hasSecretKey: boolean;
}

export interface PayhipProductsResponse {
  products: PayhipProductItem[];
  error?: string;
}

export async function handlePayhipProducts(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await request.json()) as PayhipProductsRequest;
    const { apiSecret, authUserId } = body;

    if (!apiSecret || !authUserId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: apiSecret, authUserId' }),
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
    const entries = await convex.query(api.providerConnections.getPayhipProducts, {
      apiSecret,
      authUserId,
    });

    const products: PayhipProductItem[] = entries.map(
      (e: {
        permalink: string;
        displayName?: string;
        productPermalink?: string;
        hasSecretKey: boolean;
      }) => ({
        id: e.permalink,
        name: e.displayName,
        productUrl: e.productPermalink ?? `https://payhip.com/b/${e.permalink}`,
        hasSecretKey: e.hasSecretKey,
      })
    );

    return new Response(JSON.stringify({ products }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Payhip products fetch failed', {
      error: msg,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new Response(
      JSON.stringify({
        products: [],
        error: sanitizePublicErrorMessage(msg, 'Could not load Payhip products right now.'),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
