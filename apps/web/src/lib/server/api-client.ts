import { getRequestHeader } from '@tanstack/react-start/server';
import { getInternalRpcSharedSecret } from '@yucp/shared';
import { getToken } from '../auth-server';
import { filterForwardedAuthCookieHeader } from './forwardedAuthCookies';

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

function getApiBaseUrl(): string {
  return process.env.API_BASE_URL || 'http://localhost:3001';
}

function getInternalSecret(): string {
  return getInternalRpcSharedSecret(process.env);
}

interface ServerFetchOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
  /** Pass the user's Convex auth token for user-scoped requests */
  authToken?: string | null;
}

function getForwardedAuthCookieHeader(): string | null {
  try {
    return filterForwardedAuthCookieHeader(getRequestHeader('cookie'));
  } catch {
    return null;
  }
}

/**
 * Makes an authenticated server-to-server HTTP request to the Bun API.
 */
export async function serverApiFetch<T = unknown>(
  path: string,
  options: ServerFetchOptions = {}
): Promise<T> {
  const { method = 'GET', body, params, authToken } = options;
  const base = getApiBaseUrl();

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

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `API ${method} ${path} failed: ${response.status} ${response.statusText} - ${errorBody}`
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Creates a server function that automatically injects the user's auth token.
 * Use this as a base for route-specific server functions.
 */
export async function getAuthenticatedContext() {
  const token = await getToken();
  return { token };
}
