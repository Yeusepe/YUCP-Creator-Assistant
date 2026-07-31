import { context, propagation, trace } from '@opentelemetry/api';
import { getRequestHeader } from '@tanstack/react-start/server';
import { getInternalRpcSharedSecret } from '@yucp/shared';
import { filterForwardedAuthCookieHeader } from './forwardedAuthCookies';
import { getActiveWebServerTraceId, withWebServerSpan } from './observability';
import { getWebApiBaseUrl, getWebRuntimeEnv, isWebProductionRuntime } from './runtimeEnv';

/**
 * Server-side HTTP client for calling the Bun API.
 *
 * All calls are made server-to-server from TanStack Start to the Bun API,
 * authenticated via INTERNAL_RPC_SHARED_SECRET. The user's Convex auth token
 * is forwarded as X-Auth-Token so the API can identify the caller.
 *
 * This replaces the browser-direct fetch calls that previously went through
 * the Vite dev proxy.
 */

function getInternalSecret(): string {
  return getInternalRpcSharedSecret(getWebRuntimeEnv());
}

interface ServerFetchOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
  /** Pass the user's Convex auth token for user-scoped requests */
  authToken?: string | null;
  onServerTiming?: (metrics: ServerTimingMetric[]) => void;
}

export interface ServerTimingMetric {
  name: string;
  durationMs: number;
}

function roundDuration(value: number) {
  return Number(value.toFixed(1));
}

function parseServerTimingHeader(headerValue: string | null): ServerTimingMetric[] {
  if (!headerValue) {
    return [];
  }

  return headerValue
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const [rawName, ...params] = segment.split(';').map((part) => part.trim());
      const durParam = params.find((param) => param.startsWith('dur='));
      const durationMs = durParam ? Number.parseFloat(durParam.slice(4)) : Number.NaN;
      return {
        name: rawName,
        durationMs,
      };
    })
    .filter(
      (metric): metric is ServerTimingMetric =>
        Boolean(metric.name) && Number.isFinite(metric.durationMs)
    )
    .map((metric) => ({
      name: metric.name,
      durationMs: roundDuration(metric.durationMs),
    }));
}

function getForwardedAuthCookieHeader(): string | null {
  try {
    return filterForwardedAuthCookieHeader(getRequestHeader('cookie'));
  } catch {
    return null;
  }
}

function getErrorCode(error: unknown): string {
  const directCode =
    error instanceof Error && 'code' in error
      ? (error as Error & { code?: unknown }).code
      : undefined;
  if (typeof directCode === 'string' && directCode.trim()) {
    return directCode.trim();
  }

  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
  const causeCode =
    cause && 'code' in cause ? (cause as Error & { code?: unknown }).code : undefined;
  if (typeof causeCode === 'string' && causeCode.trim()) {
    return causeCode.trim();
  }

  return 'UPSTREAM_FETCH_FAILED';
}

function getSafeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '[invalid API_BASE_URL]';
  }
}

/**
 * Makes an authenticated server-to-server HTTP request to the Bun API.
 */
export async function serverApiFetch<T = unknown>(
  path: string,
  options: ServerFetchOptions = {}
): Promise<T> {
  const { method = 'GET', body, params, authToken, onServerTiming } = options;

  return withWebServerSpan(
    `web.api.${method.toLowerCase()} ${path}`,
    {
      'http.request.method': method,
      'http.route': path,
      'http.url_params.count': params ? Object.keys(params).length : 0,
      'web.server.auth.forwarded': Boolean(authToken),
    },
    async () => {
      const runtimeEnv = getWebRuntimeEnv();
      const base = getWebApiBaseUrl(runtimeEnv);

      let url = `${base}${path}`;
      if (params) {
        const search = new URLSearchParams(params);
        url += `?${search.toString()}`;
      }

      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Internal-Service': 'web',
        'X-Internal-Service-Secret': getInternalSecret(),
      };

      if (authToken) {
        headers['X-Auth-Token'] = authToken;
      }

      const forwardedCookieHeader = getForwardedAuthCookieHeader();
      if (forwardedCookieHeader) {
        headers.Cookie = forwardedCookieHeader;
      }

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      propagation.inject(context.active(), headers);

      const activeSpan = trace.getActiveSpan();
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        const code = getErrorCode(error);
        const origin = getSafeOrigin(base);
        const errorOrigin = isWebProductionRuntime(runtimeEnv) ? '[internal API]' : origin;
        activeSpan?.setAttribute('http.request.failed', true);
        activeSpan?.setAttribute('downstream.error_code', code);
        activeSpan?.setAttribute('downstream.origin', origin);
        throw new Error(
          `API ${method} ${path} upstream fetch failed (${code}) while contacting ${errorOrigin}`
        );
      }

      activeSpan?.setAttribute('http.response.status_code', response.status);
      const apiTraceId = response.headers.get('x-trace-id')?.trim();
      if (apiTraceId) {
        activeSpan?.setAttribute('downstream.trace_id', apiTraceId);
      }
      const currentTraceId = getActiveWebServerTraceId();
      if (currentTraceId) {
        activeSpan?.setAttribute('web.trace_id', currentTraceId);
      }
      const serverTimingMetrics = parseServerTimingHeader(response.headers.get('Server-Timing'));
      for (const metric of serverTimingMetrics) {
        activeSpan?.setAttribute(`downstream.server_timing.${metric.name}`, metric.durationMs);
      }
      onServerTiming?.(serverTimingMetrics);

      if (!response.ok) {
        throw new Error(`API ${method} ${path} failed: ${response.status} ${response.statusText}`);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json() as Promise<T>;
    }
  );
}
