/**
 * Jinxxy provider plugin
 *
 * Products: fetches via JinxxyApiClient.getProducts (page-based), including collaborator stores
 * Backfill: fetches via JinxxyApiClient.getLicenses (page-based, filtered client-side by product_id)
 */

import { JinxxyApiClient } from '@yucp/providers/jinxxy';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { decrypt } from '../lib/encrypt';
import type {
  BackfillPlugin,
  BackfillRecord,
  ProductRecord,
  ProviderContext,
  ProviderPlugin,
  ProviderPurposes,
} from './types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export const PURPOSES = {
  credential: 'jinxxy-api-key',
  webhookSecret: 'jinxxy-webhook-signing-secret',
} as const satisfies ProviderPurposes;

const MAX_RATE_LIMIT_RETRIES = 10;
const HARD_PAGE_LIMIT = 100;

const backfill: BackfillPlugin = {
  pageDelayMs: 600,

  async fetchPage(apiKey, productRef, cursor, pageSize) {
    const page = cursor ? Number.parseInt(cursor, 10) : 1;
    const client = new JinxxyApiClient({ apiKey });
    let retries = 0;

    while (true) {
      try {
        // Jinxxy /licenses does not support product_id filtering — filter client-side
        const { licenses, pagination } = await client.getLicenses({ page, per_page: pageSize });

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

        return { facts, nextCursor: pagination?.has_next ? String(page + 1) : null };
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
  },
};

const jinxxyProvider: ProviderPlugin = {
  id: 'jinxxy',
  needsCredential: true,
  purposes: PURPOSES,

  async getCredential(ctx: ProviderContext) {
    const data = await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
      provider: 'jinxxy',
    });
    const encryptedKey = data?.credentials.api_key;
    if (encryptedKey) {
      return decrypt(encryptedKey, ctx.encryptionSecret, PURPOSES.credential);
    }
    return null;
  },

  async fetchProducts(credential, ctx) {
    if (!credential) return [];

    const products: ProductRecord[] = [];

    // Fetch from owner's own store
    const client = new JinxxyApiClient({
      apiKey: credential,
      apiBaseUrl: process.env.JINXXY_API_BASE_URL,
    });
    let page = 1;
    while (page <= HARD_PAGE_LIMIT) {
      const { products: pageProducts, pagination } = await client.getProducts({
        page,
        per_page: 50,
      });
      for (const p of pageProducts) {
        if (p.id && p.name) products.push({ id: p.id, name: p.name });
      }
      if (!pagination?.has_next || pageProducts.length < 50) break;
      page++;
    }

    // Fetch from collaborator stores
    try {
      const collabConnections = (await ctx.convex.query(
        api.collaboratorInvites.getCollabConnectionsForVerification,
        { apiSecret: ctx.apiSecret, ownerAuthUserId: ctx.authUserId }
      )) as Array<{ id: string; credentialEncrypted?: string; collaboratorDisplayName?: string }>;

      for (const collab of collabConnections) {
        if (!collab.credentialEncrypted) continue;
        try {
          const collabKey = await decrypt(
            collab.credentialEncrypted,
            ctx.encryptionSecret,
            PURPOSES.credential
          );
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

    // Deduplicate by product ID — owner's products take precedence (they appear first)
    const seen = new Set<string>();
    return products.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  },

  backfill,
};

export default jinxxyProvider;
