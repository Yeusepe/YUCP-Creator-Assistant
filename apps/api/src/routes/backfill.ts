/**
 * Internal Backfill API Route
 *
 * POST /api/internal/backfill-product
 * Called by the Convex action backfillProductPurchases when BACKFILL_API_URL is set.
 * Resolves the provider plugin, decrypts credentials, then pages through purchase history
 * and ingests batches into purchase_facts.
 *
 * Adding a new provider: zero changes here. See apps/api/src/providers/index.ts.
 */

import { createLogger, timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { loadEnv } from '../lib/env';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { getProvider } from '../providers/index';
import type { BackfillRecord } from '../providers/types';

export type { BackfillRecord };

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const BATCH_SIZE = 100;

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
      logger.warn('Backfill: missing required fields', {
        hasApiSecret: !!apiSecret,
        hasAuthUserId: !!authUserId,
        hasProductId: !!productId,
        hasProvider: !!provider,
        hasProviderProductRef: !!providerProductRef,
      });
      return new Response(
        JSON.stringify({
          error:
            'Missing required fields: apiSecret, authUserId, productId, provider, providerProductRef',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const expectedSecret = process.env.CONVEX_API_SECRET;
    if (!expectedSecret) {
      logger.error('Backfill: CONVEX_API_SECRET not configured on API server');
      return new Response(JSON.stringify({ error: 'Server misconfiguration' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!timingSafeStringEqual(apiSecret, expectedSecret)) {
      logger.warn(
        'Backfill: apiSecret mismatch — check CONVEX_API_SECRET matches between Convex and API'
      );
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const plugin = getProvider(provider);
    if (!plugin?.backfill) {
      return new Response(
        JSON.stringify({ error: `Provider "${provider}" does not support backfill` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
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

    const creds = await plugin.getCredential(ctx);
    if (!creds) {
      return new Response(JSON.stringify({ error: `${provider} credentials not found for user` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Generic pagination loop — all provider-specific logic lives in plugin.backfill.fetchPage
    let cursor: string | null = null;
    let totalInserted = 0;
    let totalSkipped = 0;

    while (true) {
      const { facts, nextCursor } = await plugin.backfill.fetchPage(
        creds,
        providerProductRef,
        cursor,
        BATCH_SIZE
      );

      if (facts.length > 0) {
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
      await new Promise((r) => setTimeout(r, plugin.backfill!.pageDelayMs));
    }

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
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
