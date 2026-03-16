/**
 * Lemon Squeezy provider plugin
 *
 * Products: fetches via LemonSqueezyApiClient.getProducts (page-based), including collaborator stores
 * Backfill: two-phase — subscriptions first, then order-items
 */

import { LemonSqueezyApiClient } from '@yucp/providers/lemonsqueezy';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import type { ProductRecord, ProviderContext, ProviderPlugin, ProviderPurposes } from '../types';
import { backfill } from './backfill';
import { connect } from './connect';
import { verification } from './verification';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export const PURPOSES = {
  credential: 'lemonsqueezy-api-token',
  webhookSecret: 'lemonsqueezy-webhook-secret',
} as const satisfies ProviderPurposes;

const lemonSqueezyProvider: ProviderPlugin = {
  id: 'lemonsqueezy',
  needsCredential: true,
  purposes: PURPOSES,

  async getCredential(ctx: ProviderContext) {
    const conn = await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
      provider: 'lemonsqueezy',
    });
    if (!conn?.lemonApiTokenEncrypted) return null;
    return decrypt(conn.lemonApiTokenEncrypted, ctx.encryptionSecret, PURPOSES.credential);
  },

  async fetchProducts(credential, ctx) {
    const products: ProductRecord[] = [];

    // Fetch from owner's own store
    if (credential) {
      const client = new LemonSqueezyApiClient({ apiToken: credential });
      let page = 1;

      while (true) {
        const { products: pageProducts, pagination } = await client.getProducts({
          page,
          perPage: 50,
        });
        for (const p of pageProducts) {
          if (p.id && p.name) products.push({ id: p.id, name: p.name });
        }
        if (!pagination.nextPage) break;
        page = pagination.nextPage;
      }
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
        // Skip connections from other providers — their credentials are not LS API tokens
        if (collab.provider !== 'lemonsqueezy') continue;
        if (!collab.credentialEncrypted) continue;
        try {
          const collabToken = await decrypt(
            collab.credentialEncrypted,
            ctx.encryptionSecret,
            PURPOSES.credential
          );
          const collabClient = new LemonSqueezyApiClient({ apiToken: collabToken });
          let collabPage = 1;
          while (true) {
            const { products: pageProducts, pagination } = await collabClient.getProducts({
              page: collabPage,
              perPage: 50,
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
            if (!pagination.nextPage) break;
            collabPage = pagination.nextPage;
          }
        } catch (err) {
          logger.warn('Failed to fetch products for LS collaborator', {
            collabId: collab.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to fetch collaborator connections for LS product list', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Deduplicate by product ID — owner's products take precedence (they appear first)
    const seen = new Set<string>();
    return products.filter((p) => {
      if (seen.has(p.id as string)) return false;
      seen.add(p.id as string);
      return true;
    });
  },

  backfill,
  connect,
  verification,
};

export default lemonSqueezyProvider;
