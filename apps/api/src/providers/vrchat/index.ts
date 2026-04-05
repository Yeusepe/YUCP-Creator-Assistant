import { createVrchatProviderModule, VRCHAT_PURPOSES } from '@yucp/providers/vrchat/module';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import { defineApiProviderEntry } from '../types';
import { vrchatConnect } from './connect';

export const PURPOSES = VRCHAT_PURPOSES;

const vrchatRuntime = createVrchatProviderModule({
  logger,
  async getEncryptedCredential(ctx) {
    const data = (await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
      provider: 'vrchat',
    })) as { credentials?: { vrchat_session?: string } } | null;
    return data?.credentials?.vrchat_session ?? null;
  },
  async decryptCredential(encryptedCredential, ctx) {
    return await decrypt(encryptedCredential, ctx.encryptionSecret, PURPOSES.credential);
  },
});

const vrchatProvider = defineApiProviderEntry({
  runtime: vrchatRuntime,
  hooks: {
    connect: vrchatConnect,
  },
});

export default vrchatProvider;
