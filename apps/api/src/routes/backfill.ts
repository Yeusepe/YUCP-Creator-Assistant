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

import {
  BackfillCredentialsNotFoundError,
  BackfillProviderNotSupportedError,
  BackfillService,
} from '@yucp/application/services';
import { timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { loadEnv } from '../lib/env';
import { logger } from '../lib/logger';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { getProviderRuntime } from '../providers/index';
import type { BackfillRecord } from '../providers/types';

export type { BackfillRecord };

const BATCH_SIZE = 100;

export interface BackfillRequest {
  apiSecret: string;
  authUserId: string;
  productId: string;
  provider: string;
  providerProductRef: string;
}

export interface BackfillRouteDependencies {
  getExpectedSecret(): string | undefined;
  getConvexUrl(): string;
  getEncryptionSecret(): string | undefined;
  createConvexClient(convexUrl: string): ReturnType<typeof getConvexClientFromUrl>;
  getProviderById: typeof getProviderRuntime;
  ingestBackfillBatch(
    convex: ReturnType<typeof getConvexClientFromUrl>,
    input: {
      apiSecret: string;
      authUserId: string;
      provider: string;
      purchases: BackfillRecord[];
    }
  ): Promise<{ inserted: number; skipped: number }>;
  sleep(waitMs: number): Promise<void>;
}

function parseBackfillRequest(value: unknown): BackfillRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'Missing required fields: apiSecret, authUserId, productId, provider, providerProductRef'
    );
  }

  const record = value as Record<string, unknown>;
  const apiSecret = typeof record.apiSecret === 'string' ? record.apiSecret : '';
  const authUserId = typeof record.authUserId === 'string' ? record.authUserId : '';
  const productId = typeof record.productId === 'string' ? record.productId : '';
  const provider = typeof record.provider === 'string' ? record.provider : '';
  const providerProductRef =
    typeof record.providerProductRef === 'string' ? record.providerProductRef : '';

  if (!apiSecret || !authUserId || !productId || !provider || !providerProductRef) {
    throw new Error(
      'Missing required fields: apiSecret, authUserId, productId, provider, providerProductRef'
    );
  }

  return {
    apiSecret,
    authUserId,
    productId,
    provider,
    providerProductRef,
  };
}

const defaultDependencies: BackfillRouteDependencies = {
  getExpectedSecret: () => process.env.CONVEX_API_SECRET,
  getConvexUrl: () => process.env.CONVEX_URL ?? process.env.CONVEX_DEPLOYMENT ?? '',
  getEncryptionSecret: () => loadEnv().ENCRYPTION_SECRET,
  createConvexClient: getConvexClientFromUrl,
  getProviderById: getProviderRuntime,
  ingestBackfillBatch: (convex, input) =>
    convex.mutation(api.backgroundSync.ingestBackfillPurchaseFactsBatch, input),
  sleep: (waitMs) => new Promise((resolve) => setTimeout(resolve, waitMs)),
};

export function createBackfillProductHandler(
  dependencies: BackfillRouteDependencies = defaultDependencies
) {
  return async function handleBackfillProduct(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      let parsedBody: unknown;
      try {
        parsedBody = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const body = parseBackfillRequest(parsedBody);
      const { apiSecret, authUserId, provider, providerProductRef } = body;

      const expectedSecret = dependencies.getExpectedSecret();
      if (!expectedSecret) {
        logger.error('Backfill: CONVEX_API_SECRET not configured on API server');
        return new Response(JSON.stringify({ error: 'Server misconfiguration' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (!timingSafeStringEqual(apiSecret, expectedSecret)) {
        logger.warn(
          'Backfill: apiSecret mismatch, check CONVEX_API_SECRET matches between Convex and API'
        );
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const convexUrl = dependencies.getConvexUrl();
      if (!convexUrl) {
        return new Response(JSON.stringify({ error: 'CONVEX_URL not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const encryptionSecret = dependencies.getEncryptionSecret();
      if (!encryptionSecret) {
        return new Response(JSON.stringify({ error: 'ENCRYPTION_SECRET not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const convex = dependencies.createConvexClient(convexUrl);
      const backfillService = new BackfillService({
        providers: {
          getProvider: (providerKey) => {
            const runtime = dependencies.getProviderById(providerKey);
            if (!runtime?.backfill) {
              return undefined;
            }
            const backfill = runtime.backfill;

            return {
              pageDelayMs: backfill.pageDelayMs,
              getCredential: async () =>
                runtime.getCredential({
                  convex,
                  apiSecret,
                  authUserId,
                  encryptionSecret,
                }),
              fetchPage: (credential, productRef, cursor, pageSize) =>
                backfill.fetchPage(credential, productRef, cursor, pageSize, encryptionSecret),
            };
          },
        },
        ingestion: {
          ingestBatch: async ({ authUserId: ownerId, provider: providerKey, purchases }) =>
            dependencies.ingestBackfillBatch(convex, {
              apiSecret,
              authUserId: ownerId,
              provider: providerKey,
              purchases,
            }),
        },
        delay: {
          sleep: dependencies.sleep,
        },
      });

      const result = await backfillService.backfillProduct({
        authUserId,
        provider,
        providerProductRef,
        pageSize: BATCH_SIZE,
      });

      logger.info('Backfill complete', {
        provider,
        authUserId,
        providerProductRef,
        totalInserted: result.inserted,
        totalSkipped: result.skipped,
      });

      return new Response(
        JSON.stringify({ success: true, inserted: result.inserted, skipped: result.skipped }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      if (
        err instanceof Error &&
        err.message ===
          'Missing required fields: apiSecret, authUserId, productId, provider, providerProductRef'
      ) {
        logger.warn('Backfill: missing required fields');
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (err instanceof BackfillProviderNotSupportedError) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (err instanceof BackfillCredentialsNotFoundError) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Backfill failed', {
        error: msg,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return new Response(
        JSON.stringify({
          error: sanitizePublicErrorMessage(null, 'Backfill failed. Try again in a moment.'),
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  };
}

export const handleBackfillProduct = createBackfillProductHandler();
