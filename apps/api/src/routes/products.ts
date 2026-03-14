/**
 * Provider Products Route
 *
 * POST /api/:provider/products
 * Generic handler for all providers. Resolves provider plugin from the registry,
 * fetches the credential, and lists products.
 *
 * Adding a new provider: zero changes here. See apps/api/src/providers/index.ts.
 */

import { createLogger, timingSafeStringEqual } from '@yucp/shared';
import { getConvexClientFromUrl } from '../lib/convex';
import { loadEnv } from '../lib/env';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { getProvider } from '../providers/index';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

interface ProductsRequest {
  apiSecret: string;
  authUserId: string;
}

export async function handleProviderProducts(
  request: Request,
  provider: string
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const plugin = getProvider(provider);
  if (!plugin) {
    return new Response(JSON.stringify({ error: `Unknown provider: ${provider}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await request.json()) as ProductsRequest;
    const { apiSecret, authUserId } = body;

    if (!apiSecret || !authUserId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: apiSecret, authUserId' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const expectedSecret = process.env.CONVEX_API_SECRET;
    if (!expectedSecret || !timingSafeStringEqual(apiSecret, expectedSecret)) {
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

    const _env = loadEnv();
    const encryptionSecret = _env.ENCRYPTION_SECRET ?? _env.BETTER_AUTH_SECRET;
    if (!encryptionSecret) {
      return new Response(
        JSON.stringify({ error: 'ENCRYPTION_SECRET or BETTER_AUTH_SECRET not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const convex = getConvexClientFromUrl(convexUrl);
    const ctx = { convex, apiSecret, authUserId, encryptionSecret };

    const credential = await plugin.getCredential(ctx);

    if (plugin.needsCredential && credential === null) {
      return new Response(
        JSON.stringify({
          products: [],
          error: `${provider} is not connected. Connect it in your creator setup.`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const products = await plugin.fetchProducts(credential, ctx);

    return new Response(JSON.stringify({ products }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Provider products fetch failed', {
      provider,
      error: msg,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new Response(
      JSON.stringify({
        products: [],
        error: sanitizePublicErrorMessage(msg, `Could not load ${provider} products right now.`),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
