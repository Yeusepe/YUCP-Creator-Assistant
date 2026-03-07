/**
 * Jinxxy Products API Route
 *
 * POST /api/jinxxy/products
 * Fetches products from Jinxxy API for a tenant (for product add flow).
 * Uses decrypted tenant API key; returns product.id and product.name (jinx-master style).
 */

import { createLogger } from '@yucp/shared';
import { getConvexClientFromUrl } from '../lib/convex';
import { loadEnv } from '../lib/env';
import { decrypt } from '../lib/encrypt';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { JinxxyApiClient } from '@yucp/providers/jinxxy';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const HARD_PAGE_LIMIT = 100;

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

export interface JinxxyProductsRequest {
  apiSecret: string;
  tenantId: string;
}

export interface JinxxyProductItem {
  id: string;
  name: string;
  /** Display name of the collaborator store this product belongs to, or undefined for owner's own store */
  collaboratorName?: string;
}

export interface JinxxyProductsResponse {
  products: JinxxyProductItem[];
  error?: string;
}

export async function handleJinxxyProducts(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await request.json()) as JinxxyProductsRequest;
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
      return new Response(
        JSON.stringify({ error: 'BETTER_AUTH_SECRET not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const convex = getConvexClientFromUrl(convexUrl);

    // Try provider_connections first (connect flow), then tenant_provider_config (legacy)
    let apiKeyEncrypted: string | null = null;

    const conn = await convex.query('providerConnections:getConnectionForBackfill' as any, {
      apiSecret,
      tenantId,
      provider: 'jinxxy',
    });
    if (conn?.jinxxyApiKeyEncrypted) {
      apiKeyEncrypted = conn.jinxxyApiKeyEncrypted;
    }

    if (!apiKeyEncrypted) {
      const tenantKey = await convex.query('tenantConfig:getJinxxyApiKeyForVerification' as any, {
        apiSecret,
        tenantId,
      });
      if (tenantKey) apiKeyEncrypted = tenantKey;
    }

    if (!apiKeyEncrypted) {
      return new Response(
        JSON.stringify({
          products: [],
          error: 'Jinxxy API key not configured. Add your Jinxxy API key in /creator setup.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let apiKey: string;
    try {
      apiKey = await decrypt(apiKeyEncrypted, encryptionSecret);
    } catch (err) {
      logger.error('Failed to decrypt tenant Jinxxy API key', { tenantId, err });
      return new Response(
        JSON.stringify({
          products: [],
          error: 'Failed to decrypt stored Jinxxy API key. Re-add your key in /creator setup.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const client = new JinxxyApiClient({
      apiKey,
      apiBaseUrl: process.env.JINXXY_API_BASE_URL,
    });

    const products: JinxxyProductItem[] = [];
    let page = 1;

    while (page <= HARD_PAGE_LIMIT) {
      const { products: pageProducts, pagination } = await client.getProducts({
        page,
        per_page: 50,
      });

      for (const p of pageProducts) {
        if (p.id && p.name) {
          products.push({ id: p.id, name: p.name });
        }
      }

      if (!pagination?.has_next || pageProducts.length < 50) break;
      page++;
    }

    // Also fetch products from active collaborator connections
    try {
      const collabConnections = await convex.query('collaboratorInvites:getCollabConnectionsForVerification' as any, {
        apiSecret,
        ownerTenantId: tenantId,
      }) as Array<{ id: string; jinxxyApiKeyEncrypted?: string; collaboratorDisplayName?: string }>;

      for (const collab of collabConnections) {
        if (!collab.jinxxyApiKeyEncrypted) continue;
        try {
          const collabKey = await decrypt(collab.jinxxyApiKeyEncrypted, encryptionSecret);
          const collabClient = new JinxxyApiClient({
            apiKey: collabKey,
            apiBaseUrl: process.env.JINXXY_API_BASE_URL,
          });
          let collabPage = 1;
          while (collabPage <= HARD_PAGE_LIMIT) {
            const { products: pageProducts, pagination } = await collabClient.getProducts({
              page: collabPage,
              per_page: 50,
            });
            for (const p of pageProducts) {
              if (p.id && p.name) {
                products.push({
                  id: p.id,
                  name: p.name,
                  collaboratorName: collab.collaboratorDisplayName ?? 'Collaborator',
                });
              }
            }
            if (!pagination?.has_next || pageProducts.length < 50) break;
            collabPage++;
          }
        } catch (err) {
          logger.warn('Failed to fetch products for collaborator', {
            collabId: collab.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to fetch collaborator connections for product list', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Deduplicate by product ID — owner's own products take precedence
    const seen = new Set<string>();
    const deduped: JinxxyProductItem[] = [];
    for (const p of products) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        deduped.push(p);
      }
    }

    return new Response(
      JSON.stringify({ products: deduped }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Jinxxy products fetch failed', {
      error: msg,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new Response(
      JSON.stringify({
        products: [],
        error: sanitizePublicErrorMessage(msg, 'Could not load Jinxxy products right now.'),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
