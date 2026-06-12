import { getInternalRpcSharedSecret } from '@yucp/shared';
import { filterForwardedAuthCookieHeader } from './forwardedAuthCookies';
import { getWebApiBaseUrl, getWebRuntimeEnv } from './runtimeEnv';

function getApiBaseUrl(): string {
  return getWebApiBaseUrl(getWebRuntimeEnv());
}

function getInternalSecret(): string {
  return getInternalRpcSharedSecret(getWebRuntimeEnv());
}

function copyHeaderIfPresent(source: Headers, target: Headers, headerName: string) {
  const value = source.get(headerName);
  if (value) {
    target.set(headerName, value);
  }
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
  copyHeaderIfPresent(request.headers, headers, 'x-yucp-upload-completion-token');

  const forwardedCookies = filterForwardedAuthCookieHeader(request.headers.get('cookie'));
  if (forwardedCookies) {
    headers.set('Cookie', forwardedCookies);
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
