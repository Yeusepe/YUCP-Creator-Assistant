/**
 * Internal Notify Route — POST /api/internal/notify
 *
 * Called by the Discord bot to push a real-time notification to the creator dashboard.
 * Authenticated via X-Internal-Service-Secret header (constant-time comparison).
 *
 * Body: { authUserId, guildId, type, title, message? }
 * Response: 204 on success, 401/400/405 on failure
 */

import { createLogger, getInternalRpcSharedSecret, timingSafeStringEqual } from '@yucp/shared';
import { internal } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { loadEnv } from '../lib/env';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

type NotificationType = 'success' | 'error' | 'warning' | 'info';

interface NotifyRequestBody {
  authUserId: string;
  guildId: string;
  type: NotificationType;
  title: string;
  message?: string;
}

const VALID_TYPES = new Set<NotificationType>(['success', 'error', 'warning', 'info']);

export async function handleInternalNotify(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const env = loadEnv();
  const expectedSecret = getInternalRpcSharedSecret(env);
  const providedSecret = request.headers.get('x-internal-service-secret') ?? '';

  if (!timingSafeStringEqual(providedSecret, expectedSecret)) {
    logger.warn('Internal notify: rejected (invalid secret)');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: NotifyRequestBody;
  try {
    body = (await request.json()) as NotifyRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { authUserId, guildId, type, title, message } = body;

  if (!authUserId || !guildId || !type || !title) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: authUserId, guildId, type, title' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (!VALID_TYPES.has(type)) {
    return new Response(
      JSON.stringify({ error: 'Invalid type. Must be success|error|warning|info' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const convexUrl = env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '';
  const convexApiSecret = env.CONVEX_API_SECRET ?? '';

  if (!convexUrl || !convexApiSecret) {
    logger.error('Internal notify: CONVEX_URL or CONVEX_API_SECRET not configured');
    return new Response(JSON.stringify({ error: 'Server misconfiguration' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const convex = getConvexClientFromUrl(convexUrl);
    await convex.mutation(internal.adminNotifications.create, {
      apiSecret: convexApiSecret,
      authUserId,
      guildId,
      type,
      title,
      message,
    });

    logger.info('Admin notification created', { authUserId, guildId, type, title });
    return new Response(null, { status: 204 });
  } catch (error) {
    logger.error('Internal notify: failed to create notification', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: 'Failed to create notification' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
