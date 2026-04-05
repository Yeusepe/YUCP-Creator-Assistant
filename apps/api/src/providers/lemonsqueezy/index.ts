import { LemonSqueezyApiClient } from '@yucp/providers/lemonsqueezy';
import {
  createLemonSqueezyProviderModule,
  LEMONSQUEEZY_PURPOSES,
} from '@yucp/providers/lemonsqueezy/module';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import type { DisconnectContext } from '../types';
import { defineApiProviderEntry } from '../types';
import { backfill } from './backfill';
import { buyerVerification } from './buyerVerification';
import { connect } from './connect';

export const PURPOSES = LEMONSQUEEZY_PURPOSES;

const lemonSqueezyRuntime = createLemonSqueezyProviderModule({
  logger,
  async getEncryptedCredential(authUserId, ctx) {
    const data = (await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId,
      provider: 'lemonsqueezy',
    })) as { credentials?: { api_token?: string } } | null;
    return data?.credentials?.api_token ?? null;
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

const lemonSqueezyProvider = defineApiProviderEntry({
  runtime: {
    ...lemonSqueezyRuntime,
    backfill,
    buyerVerification,
  },
  hooks: {
    programmaticWebhooks: true,
    connect,
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
  },
});

export default lemonSqueezyProvider;
