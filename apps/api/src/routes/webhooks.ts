/**
 * Webhook Ingestion Routes
 *
 * POST /webhooks/:provider/:routeId
 *
 * Dispatches to the matching provider's WebhookPlugin.
 * Adding a new provider with webhook support requires zero changes here.
 */

import { createLogger } from '@yucp/shared';
import { getConvexClientFromUrl } from '../lib/convex';
import { PROVIDERS } from '../providers/index';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export interface WebhookConfig {
  convexUrl: string;
  convexApiSecret: string;
  encryptionSecret: string;
}

export function createWebhookHandler(config: WebhookConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);
  const ctx = {
    convex,
    apiSecret: config.convexApiSecret,
    encryptionSecret: config.encryptionSecret,
  };

  return async function handleWebhook(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Expected: /webhooks/:provider/:routeId[/...]
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length < 3 || pathParts[0] !== 'webhooks') {
      return new Response('Not found', { status: 404 });
    }

    const urlProvider = pathParts[1];
    const routeId = pathParts[2];

    logger.info('Webhook request', {
      method: request.method,
      path: url.pathname,
      provider: urlProvider,
      routeId,
    });

    // Direct match by provider id
    let plugin = PROVIDERS.get(urlProvider)?.webhook ? PROVIDERS.get(urlProvider) : undefined;

    // Fallback: check extraProviders (e.g. 'jinxxy-collab' → jinxxy plugin)
    if (!plugin) {
      for (const p of PROVIDERS.values()) {
        if (p.webhook?.extraProviders?.includes(urlProvider)) {
          plugin = p;
          break;
        }
      }
    }

    if (!plugin?.webhook) {
      logger.warn('Webhook: no handler for provider', { provider: urlProvider, routeId });
      return new Response('Not found', { status: 404 });
    }

    return plugin.webhook.handle(request, routeId, urlProvider, ctx);
  };
}
