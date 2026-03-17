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
import type { ProductRecord, ProviderContext, ProviderPlugin, ProviderPurposes } from '../types';
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
      )) as Array<{
        id: string;
        provider: string;
        credentialEncrypted?: string;
        collaboratorDisplayName?: string;
      }>;

      for (const collab of collabConnections) {
        // Skip connections from other providers — their credentials are not Jinxxy API keys
        if (collab.provider !== 'jinxxy') continue;
        const encryptedKey = collab.credentialEncrypted;
        if (!encryptedKey) continue;
        try {
          const collabKey = await decrypt(encryptedKey, ctx.encryptionSecret, PURPOSES.credential);
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
  displayMeta: {
    label: 'Jinxxy™',
    icon: 'Jinxxy.png',
    color: '#9146FF',
    shadowColor: '#9146FF',
    textColor: '#ffffff',
    connectedColor: '#7b3be6',
    confettiColors: ['#9146FF', '#7b3be6', '#b980ff', '#ffffff'],
    description: 'Marketplace',
    dashboardConnectPath: '/jinxxy-setup',
    dashboardConnectParamStyle: 'snakeCase',
    dashboardIconBg: '#9146FF',
    dashboardQuickStartBg: 'rgba(145,70,255,0.1)',
    dashboardQuickStartBorder: 'rgba(145,70,255,0.3)',
    dashboardServerTileHint: 'Allow users to verify Jinxxy purchases in this Discord server.',
  },
  async collabValidate(credential: string): Promise<void> {
    const client = new JinxxyApiClient({
      apiKey: credential,
      apiBaseUrl: process.env.JINXXY_API_BASE_URL,
    });
    await client.getProducts({ per_page: 1 });
  },
  collabCredentialPurpose: PURPOSES.credential,
};

export default jinxxyProvider;
