import { createGumroadProviderModule, GUMROAD_PURPOSES } from '@yucp/providers/gumroad/module';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import type { DisconnectContext } from '../types';
import { defineApiProviderEntry } from '../types';
import { backfill } from './backfill';
import { buyerLink } from './buyerLink';
import { buyerVerification } from './buyerVerification';
import { connect } from './connect';
import { webhook } from './webhook';

export const PURPOSES = GUMROAD_PURPOSES;

interface GumroadApiProviderDeps {
  decryptCredential?: typeof decrypt;
  logger?: typeof logger;
}

export function createGumroadApiProvider(deps: GumroadApiProviderDeps = {}) {
  const providerLogger = deps.logger ?? logger;
  const decryptCredential = deps.decryptCredential ?? decrypt;
  const gumroadRuntime = createGumroadProviderModule({
    logger: providerLogger,
    async getEncryptedCredential(ctx) {
      const data = (await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
        apiSecret: ctx.apiSecret,
        authUserId: ctx.authUserId,
        provider: 'gumroad',
      })) as { credentials?: { oauth_access_token?: string } } | null;
      return data?.credentials?.oauth_access_token ?? null;
    },
    async decryptCredential(encryptedCredential, ctx) {
      return await decryptCredential(
        encryptedCredential,
        ctx.encryptionSecret,
        PURPOSES.credential
      );
    },
  });

  return defineApiProviderEntry({
    runtime: {
      ...gumroadRuntime,
      backfill,
      buyerVerification,
    },
    hooks: {
      programmaticWebhooks: true,
      webhook,
      buyerLink,
      connect,

      async onDisconnect(ctx: DisconnectContext) {
        const timeoutMs = 10_000;
        const encryptedToken = ctx.credentials.oauth_access_token;
        if (!encryptedToken) {
          providerLogger.info('Gumroad onDisconnect: no access token, skipping webhook cleanup');
          return;
        }

        const accessToken = await decryptCredential(
          encryptedToken,
          ctx.encryptionSecret,
          PURPOSES.credential
        );
        const webhookBase = `${ctx.apiBaseUrl.replace(/\/$/, '')}/webhooks/gumroad/`;

        // List all resource subscriptions and delete ones pointing at our webhook base URL.
        // See https://gumroad.com/api, GET/DELETE /v2/resource_subscriptions
        const listRes = await fetch('https://api.gumroad.com/v2/resource_subscriptions', {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!listRes.ok) {
          providerLogger.warn('Gumroad onDisconnect: failed to list resource_subscriptions', {
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
              const deleteRes = await fetch(
                `https://api.gumroad.com/v2/resource_subscriptions/${sub.id}`,
                {
                  method: 'DELETE',
                  headers: { Authorization: `Bearer ${accessToken}` },
                  signal: AbortSignal.timeout(timeoutMs),
                }
              );
              if (!deleteRes.ok) {
                providerLogger.warn(
                  'Gumroad onDisconnect: failed to delete resource_subscription',
                  {
                    id: sub.id,
                    status: deleteRes.status,
                  }
                );
                continue;
              }
              providerLogger.info('Gumroad onDisconnect: deleted resource_subscription', {
                id: sub.id,
                resource_name: sub.resource_name,
              });
            } catch (err) {
              providerLogger.warn('Gumroad onDisconnect: failed to delete resource_subscription', {
                id: sub.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      },
    },
  });
}

const gumroadProvider = createGumroadApiProvider();

export default gumroadProvider;
