/**
 * Dashboard notification helper for the Discord bot.
 *
 * Fire-and-forget: sends a notification to the creator dashboard via
 * POST /api/internal/notify. Failures are logged but never thrown,
 * so bot commands always complete regardless of notification status.
 */

import { createLogger, getInternalRpcSharedSecret } from '@yucp/shared';
import { getApiUrls } from './apiUrls';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

type NotificationType = 'success' | 'error' | 'warning' | 'info';

interface NotificationPayload {
  authUserId: string;
  guildId: string;
  type: NotificationType;
  title: string;
  message?: string;
}

/**
 * Send a real-time notification to the creator's dashboard.
 * This is fire-and-forget, never awaited in bot command paths.
 */
export function sendDashboardNotification(payload: NotificationPayload): void {
  const { apiInternal, apiPublic } = getApiUrls();
  const apiBase = (apiInternal ?? apiPublic ?? '').replace(/\/$/, '');

  if (!apiBase) {
    logger.warn('sendDashboardNotification: no API base URL configured, skipping');
    return;
  }

  const secret = getInternalRpcSharedSecret(process.env);

  fetch(`${apiBase}/api/internal/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Service-Secret': secret,
    },
    body: JSON.stringify(payload),
  })
    .then((res) => {
      if (!res.ok) {
        logger.warn('sendDashboardNotification: non-OK response', { status: res.status });
      }
    })
    .catch((error) => {
      logger.warn('sendDashboardNotification: fetch failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
