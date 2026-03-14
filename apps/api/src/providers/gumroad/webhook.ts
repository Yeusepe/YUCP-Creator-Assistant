import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import type { WebhookPlugin } from '../types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

export const webhook: WebhookPlugin = {
  async handle(request, routeId, _urlProviderId, ctx) {
    const { convex, apiSecret } = ctx;

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const rawBody = await request.text();
      logger.info('Webhook received', {
        provider: 'gumroad',
        routeId,
        payloadBytes: rawBody.length,
      });

      const params = new URLSearchParams(rawBody);
      const saleId = params.get('sale_id') ?? '';
      const refunded = params.get('refunded') === 'true';
      const eventType = refunded ? 'refund' : 'sale';
      const providerEventId = `${saleId}:${eventType}`;

      if (!saleId) {
        logger.warn('Gumroad webhook: missing sale_id', { routeId });
        return new Response('OK', { status: 200 });
      }

      const saleTimestamp = params.get('sale_timestamp');
      if (saleTimestamp) {
        const ts = Date.parse(saleTimestamp);
        if (Number.isFinite(ts) && Date.now() - ts > WEBHOOK_MAX_AGE_MS) {
          logger.warn('Gumroad webhook: rejected', {
            routeId,
            saleId,
            reason: `sale_timestamp is more than ${WEBHOOK_MAX_AGE_MS / 60000} minutes old (replay protection)`,
          });
          return new Response('Forbidden', { status: 403 });
        }
      }

      // Gumroad Ping has no signature — security relies on the routeId being private.
      const conn = await convex.query(api.providerConnections.getConnectionForBackfill, {
        apiSecret,
        authUserId: routeId,
        provider: 'gumroad',
      });

      if (!conn) {
        logger.warn('Gumroad webhook: rejected', {
          routeId,
          saleId,
          reason: 'No active Gumroad connection found for this routeId',
        });
        return new Response('Forbidden', { status: 403 });
      }

      let authUserIds: string[];
      try {
        authUserIds = await convex.query(api.webhookIngestion.resolveWebhookTenantIds, {
          apiSecret,
          authUserId: routeId,
        });
      } catch {
        authUserIds = [];
      }

      const payload = Object.fromEntries(params.entries());

      if (authUserIds.length > 0) {
        let anySuccess = false;
        for (const authUserId of authUserIds) {
          try {
            const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
              apiSecret,
              authUserId,
              provider: 'gumroad',
              providerEventId,
              eventType,
              rawPayload: payload,
              signatureValid: true,
            });
            if (result.duplicate) {
              logger.debug('Gumroad webhook: duplicate event', { saleId, authUserId });
            }
            anySuccess = true;
          } catch (err) {
            logger.warn('Gumroad webhook: failed to insert event for user', {
              authUserId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (!anySuccess) {
          logger.error('Gumroad webhook: all insert attempts failed', { routeId, saleId });
          return new Response('Internal Server Error', { status: 500 });
        }
      } else {
        // No Discord server connected yet — store event under authUserId directly
        try {
          const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
            apiSecret,
            authUserId: routeId,
            provider: 'gumroad',
            providerEventId,
            eventType,
            rawPayload: payload,
            signatureValid: true,
          });
          if (result.duplicate) {
            logger.debug('Gumroad webhook: duplicate event (user-scoped)', { saleId, routeId });
          }
        } catch (err) {
          logger.warn('Gumroad webhook: failed to insert user-scoped event', {
            routeId,
            error: err instanceof Error ? err.message : String(err),
          });
          return new Response('Internal Server Error', { status: 500 });
        }
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      logger.error('Gumroad webhook failed', {
        error: err instanceof Error ? err.message : String(err),
        routeId,
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
