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
    super(`API error ${status}`);
    this.name = 'ApiError';
  }
}

async function apiFetch<T = unknown>(path: string, options: FetchOptions = {}): Promise<T> {
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
  headers.set('Accept', 'application/json');

  const response = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const requestId = response.headers.get('X-Request-Id') ?? undefined;
    throw new ApiError(response.status, body, requestId);
  }

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

  delete: <T = unknown>(path: string, opts?: FetchOptions) =>
    apiFetch<T>(path, { ...opts, method: 'DELETE' }),
};

export { ApiError, apiFetch, apiClient };
export type { FetchOptions };
