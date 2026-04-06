import { createGumroadProviderModule, GUMROAD_PURPOSES } from '@yucp/providers/gumroad/module';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import type { DisconnectContext } from '../types';
import { defineApiProviderEntry } from '../types';
import { backfill } from './backfill';
import { buyerVerification } from './buyerVerification';
import { connect } from './connect';
import { webhook } from './webhook';

export const PURPOSES = GUMROAD_PURPOSES;

const gumroadRuntime = createGumroadProviderModule({
  logger,
  async getEncryptedCredential(ctx) {
    const data = (await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId: ctx.authUserId,
      provider: 'gumroad',
    })) as { credentials?: { oauth_access_token?: string } } | null;
    return data?.credentials?.oauth_access_token ?? null;
  },
  async decryptCredential(encryptedCredential, ctx) {
    return await decrypt(encryptedCredential, ctx.encryptionSecret, PURPOSES.credential);
  },
});

const gumroadProvider = defineApiProviderEntry({
  runtime: {
    ...gumroadRuntime,
    backfill,
    buyerVerification,
  },
  hooks: {
    programmaticWebhooks: true,
    webhook,
    connect,

    async onDisconnect(ctx: DisconnectContext) {
      const timeoutMs = 10_000;
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
        signal: AbortSignal.timeout(timeoutMs),
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
              signal: AbortSignal.timeout(timeoutMs),
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
  },
});

export default gumroadProvider;
