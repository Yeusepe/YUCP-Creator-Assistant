import { addHyperdxAction, captureHyperdxException } from '@/lib/hyperdx';
import { getDiagnosticsRequestHeaders } from '@/lib/privacyPreferences';

const API_BASE = '';

type FetchOptions = RequestInit & {
  params?: Record<string, string>;
};

class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    public requestId?: string
  ) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `API error ${status}`;
    super(message);
    this.name = 'ApiError';
  }
}

interface ServerTimingMetric {
  name: string;
  durationMs?: number;
}

function inferApiRouteCategory(path: string): string {
  const normalized = path.replace(/^\/+/, '').replace(/^api\/?/, '');
  const [firstSegment = 'root', secondSegment] = normalized.split('/');

  if (firstSegment === 'internal' && secondSegment) {
    return `internal.${secondSegment}`;
  }

  return firstSegment || 'root';
}

function toActionAttributes(
  attributes: Record<string, string | number | boolean | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)])
  );
}

export function parseServerTimingHeader(headerValue: string | null): ServerTimingMetric[] {
  if (!headerValue) {
    return [];
  }

  return headerValue
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [rawName, ...parts] = entry.split(';').map((part) => part.trim());
      const durationPart = parts.find((part) => part.startsWith('dur='));
      const rawDuration = durationPart ? Number.parseFloat(durationPart.slice(4)) : undefined;
      return {
        name: rawName,
        durationMs: Number.isFinite(rawDuration) ? rawDuration : undefined,
      };
    });
}

export async function fetchWithDiagnostics(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const requestUrl =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const parsedUrl = new URL(requestUrl, window.location.origin);
  const path = parsedUrl.pathname;
  const method = init.method ?? (input instanceof Request ? input.method : 'GET');
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [name, value] of new Headers(init.headers).entries()) {
    headers.set(name, value);
  }
  if (parsedUrl.origin === window.location.origin) {
    for (const [name, value] of Object.entries(getDiagnosticsRequestHeaders())) {
      headers.set(name, value);
    }
  }

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(input, { ...init, headers });
  } catch (error) {
    captureHyperdxException(error, {
      path,
      method,
      routeCategory: inferApiRouteCategory(path),
      networkFailure: true,
    });
    throw error;
  }

  const durationMs = Number((performance.now() - startedAt).toFixed(2));
  const requestId = response.headers.get('X-Request-Id') ?? 'unknown';
  const attributes = toActionAttributes({
    path,
    method,
    status: response.status,
    durationMs,
    requestId,
  });
  addHyperdxAction('first-party.request.completed', attributes);

  if (!response.ok) {
    captureHyperdxException(
      new Error(`First-party request failed with status ${response.status}`),
      {
        path,
        method,
        status: String(response.status),
        durationMs,
        requestId,
      }
    );
    addHyperdxAction('first-party.request.failed', attributes);
  }

  return response;
}

async function apiRequest(path: string, options: FetchOptions = {}): Promise<Response> {
  const { params, ...init } = options;

  let url = `${API_BASE}${path}`;
  if (params) {
    const search = new URLSearchParams(params);
    url += `?${search.toString()}`;
  }

  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  for (const [name, value] of Object.entries(getDiagnosticsRequestHeaders())) {
    headers.set(name, value);
  }
  const method = init.method ?? 'GET';
  const routeCategory = inferApiRouteCategory(path);
  const startedAt = performance.now();

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      credentials: 'include',
    });
  } catch (error) {
    captureHyperdxException(error, {
      path,
      method,
      routeCategory,
      networkFailure: true,
    });
    throw error;
  }
  const durationMs = Number((performance.now() - startedAt).toFixed(2));
  const requestId = response.headers.get('X-Request-Id') ?? undefined;
  const serverTimingMetrics = parseServerTimingHeader(response.headers.get('Server-Timing'));
  const serverTimingTotalMs = serverTimingMetrics.find(
    (metric) => metric.name === 'total'
  )?.durationMs;

  addHyperdxAction(
    'api.request.completed',
    toActionAttributes({
      path,
      method,
      routeCategory,
      requestId: requestId ?? 'unknown',
      status: response.status,
      durationMs,
      serverTimingStageCount: serverTimingMetrics.length,
      serverTimingTotalMs,
    })
  );

  for (const metric of serverTimingMetrics) {
    addHyperdxAction(
      'api.request.stage',
      toActionAttributes({
        path,
        method,
        routeCategory,
        requestId: requestId ?? 'unknown',
        stage: metric.name,
        durationMs: metric.durationMs,
      })
    );
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new ApiError(response.status, body, requestId);
    captureHyperdxException(error, {
      path,
      method,
      routeCategory,
      requestId: requestId ?? 'unknown',
      status: String(response.status),
      durationMs,
      serverTimingTotalMs,
    });
    addHyperdxAction(
      'api.request.failed',
      toActionAttributes({
        path,
        method,
        routeCategory,
        requestId: requestId ?? 'unknown',
        status: response.status,
        durationMs,
        serverTimingTotalMs,
      })
    );
    throw error;
  }

  return response;
}

async function apiFetch<T = unknown>(path: string, options: FetchOptions = {}): Promise<T> {
  const response = await apiRequest(path, options);

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

const apiClient = {
  get: <T = unknown>(path: string, opts?: FetchOptions) =>
    apiFetch<T>(path, { ...opts, method: 'GET' }),

  post: <T = unknown>(path: string, body?: unknown, opts?: FetchOptions) =>
    apiFetch<T>(path, {
      ...opts,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...(opts?.headers as Record<string, string>),
      },
    }),

  put: <T = unknown>(path: string, body?: unknown, opts?: FetchOptions) =>
    apiFetch<T>(path, {
      ...opts,
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...(opts?.headers as Record<string, string>),
      },
    }),

  patch: <T = unknown>(path: string, body?: unknown, opts?: FetchOptions) =>
    apiFetch<T>(path, {
      ...opts,
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...(opts?.headers as Record<string, string>),
      },
    }),

  delete: <T = unknown>(path: string, opts?: FetchOptions) =>
    apiFetch<T>(path, { ...opts, method: 'DELETE' }),

  blob: async (path: string, opts?: FetchOptions) => {
    const response = await apiRequest(path, {
      ...opts,
      method: 'GET',
      headers: {
        Accept: 'application/octet-stream, application/zip, application/gzip',
        ...(opts?.headers as Record<string, string>),
      },
    });
    return {
      blob: await response.blob(),
      contentDisposition: response.headers.get('Content-Disposition'),
    };
  },
};

export { ApiError, apiFetch, apiClient };
export type { FetchOptions };
