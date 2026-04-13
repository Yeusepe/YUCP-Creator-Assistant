/**
 * Provider Products Route
 *
 * POST /api/:provider/products
 * Generic handler for all providers. Resolves provider plugin from the registry,
 * fetches the credential, and lists products.
 *
 * Adding a new provider: zero changes here. See apps/api/src/providers/index.ts.
 */

import { timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { loadEnv } from '../lib/env';
import { logger } from '../lib/logger';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { getProviderRuntime } from '../providers/index';
import { CredentialExpiredError } from '../providers/types';

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

  const runtime = getProviderRuntime(provider);
  if (!runtime) {
    return new Response(JSON.stringify({ error: `Unknown provider: ${provider}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let convex: ReturnType<typeof getConvexClientFromUrl> | undefined;
  let authUserId: string | undefined;
  let apiSecret: string | undefined;

  try {
    const body = (await request.json()) as ProductsRequest;
    ({ apiSecret, authUserId } = body);

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
    const encryptionSecret = _env.ENCRYPTION_SECRET;
    if (!encryptionSecret) {
      return new Response(JSON.stringify({ error: 'ENCRYPTION_SECRET not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    convex = getConvexClientFromUrl(convexUrl);
    const ctx = { convex, apiSecret, authUserId, encryptionSecret };

    const credential = await runtime.getCredential(ctx);

    if (runtime.needsCredential && credential === null) {
      return new Response(
        JSON.stringify({
          products: [],
          error: `${provider} is not connected. Connect it in your creator setup.`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const products = await runtime.fetchProducts(credential, ctx);

    return new Response(JSON.stringify({ products }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof CredentialExpiredError) {
      logger.warn('Provider credential expired, marking connection degraded', {
        provider,
        authUserId,
      });
      if (convex && apiSecret && authUserId) {
        try {
          await convex.mutation(api.providerConnections.markConnectionDegraded, {
            apiSecret,
            authUserId,
            provider: provider as string,
          });
        } catch (mutErr) {
          logger.warn('Failed to mark connection degraded', {
            provider,
            error: mutErr instanceof Error ? mutErr.message : String(mutErr),
          });
        }
      }
      return new Response(JSON.stringify({ products: [], error: 'session_expired' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

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
