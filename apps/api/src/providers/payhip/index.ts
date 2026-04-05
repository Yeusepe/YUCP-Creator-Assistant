import { createPayhipProviderModule, PAYHIP_PURPOSES } from '@yucp/providers/payhip/module';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import { defineApiProviderEntry } from '../types';
import { connect } from './connect';
import { webhook } from './webhook';

export const PURPOSES = PAYHIP_PURPOSES;

const payhipRuntime = createPayhipProviderModule({
  logger,
  async listProducts(ctx) {
    return await ctx.convex.query(api.providerConnections.getPayhipProducts, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
    });
  },
  async upsertProductName({ authUserId, permalink, displayName }, ctx) {
    await ctx.convex.mutation(api.providerConnections.upsertPayhipProductName, {
      apiSecret: ctx.apiSecret,
      authUserId,
      permalink,
      displayName,
    });
  },
  async listProductSecretKeys(authUserId, ctx) {
    return await ctx.convex.query(api.providerConnections.getPayhipProductSecretKeys, {
      apiSecret: ctx.apiSecret,
      authUserId,
    });
  },
  async decryptProductSecretKey(encryptedSecretKey, ctx) {
    return await decrypt(encryptedSecretKey, ctx.encryptionSecret, PURPOSES.productSecret);
  },
});

const payhipProvider = defineApiProviderEntry({
  runtime: payhipRuntime,
  hooks: {
    connect,
    webhook,
  },
});

export default payhipProvider;
