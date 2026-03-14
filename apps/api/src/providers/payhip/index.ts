/**
 * Payhip provider plugin
 *
 * Products: read from Convex (no external API call needed).
 *   Sources: manually added product-secret-keys + provider_catalog_mappings from webhook events.
 * Backfill: not supported (Payhip does not expose a purchase history API).
 *
 * The `permalink` (product_key, e.g., "RGsF") is the canonical product identifier
 * because it matches the `product_link` returned by the Payhip license-key verify API.
 */

import { api } from '../../../../../convex/_generated/api';
import type { ProductRecord, ProviderContext, ProviderPlugin, ProviderPurposes } from '../types';
import { connect } from './connect';
import { webhook } from './webhook';

export const PURPOSES = {
  credential: 'payhip-api-key',
  productSecret: 'payhip-product-secret',
} as const satisfies ProviderPurposes;

const payhipProvider: ProviderPlugin = {
  id: 'payhip',
  needsCredential: false,
  purposes: PURPOSES,
  productCredentialPurpose: PURPOSES.productSecret,

  async getCredential(_ctx: ProviderContext) {
    return null;
  },

  async fetchProducts(_credential, ctx) {
    const entries = (await ctx.convex.query(api.providerConnections.getPayhipProducts, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
    })) as Array<{
      permalink: string;
      displayName?: string;
      productPermalink?: string;
      hasSecretKey: boolean;
    }>;

    return entries.map(
      (e): ProductRecord => ({
        id: e.permalink,
        name: e.displayName,
        productUrl: e.productPermalink ?? `https://payhip.com/b/${e.permalink}`,
        hasSecretKey: e.hasSecretKey,
      }),
    );
  },

  backfill: undefined,
  webhook,
  connect,
};

export default payhipProvider;
