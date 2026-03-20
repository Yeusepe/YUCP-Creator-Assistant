import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { encrypt } from '../../lib/encrypt';
import { resolveAuth as _resolveAuthBase } from './auth';
import {
  errorResponse,
  extractListData,
  generateRequestId,
  jsonResponse,
  listResponse,
  parsePagination,
} from './helpers';
import type { PublicV2Config } from './types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const WEBHOOK_SIGNING_SECRET_PURPOSE = 'yucp-webhook-signing-secret';

/**
 * Private IPv4 CIDR ranges and known-dangerous hostnames that must not be
 * used as webhook destinations (SSRF protection).
 */
const BLOCKED_IP_PATTERN =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1([01]\d|2[0-7]))\.|0\.0\.0\.0|::1$|fc|fd)/i;

const BLOCKED_HOSTNAME_PATTERN = /^(localhost|metadata\.google\.internal|.*\.local)$/i;

/**
 * Validates a webhook destination URL.
 * Returns null on success or an error string describing why it was rejected.
 *
 * Rules enforced:
 *  - Must use HTTPS scheme
 *  - Hostname must not resolve to loopback, RFC1918, link-local, CGNAT, or
 *    other private ranges (checked against the literal hostname/IP; full DNS
 *    resolution is the responsibility of the delivery layer / egress firewall)
 *  - Hostname must not be a known-internal service name
 */
function validateWebhookUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'url is not a valid URL';
  }

  if (parsed.protocol !== 'https:') {
    return 'url must use HTTPS';
  }

  const { hostname } = parsed;

  if (BLOCKED_HOSTNAME_PATTERN.test(hostname)) {
    return 'url hostname is not allowed';
  }

  if (BLOCKED_IP_PATTERN.test(hostname)) {
    return 'url must not target a private or reserved IP address';
  }

  return null;
}

const WEBHOOK_EVENT_TYPES = [
  {
    type: 'entitlement.granted',
    description: 'Fired when a subject gains a new entitlement to a product.',
  },
  {
    type: 'entitlement.revoked',
    description: 'Fired when an entitlement is revoked (refund, manual revocation, etc.).',
  },
  {
    type: 'entitlement.expired',
    description: 'Fired when a time-limited entitlement expires.',
  },
  {
    type: 'subject.created',
    description: 'Fired when a new subject is created in the system.',
  },
  {
    type: 'subject.updated',
    description: 'Fired when a subject profile is updated.',
  },
  {
    type: 'subject.status.changed',
    description: 'Fired when a subject status changes (e.g., active -> suspended).',
  },
  {
    type: 'binding.created',
    description: 'Fired when a new product binding is created for a subject.',
  },
  {
    type: 'binding.activated',
    description: 'Fired when a binding transitions to active status.',
  },
  {
    type: 'binding.revoked',
    description: 'Fired when a binding is revoked.',
  },
  {
    type: 'verification.completed',
    description: 'Fired when a verification session completes successfully.',
  },
  {
    type: 'verification.failed',
    description: 'Fired when a verification session fails or expires.',
  },
  {
    type: 'transaction.created',
    description: 'Fired when a new transaction (purchase) is recorded.',
  },
  {
    type: 'transaction.refunded',
    description: 'Fired when a transaction is refunded.',
  },
  {
    type: 'membership.created',
    description: 'Fired when a new subscription membership is created.',
  },
  {
    type: 'membership.cancelled',
    description: 'Fired when a membership/subscription is cancelled.',
  },
  {
    type: 'manual_license.created',
    description: 'Fired when a manual license is created.',
  },
  {
    type: 'manual_license.revoked',
    description: 'Fired when a manual license is revoked.',
  },
  {
    type: 'product.added',
    description: 'Fired when a product is linked to the tenant catalog.',
  },
  {
    type: 'product.removed',
    description: 'Fired when a product is removed from the tenant catalog.',
  },
  {
    type: 'guild.linked',
    description: 'Fired when a Discord server is linked to the tenant.',
  },
  {
    type: 'guild.unlinked',
    description: 'Fired when a Discord server is unlinked from the tenant.',
  },
  {
    type: 'ping',
    description: 'Test event used to verify webhook endpoint connectivity.',
  },
] as const;

