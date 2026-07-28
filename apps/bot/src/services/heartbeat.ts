import { createLogger, createStatusHeartbeatReporter } from '@yucp/shared';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

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
  const reporter = createStatusHeartbeatReporter({
    logger,
    serviceName: 'yucp-discord-bot',
    url,
  });
  if (!reporter) {
    return undefined;
  }
  const activeReporter = reporter;

  async function ping() {
    await activeReporter.signal();
  }

  // Run immediately and then schedule
  void ping();
  const intervalHandle = setInterval(() => {
    void ping();
  }, intervalMs);

  logger.info('Heartbeat started', { intervalMinutes });

  return () => {
    clearInterval(intervalHandle);
    logger.info('Heartbeat stopped');
  };
}
