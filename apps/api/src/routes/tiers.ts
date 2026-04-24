/**
 * Provider Tiers Route
 *
 * POST /api/:provider/tiers
 * Generic handler for providers that expose an optional runtime `tiers` plugin.
 */

import { redactForLogging, timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { loadEnv } from '../lib/env';
import { logger } from '../lib/logger';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { getProviderRuntime } from '../providers/index';
import { CredentialExpiredError } from '../providers/types';

interface TiersRequest {
  apiSecret: string;
  authUserId: string;
  productId: string;
}

export async function handleProviderTiers(request: Request, provider: string): Promise<Response> {
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
  if (!runtime.tiers) {
    return new Response(JSON.stringify({ tiers: [], error: 'not_supported' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let convex: ReturnType<typeof getConvexClientFromUrl> | undefined;
  let authUserId: string | undefined;
  let apiSecret: string | undefined;
  let body: TiersRequest;

  try {
    body = (await request.json()) as TiersRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { productId } = body;
    ({ apiSecret, authUserId } = body);

    if (!apiSecret || !authUserId || !productId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: apiSecret, authUserId, productId' }),
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

    const env = loadEnv();
    if (!env.ENCRYPTION_SECRET) {
      return new Response(JSON.stringify({ error: 'ENCRYPTION_SECRET not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    convex = getConvexClientFromUrl(convexUrl);
    const ctx = { convex, apiSecret, authUserId, encryptionSecret: env.ENCRYPTION_SECRET };
    const credential = await runtime.getCredential(ctx);

    if (runtime.needsCredential && credential === null) {
      return new Response(
        JSON.stringify({
          tiers: [],
          error: `${provider} is not connected. Connect it in your creator setup.`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const tiers = await runtime.tiers.listProductTiers(credential, productId, ctx);
    return new Response(JSON.stringify({ tiers }), {
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
      return new Response(JSON.stringify({ tiers: [], error: 'session_expired' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const msg = err instanceof Error ? err.message : String(err);
    const fallbackError = `Could not load ${provider} tiers right now.`;
    const publicError = sanitizePublicErrorMessage(msg, fallbackError);
    logger.error('Provider tiers fetch failed', {
      provider,
      error: publicError === fallbackError ? fallbackError : redactForLogging(msg),
      stack:
        err instanceof Error && publicError !== fallbackError
          ? redactForLogging(err.stack)
          : undefined,
    });
    return new Response(JSON.stringify({ tiers: [], error: publicError }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
