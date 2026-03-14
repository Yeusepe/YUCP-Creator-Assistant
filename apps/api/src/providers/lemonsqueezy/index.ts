/**
 * Lemon Squeezy provider plugin
 *
 * Products: fetches via LemonSqueezyApiClient.getProducts (page-based)
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

  async fetchProducts(credential) {
    if (!credential) return [];

    const client = new LemonSqueezyApiClient({ apiToken: credential });
    const products: ProductRecord[] = [];
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

    return products;
  },

  backfill,
  connect,
  verification,
};

export default lemonSqueezyProvider;
