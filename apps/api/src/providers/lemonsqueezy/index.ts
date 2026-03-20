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
import type {
  DisconnectContext,
  ProductRecord,
  ProviderContext,
  ProviderPlugin,
  ProviderPurposes,
} from '../types';
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
  programmaticWebhooks: true,
  needsCredential: true,
  supportsCollab: true,
  purposes: PURPOSES,

  async getCredential(ctx: ProviderContext) {
    const data = await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
      provider: 'lemonsqueezy',
    });
    const encryptedToken = data?.credentials.api_token;
    if (!encryptedToken) return null;
    return decrypt(encryptedToken, ctx.encryptionSecret, PURPOSES.credential);
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
  displayMeta: {
    label: 'Lemon Squeezy',
    icon: 'LemonSqueezy.png',
    color: '#ffd35a',
    shadowColor: '#ffd35a',
    textColor: '#000000',
    connectedColor: '#e6b600',
    confettiColors: ['#ffd35a', '#e6b600', '#fff0a0', '#ffffff'],
    description: 'Marketplace',
    dashboardConnectPath: '/setup/lemonsqueezy',
    dashboardConnectParamStyle: 'snakeCase',
    dashboardIconBg: '#f7b84b',
    dashboardQuickStartBg: 'rgba(247,184,75,0.12)',
    dashboardQuickStartBorder: 'rgba(247,184,75,0.32)',
    dashboardServerTileHint:
      'Allow users to verify Lemon Squeezy purchases and licenses in this Discord server.',
  },
  async collabValidate(credential: string): Promise<void> {
    const client = new LemonSqueezyApiClient({ apiToken: credential });
    const result = await client.getStores(1, 1);
    if (!result.stores[0]) throw new Error('No Lemon Squeezy stores found for this API key');
  },
  collabCredentialPurpose: PURPOSES.credential,

  async onDisconnect(ctx: DisconnectContext) {
    const encryptedToken = ctx.credentials.api_token;
    if (!encryptedToken) {
      logger.info('LemonSqueezy onDisconnect: no api_token, skipping webhook cleanup');
      return;
    }

    if (!ctx.remoteWebhookId) {
      logger.info('LemonSqueezy onDisconnect: no remoteWebhookId, skipping webhook cleanup');
      return;
    }

    const apiToken = await decrypt(encryptedToken, ctx.encryptionSecret, PURPOSES.credential);
    const client = new LemonSqueezyApiClient({ apiToken });

    // DELETE /v1/webhooks/{webhookId}
    // See https://docs.lemonsqueezy.com/api/webhooks#delete-a-webhook
    await client.deleteWebhook(ctx.remoteWebhookId);
    logger.info('LemonSqueezy onDisconnect: deleted webhook', {
      webhookId: ctx.remoteWebhookId,
    });
  },
};

export default lemonSqueezyProvider;
