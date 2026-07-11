import { addHyperdxAction, captureHyperdxException } from '@/lib/hyperdx';

const API_BASE = '';

type FetchOptions = RequestInit & {
  params?: Record<string, string>;
};

type UploadOptions = {
  headers?: HeadersInit;
  onProgress?: (progress: { loaded: number; total: number }) => void;
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

function buildApiUrl(path: string, params?: Record<string, string>): string {
  const url = `${API_BASE}${path}`;
  if (!params) {
    return url;
  }
  const search = new URLSearchParams(params);
  return `${url}?${search.toString()}`;
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

async function apiFetch<T = unknown>(path: string, options: FetchOptions = {}): Promise<T> {
  const { params, ...init } = options;
  const url = buildApiUrl(path, params);

  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');
  const method = init.method ?? 'GET';
  const routeCategory = inferApiRouteCategory(path);
  const startedAt = performance.now();

  const response = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
  });
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

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function apiUpload<T = unknown>(
  path: string,
  body: XMLHttpRequestBodyInit,
  options: UploadOptions = {}
): Promise<T> {
  const url = buildApiUrl(path, options.params);
  const method = 'POST';
  const routeCategory = inferApiRouteCategory(path);
  const startedAt = performance.now();

  return await new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url);
    request.withCredentials = true;
    request.setRequestHeader('Accept', 'application/json');
    const headers = new Headers(options.headers);
    headers.forEach((value, name) => {
      request.setRequestHeader(name, value);
    });
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        options.onProgress?.({ loaded: event.loaded, total: event.total });
      }
    };
    request.onload = () => {
      const durationMs = Number((performance.now() - startedAt).toFixed(2));
      const requestId = request.getResponseHeader('X-Request-Id') ?? undefined;
      const serverTimingMetrics = parseServerTimingHeader(
        request.getResponseHeader('Server-Timing')
      );
      const serverTimingTotalMs = serverTimingMetrics.find(
        (metric) => metric.name === 'total'
      )?.durationMs;
      const attributes = toActionAttributes({
        path,
        method,
        routeCategory,
        requestId: requestId ?? 'unknown',
        status: request.status,
        durationMs,
        serverTimingStageCount: serverTimingMetrics.length,
        serverTimingTotalMs,
      });
      addHyperdxAction('api.request.completed', attributes);
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

      let responseBody: unknown = null;
      if (request.responseText) {
        try {
          responseBody = JSON.parse(request.responseText);
        } catch (error) {
          if (request.status >= 200 && request.status < 300) {
            reject(error);
            return;
          }
        }
      }
      if (request.status < 200 || request.status >= 300) {
        const apiError = new ApiError(request.status, responseBody, requestId);
        captureHyperdxException(apiError, attributes);
        addHyperdxAction('api.request.failed', attributes);
        reject(apiError);
        return;
      }
      resolve(responseBody as T);
    };
    request.onerror = () => {
      const error = new Error('API upload request failed');
      captureHyperdxException(error, {
        path,
        method,
        routeCategory,
      });
      reject(error);
    };
    request.send(body);
  });
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

  upload: <T = unknown>(path: string, body: XMLHttpRequestBodyInit, opts?: UploadOptions) =>
    apiUpload<T>(path, body, opts),

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
};

export { ApiError, apiFetch, apiClient };
export type { FetchOptions, UploadOptions };
