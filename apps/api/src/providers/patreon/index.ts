import { createPatreonProviderModule, PATREON_PURPOSES } from '@yucp/providers/patreon/module';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import { defineApiProviderEntry } from '../types';
import { buyerLink } from './buyerLink';
import { connect } from './connect';

export const PURPOSES = PATREON_PURPOSES;

const patreonRuntime = createPatreonProviderModule({
  logger,
  async getEncryptedCredential(ctx) {
    const data = (await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
      provider: 'patreon',
    })) as { credentials?: { oauth_access_token?: string } } | null;
    return data?.credentials?.oauth_access_token ?? null;
  },
  async decryptCredential(encryptedCredential, ctx) {
    return await decrypt(encryptedCredential, ctx.encryptionSecret, PURPOSES.credential);
  },
});

const patreonProvider = defineApiProviderEntry({
  runtime: patreonRuntime,
  hooks: {
    programmaticWebhooks: false,
    buyerLink,
    connect,
  },
});

export default patreonProvider;