function generateSigningSecret(): string {
  return `whsec_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
}

/** Strips encrypted secret from a subscription object before returning to API caller. */
function sanitizeSubscription(sub: Record<string, unknown>): Record<string, unknown> {
  const { signingSecretEnc: _enc, ...safe } = sub;
  return safe;
}

export async function handleWebhooksRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config,
  services: { resolveAuth?: typeof _resolveAuthBase } = {}
): Promise<Response> {
  const resolveAuth = services.resolveAuth ?? _resolveAuthBase;
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  // GET /webhook-event-types
  if (subPath === '/webhook-event-types') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['webhooks:manage'], reqId);
    if (auth instanceof Response) return auth;

    return jsonResponse(
      {
        object: 'list',
        data: WEBHOOK_EVENT_TYPES,
        hasMore: false,
        nextCursor: null,
      },
      200,
      reqId
    );
  }

  // Routing for /webhooks subtree
  if (!subPath.startsWith('/webhooks')) {
    return errorResponse('not_found', 'Route not found', 404, reqId);
  }

  const webhookSub = subPath.slice('/webhooks'.length); // e.g. '', '/abc123', '/abc123/rotate-secret'

  // GET/POST /webhooks (list or create)
  if (webhookSub === '' || webhookSub === '/') {
    if (request.method === 'GET') {
      const auth = await resolveAuth(request, config, ['webhooks:manage'], reqId);
      if (auth instanceof Response) return auth;

      const enabledParam = url.searchParams.get('enabled');
      const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;

      try {
        const result = await convex.query(api.webhookSubscriptions.list, {
          apiSecret: config.convexApiSecret,
          authUserId: auth.authUserId,
          enabled,
        });
        const { data, hasMore, nextCursor } = extractListData(result);
        const sanitized = (data as Record<string, unknown>[]).map(sanitizeSubscription);
        return listResponse(sanitized, hasMore, nextCursor, reqId);
      } catch (err) {
        logger.error('webhookSubscriptions.list failed', { error: String(err) });
        return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
      }
    }

    if (request.method === 'POST') {
      const auth = await resolveAuth(request, config, ['webhooks:manage'], reqId);
      if (auth instanceof Response) return auth;

      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return errorResponse('bad_request', 'Invalid JSON body', 400, reqId);
      }

      if (typeof body.url !== 'string' || !body.url) {
        return errorResponse('bad_request', 'url is required', 400, reqId);
      }

      const urlError = validateWebhookUrl(body.url);
      if (urlError) {
        return errorResponse('bad_request', urlError, 400, reqId);
      }

      const signingSecret = generateSigningSecret();
      const signingSecretPrefix = signingSecret.slice(0, 8);

      try {
        const signingSecretEnc = await encrypt(
          signingSecret,
          config.encryptionSecret,
          WEBHOOK_SIGNING_SECRET_PURPOSE
        );

        const result = await convex.mutation(api.webhookSubscriptions.create, {
          apiSecret: config.convexApiSecret,
          authUserId: auth.authUserId,
          url: body.url as string,
          events: Array.isArray(body.events) ? (body.events as string[]) : [],
          description: typeof body.description === 'string' ? body.description : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
          signingSecretEnc,
          signingSecretPrefix,
        });

        const sub = (result as Record<string, unknown>) ?? {};
        return jsonResponse(
          {
            ...sanitizeSubscription(sub),
            signingSecret,
          },
          201,
          reqId
        );
      } catch (err) {
        logger.error('webhookSubscriptions.create failed', { error: String(err) });
        return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
      }
    }

    return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
  }

  // POST /webhooks/:id/rotate-secret
  const rotateMatch = webhookSub.match(/^\/([^/]+)\/rotate-secret$/);
  if (rotateMatch) {
    if (request.method !== 'POST') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['webhooks:manage'], reqId);
    if (auth instanceof Response) return auth;

    const subscriptionId = rotateMatch[1];
    const newSigningSecret = generateSigningSecret();
    const newSigningSecretPrefix = newSigningSecret.slice(0, 8);

    try {
      const newSigningSecretEnc = await encrypt(
        newSigningSecret,
        config.encryptionSecret,
        WEBHOOK_SIGNING_SECRET_PURPOSE
      );

      const result = await convex.mutation(api.webhookSubscriptions.rotateSecret, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        subscriptionId,
        newSigningSecretEnc,
        newSigningSecretPrefix,
      });

      const sub = (result as Record<string, unknown>) ?? {};
      return jsonResponse(
        {
          ...sanitizeSubscription(sub),
          signingSecret: newSigningSecret,
        },
        200,
        reqId
      );
    } catch (err) {
      logger.error('webhookSubscriptions.rotateSecret failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /webhooks/:id/deliveries
  const deliveriesMatch = webhookSub.match(/^\/([^/]+)\/deliveries$/);
  if (deliveriesMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['webhooks:manage'], reqId);
    if (auth instanceof Response) return auth;

    const subscriptionId = deliveriesMatch[1];
    const { limit, cursor } = parsePagination(url);
    const status = url.searchParams.get('status') ?? undefined;

    try {
      const result = await convex.query(api.webhookDeliveries.listBySubscription, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        subscriptionId,
        status,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('webhookDeliveries.listBySubscription failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // POST /webhooks/:id/test
  const testMatch = webhookSub.match(/^\/([^/]+)\/test$/);
  if (testMatch) {
    if (request.method !== 'POST') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['webhooks:manage'], reqId);
    if (auth instanceof Response) return auth;

    try {
      await convex.mutation(api.creatorEvents.emitPingEvent, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
      });
      return jsonResponse({ object: 'webhook_test', queued: true }, 200, reqId);
    } catch (err) {
      logger.error('creatorEvents.emitEvent (webhook test) failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /webhooks/:id, PATCH /webhooks/:id, DELETE /webhooks/:id
  const idMatch = webhookSub.match(/^\/([^/]+)$/);
  if (idMatch) {
    const subscriptionId = idMatch[1];

    if (request.method === 'GET') {
      const auth = await resolveAuth(request, config, ['webhooks:manage'], reqId);
      if (auth instanceof Response) return auth;

      try {
        const result = await convex.query(api.webhookSubscriptions.getById, {
          apiSecret: config.convexApiSecret,
          authUserId: auth.authUserId,
          subscriptionId,
        });
        if (!result) {
          return errorResponse(
            'not_found',
            `Webhook subscription with ID ${subscriptionId} was not found`,
            404,
            reqId
          );
        }
        return jsonResponse(sanitizeSubscription(result as Record<string, unknown>), 200, reqId);
      } catch (err) {
        logger.error('webhookSubscriptions.getById failed', { error: String(err) });
        return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
      }
    }

    if (request.method === 'PATCH') {
      const auth = await resolveAuth(request, config, ['webhooks:manage'], reqId);
      if (auth instanceof Response) return auth;

      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return errorResponse('bad_request', 'Invalid JSON body', 400, reqId);
      }

      if (typeof body.url === 'string') {
        const urlError = validateWebhookUrl(body.url);
        if (urlError) {
          return errorResponse('bad_request', urlError, 400, reqId);
        }
      }

      try {
        const result = await convex.mutation(api.webhookSubscriptions.update, {
          apiSecret: config.convexApiSecret,
          authUserId: auth.authUserId,
          subscriptionId,
          url: typeof body.url === 'string' ? body.url : undefined,
          events: Array.isArray(body.events) ? (body.events as string[]) : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        });
        return jsonResponse(sanitizeSubscription(result as Record<string, unknown>), 200, reqId);
      } catch (err) {
        logger.error('webhookSubscriptions.update failed', { error: String(err) });
        return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
      }
    }

    if (request.method === 'DELETE') {
      const auth = await resolveAuth(request, config, ['webhooks:manage'], reqId);
      if (auth instanceof Response) return auth;

      try {
        await convex.mutation(api.webhookSubscriptions.deleteSubscription, {
          apiSecret: config.convexApiSecret,
          authUserId: auth.authUserId,
          subscriptionId,
        });
        return jsonResponse(
          { object: 'webhook_subscription', deleted: true, id: subscriptionId },
          200,
          reqId
        );
      } catch (err) {
        logger.error('webhookSubscriptions.deleteSubscription failed', { error: String(err) });
        return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
      }
    }

    return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
