import { createLogger } from '@yucp/shared';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

let intervalHandle: ReturnType<typeof setInterval> | undefined;

/**
 * Start a periodic heartbeat ping to the given URL.
 * Returns a stop function (or undefined when URL not provided).
 */
export function startHeartbeat(url?: string, intervalMinutes = 5): (() => void) | undefined {
  if (!url) {
    logger.info('HEARTBEAT_URL not configured; heartbeat disabled');
    return undefined;
  }

  const intervalMinutesNumber = Number(intervalMinutes) || 5;
  const intervalMs = Math.max(1000, Math.round(intervalMinutesNumber * 60 * 1000));
  const timeoutMs = 10_000;

  async function ping() {
    if (!url) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        if (!res.ok) {
          const body = await res.text().catch(() => '<unreadable>');
          logger.warn('Heartbeat ping non-OK response', {
            status: res.status,
            statusText: res.statusText,
            body: body.slice(0, 300),
          });
        } else {
          logger.debug('Heartbeat ping success', { status: res.status });
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      logger.warn('Heartbeat ping failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Run immediately and then schedule
  void ping();
  intervalHandle = setInterval(() => {
    void ping();
  }, intervalMs);

  logger.info('Heartbeat started', { intervalMinutes, url: redactUrl(url) });

  return () => {
    if (intervalHandle) clearInterval(intervalHandle);
    intervalHandle = undefined;
    logger.info('Heartbeat stopped');
  };
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = u.search ? '?[REDACTED]' : '';
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return '[REDACTED]';
  }
}
