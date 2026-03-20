import { getInternalRpcSharedSecret } from '@yucp/shared';
import { getToken } from '../auth-server';

const FORWARDED_COOKIE_NAMES = new Set([
  'yucp.session_token',
  'yucp.session_data',
  'yucp_setup_session',
  'yucp_connect_token',
  'yucp_collab_session',
  'yucp_discord_role_setup',
  'yucp_vrchat_connect_pending',
  '__Secure-yucp.session_token',
  '__Secure-yucp.session_data',
]);

function getApiBaseUrl(): string {
  return process.env.API_BASE_URL || 'http://localhost:3001';
}

function getInternalSecret(): string {
  return getInternalRpcSharedSecret(process.env);
}

function copyHeaderIfPresent(source: Headers, target: Headers, headerName: string) {
  const value = source.get(headerName);
  if (value) {
    target.set(headerName, value);
  }
}

function filterForwardedCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => FORWARDED_COOKIE_NAMES.has(part.split('=')[0] ?? ''));

  return cookies.length > 0 ? cookies.join('; ') : null;
}

export async function proxyApiRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/auth')) {
    return new Response('Not found', { status: 404 });
  }

  const targetUrl = new URL(url.pathname + url.search, getApiBaseUrl());
  const headers = new Headers();
  headers.set('Accept', request.headers.get('accept') ?? 'application/json');
  headers.set('X-Internal-Service', 'web');
  headers.set('X-Internal-Service-Secret', getInternalSecret());

  copyHeaderIfPresent(request.headers, headers, 'content-type');
  copyHeaderIfPresent(request.headers, headers, 'idempotency-key');

  const forwardedCookies = filterForwardedCookieHeader(request.headers.get('cookie'));
  if (forwardedCookies) {
    headers.set('Cookie', forwardedCookies);
  }

  const authToken = await getToken();
  if (authToken) {
    headers.set('X-Auth-Token', authToken);
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    const code =
      cause && 'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'UPSTREAM_FETCH_FAILED';

    return Response.json(
      {
        error: 'Upstream API request failed',
        code,
      },
      { status: 502 }
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
