import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { setActiveSpanAttributes, withObservedSpan } from './observability';

type HeartbeatFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface StatusHeartbeatLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface StatusHeartbeatReporter {
  signal(): Promise<boolean>;
}

export interface CreateStatusHeartbeatReporterOptions {
  fetch?: HeartbeatFetch;
  logger?: StatusHeartbeatLogger;
  serviceName: string;
  timeoutMs?: number;
  url?: string;
}

type HeartbeatFailureReason = 'http_error' | 'request_failed' | 'timeout';

class StatusHeartbeatDeliveryError extends Error {
  readonly reason: HeartbeatFailureReason;
  readonly statusCode?: number;

  constructor(reason: HeartbeatFailureReason, statusCode?: number) {
    super('Status heartbeat delivery failed');
    this.name = 'StatusHeartbeatDeliveryError';
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const tracer = trace.getTracer('yucp-status-heartbeat');

function requireHeartbeatUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Status heartbeat URL is invalid');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Status heartbeat URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Status heartbeat URL must not contain URL credentials');
  }
  return url;
}

function requireTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Status heartbeat timeout must be a positive safe integer');
  }
  return value;
}

function diagnostic(
  event: string,
  input: {
    serviceName: string;
    statusCode?: number;
  }
): string {
  return JSON.stringify({
    event,
    service: input.serviceName,
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
  });
}

export function createStatusHeartbeatReporter(
  options: CreateStatusHeartbeatReporterOptions
): StatusHeartbeatReporter | undefined {
  const configuredUrl = options.url?.trim();
  if (!configuredUrl) {
    return undefined;
  }
  const serviceName = options.serviceName.trim();
  if (!serviceName) {
    throw new Error('Status heartbeat service name is required');
  }
  const url = requireHeartbeatUrl(configuredUrl);
  const timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const request = options.fetch ?? fetch;
  const logger = options.logger ?? console;

  return {
    async signal(): Promise<boolean> {
      try {
        return await withObservedSpan(
          tracer,
          'status_heartbeat.deliver',
          {
            'heartbeat.service.name': serviceName,
            'http.request.method': 'GET',
            'server.address': url.hostname,
            'url.scheme': url.protocol.slice(0, -1),
          },
          async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            const headers: Record<string, string> = {};
            propagation.inject(context.active(), headers);
            let response: Response;
            try {
              response = await request(url.toString(), {
                cache: 'no-store',
                headers,
                method: 'GET',
                signal: controller.signal,
              });
            } catch (error) {
              throw new StatusHeartbeatDeliveryError(
                error instanceof DOMException && error.name === 'AbortError'
                  ? 'timeout'
                  : 'request_failed'
              );
            } finally {
              clearTimeout(timer);
            }

            setActiveSpanAttributes({
              'http.response.status_code': response.status,
            });
            if (!response.ok) {
              throw new StatusHeartbeatDeliveryError('http_error', response.status);
            }
            logger.debug(
              diagnostic('status_heartbeat.delivered', {
                serviceName,
                statusCode: response.status,
              })
            );
            return true;
          },
          SpanKind.CLIENT
        );
      } catch (error) {
        const failure =
          error instanceof StatusHeartbeatDeliveryError
            ? error
            : new StatusHeartbeatDeliveryError('request_failed');
        logger.warn(
          diagnostic(`status_heartbeat.${failure.reason}`, {
            serviceName,
            statusCode: failure.statusCode,
          })
        );
        return false;
      }
    },
  };
}
