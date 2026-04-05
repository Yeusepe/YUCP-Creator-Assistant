import { createJinxxyProviderModule, JINXXY_PURPOSES } from '@yucp/providers/jinxxy/module';
import { api } from '../../../../../convex/_generated/api';
import { logger } from '../../lib/logger';
import { defineApiProviderEntry } from '../types';
import { backfill } from './backfill';
import { buyerVerification } from './buyerVerification';
import { connect } from './connect';
import { decryptJinxxyApiKey } from './credentials';
import { webhook } from './webhook';

export const PURPOSES = JINXXY_PURPOSES;

const jinxxyRuntime = createJinxxyProviderModule({
  logger,
  async getEncryptedCredential(authUserId, ctx) {
    const data = (await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId,
      provider: 'jinxxy',
    })) as { credentials?: { api_key?: string } } | null;
    return data?.credentials?.api_key ?? null;
  },
  async decryptCredential(encryptedCredential, ctx) {
    return await decryptJinxxyApiKey(encryptedCredential, ctx.encryptionSecret);
  },
  async listCollaboratorConnections(ctx) {
    return (await ctx.convex.query(api.collaboratorInvites.getCollabConnectionsForVerification, {
      apiSecret: ctx.apiSecret,
      ownerAuthUserId: ctx.authUserId,
    })) as Array<{
      id: string;
      provider: string;
      credentialEncrypted?: string;
      collaboratorDisplayName?: string;
    }>;
  },
});

const jinxxyProvider = defineApiProviderEntry({
  runtime: {
    ...jinxxyRuntime,
    backfill,
    buyerVerification,
  },
  hooks: {
    webhook,
    connect,
  },
});

export default jinxxyProvider;
