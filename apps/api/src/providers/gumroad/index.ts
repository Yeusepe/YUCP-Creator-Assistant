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
  needsCredential: true,
  purposes: PURPOSES,

  async getCredential(ctx: ProviderContext) {
    const conn = await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
      provider: 'gumroad',
    });
    if (!conn?.gumroadAccessTokenEncrypted) return null;
    return decrypt(conn.gumroadAccessTokenEncrypted, ctx.encryptionSecret, PURPOSES.credential);
  },

  async fetchProducts(credential) {
    if (!credential) return [];

    const products: ProductRecord[] = [];
    let nextPageUrl: string | undefined = `${GUMROAD_API_BASE}/products`;

    while (nextPageUrl && products.length < 5000) {
      const separator = nextPageUrl.includes('?') ? '&' : '?';
      const url = `${nextPageUrl}${separator}access_token=${encodeURIComponent(credential)}`;

      const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
        logger.warn('Gumroad rate limit fetching products', { waitMs });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

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
};

export default gumroadProvider;
