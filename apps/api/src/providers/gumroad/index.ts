/**
 * Gumroad provider plugin
 *
 * Products: fetches via GET /v2/products (paginated with next_page_url)
 * Backfill: fetches via GET /v2/sales?product_id=X (page-based cursor)
 */

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
import { webhook } from './webhook';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export const PURPOSES = {
  credential: 'gumroad-oauth-access-token',
  refreshToken: 'gumroad-oauth-refresh-token',
} as const satisfies ProviderPurposes;

const GUMROAD_API_BASE = 'https://api.gumroad.com/v2';

const gumroadProvider: ProviderPlugin = {
  id: 'gumroad',
  programmaticWebhooks: true,
  needsCredential: true,
  purposes: PURPOSES,
  displayMeta: {
    label: 'Gumroad',
    icon: 'Gumorad.png',
    color: '#ff90e8',
    shadowColor: '#ff90e8',
    textColor: '#000000',
    connectedColor: '#e269c9',
    confettiColors: ['#ff90e8', '#e269c9', '#ff70d0', '#ffffff'],
    description: 'Marketplace',
    dashboardConnectPath: '/api/connect/gumroad/begin',
    dashboardConnectParamStyle: 'camelCase',
    dashboardIconBg: '#0f0f12',
    dashboardQuickStartBg: 'rgba(255,255,255,0.05)',
    dashboardQuickStartBorder: 'rgba(255,255,255,0.1)',
    dashboardServerTileHint: 'Allow users to verify Gumroad purchases in this Discord server.',
  },

  async getCredential(ctx: ProviderContext) {
    const data = await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
      provider: 'gumroad',
    });
    const encryptedToken = data?.credentials.oauth_access_token;
    if (!encryptedToken) return null;
    return decrypt(encryptedToken, ctx.encryptionSecret, PURPOSES.credential);
  },

  async fetchProducts(credential) {
    if (!credential) return [];

    const products: ProductRecord[] = [];
    let nextPageUrl: string | undefined = `${GUMROAD_API_BASE}/products`;
    let rateLimitRetries = 0;

    while (nextPageUrl && products.length < 5000) {
      // Strip any access_token query param that Gumroad includes in next_page_url —
      // credentials travel in the Authorization header, not the URL.
      const parsedUrl = new URL(nextPageUrl);
      parsedUrl.searchParams.delete('access_token');

      const response = await fetch(parsedUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credential}`,
        },
      });

      if (response.status === 429) {
        rateLimitRetries++;
        if (rateLimitRetries > 10) {
          throw new Error('Gumroad API: rate limit exceeded after 10 consecutive retries');
        }
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
        logger.warn('Gumroad rate limit fetching products', { waitMs, rateLimitRetries });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      rateLimitRetries = 0;

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gumroad API error: ${response.status} ${text}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        products?: Array<{ id: string; name: string }>;
        next_page_url?: string;
        message?: string;
      };

      if (!data.success) throw new Error(data.message ?? 'Gumroad API returned an error');

      for (const p of data.products ?? []) {
        if (p.id && p.name) products.push({ id: p.id, name: p.name });
      }

      nextPageUrl = data.next_page_url;
      if (!nextPageUrl || (data.products ?? []).length === 0) break;
    }

    return products;
  },

  backfill,
  webhook,
  connect,
  verification,

  async onDisconnect(ctx: DisconnectContext) {
    const encryptedToken = ctx.credentials.oauth_access_token;
    if (!encryptedToken) {
      logger.info('Gumroad onDisconnect: no access token, skipping webhook cleanup');
      return;
    }

    const accessToken = await decrypt(encryptedToken, ctx.encryptionSecret, PURPOSES.credential);
    const webhookBase = `${ctx.apiBaseUrl.replace(/\/$/, '')}/webhooks/gumroad/`;

    // List all resource subscriptions and delete ones pointing at our webhook base URL.
    // See https://gumroad.com/api — GET/DELETE /v2/resource_subscriptions
    const listRes = await fetch('https://api.gumroad.com/v2/resource_subscriptions', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) {
      logger.warn('Gumroad onDisconnect: failed to list resource_subscriptions', {
        status: listRes.status,
      });
      return;
    }

    const listData = (await listRes.json()) as {
      success: boolean;
      resource_subscriptions?: Array<{ id: string; resource_name: string; post_url: string }>;
    };

    for (const sub of listData.resource_subscriptions ?? []) {
      if (sub.post_url.startsWith(webhookBase)) {
        try {
          await fetch(`https://api.gumroad.com/v2/resource_subscriptions/${sub.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          logger.info('Gumroad onDisconnect: deleted resource_subscription', {
            id: sub.id,
            resource_name: sub.resource_name,
          });
        } catch (err) {
          logger.warn('Gumroad onDisconnect: failed to delete resource_subscription', {
            id: sub.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  },
};

export default gumroadProvider;
