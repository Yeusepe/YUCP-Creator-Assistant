/**
 * Webhook Ingestion Routes
 *
 * POST /webhooks/:provider/:routeId
 *
 * Dispatches to the matching provider's WebhookPlugin.
 * Adding a new provider with webhook support requires zero changes here.
 */

import { getConvexClientFromUrl } from '../lib/convex';
import { logger } from '../lib/logger';
import { resolveWebhookPlugin } from '../providers/index';

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

    const resolvedWebhook = resolveWebhookPlugin(urlProvider);
    if (!resolvedWebhook) {
      logger.warn('Webhook: no handler for provider', { provider: urlProvider, routeId });
      return new Response('Not found', { status: 404 });
    }

    return resolvedWebhook.webhook.handle(request, routeId, urlProvider, ctx);
  };
}
