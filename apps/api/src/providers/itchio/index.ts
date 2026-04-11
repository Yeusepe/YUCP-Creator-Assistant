import { createItchioProviderModule, ITCHIO_PURPOSES } from '@yucp/providers/itchio/module';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import { defineApiProviderEntry } from '../types';
import { buyerLink } from './buyerLink';
import { buyerVerification } from './buyerVerification';
import { connect } from './connect';

export const PURPOSES = ITCHIO_PURPOSES;

const itchioRuntime = createItchioProviderModule({
  logger,
  async getEncryptedCredential(authUserId, ctx) {
    const data = (await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId,
      provider: 'itchio',
    })) as { credentials?: { oauth_access_token?: string } } | null;

    return data?.credentials?.oauth_access_token ?? null;
  },
  async decryptCredential(encryptedCredential, ctx) {
    return await decrypt(encryptedCredential, ctx.encryptionSecret, PURPOSES.credential);
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

const itchioProvider = defineApiProviderEntry({
  runtime: {
    ...itchioRuntime,
    buyerVerification,
  },
  hooks: {
    buyerLink,
    connect,
  },
});

export default itchioProvider;
