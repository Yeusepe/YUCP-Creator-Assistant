/**
 * Jinxxy provider plugin
 *
 * Products: fetches via JinxxyApiClient.getProducts (page-based), including collaborator stores
 * Backfill: fetches via JinxxyApiClient.getLicenses (page-based, filtered client-side by product_id)
 */

import { JinxxyApiClient } from '@yucp/providers/jinxxy';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import type {
  ProductRecord,
  ProviderContext,
  ProviderPlugin,
  ProviderPurposes,
} from '../types';
import { backfill } from './backfill';
import { connect } from './connect';
import { verification } from './verification';
import { webhook } from './webhook';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export const PURPOSES = {
  credential: 'jinxxy-api-key',
  webhookSecret: 'jinxxy-webhook-signing-secret',
} as const satisfies ProviderPurposes;

const HARD_PAGE_LIMIT = 100;

const jinxxyProvider: ProviderPlugin = {
  id: 'jinxxy',
  needsCredential: true,
  supportsCollab: true,
  purposes: PURPOSES,

  async getCredential(ctx: ProviderContext) {
    const conn = await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
      provider: 'jinxxy',
    });
    if (conn?.jinxxyApiKeyEncrypted) {
      return decrypt(conn.jinxxyApiKeyEncrypted, ctx.encryptionSecret, PURPOSES.credential);
    }

    // Legacy fallback: check tenant_provider_config table
    const legacyKey = await ctx.convex.query(api.creatorConfig.getJinxxyApiKeyForVerification, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
    });
    if (legacyKey) return decrypt(legacyKey, ctx.encryptionSecret, PURPOSES.credential);

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
        { apiSecret: ctx.apiSecret, ownerAuthUserId: ctx.authUserId },
      )) as Array<{ id: string; jinxxyApiKeyEncrypted?: string; collaboratorDisplayName?: string }>;

      for (const collab of collabConnections) {
        if (!collab.jinxxyApiKeyEncrypted) continue;
        try {
          const collabKey = await decrypt(
            collab.jinxxyApiKeyEncrypted,
            ctx.encryptionSecret,
            PURPOSES.credential,
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
  webhook,
  connect,
  verification,
};

export default jinxxyProvider;
