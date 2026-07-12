import { getInternalRpcSharedSecret } from '@yucp/shared';
import { filterForwardedAuthCookieHeader } from './forwardedAuthCookies';
import { getWebApiBaseUrl, getWebRuntimeEnv } from './runtimeEnv';

const API_PROXY_REQUEST_BODY_MAX_BYTES = 16 * 1024 * 1024;
const API_PROXY_UPSTREAM_TIMEOUT_MS = 30_000;

class ApiProxyRequestBodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super('Request body too large');
    this.name = 'ApiProxyRequestBodyTooLargeError';
  }
}

class ApiProxyUpstreamTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super('Upstream API request timed out');
    this.name = 'ApiProxyUpstreamTimeoutError';
  }
}

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

function readContentLength(headers: Headers): number | null {
  const parsed = Number.parseInt(headers.get('content-length') ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function readRequestBodyWithLimit(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  const contentLength = readContentLength(request.headers);
  if (contentLength !== null && contentLength > maxBytes) {
    throw new ApiProxyRequestBodyTooLargeError(maxBytes);
  }

  if (!request.body) {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
      throw new ApiProxyRequestBodyTooLargeError(maxBytes);
    }
    return bytes;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel('request body exceeded limit').catch(() => undefined);
        throw new ApiProxyRequestBodyTooLargeError(maxBytes);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bodyBytes.buffer;
}

async function fetchApiTargetWithTimeout(
  targetUrl: URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(targetUrl, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiProxyUpstreamTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
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
  copyHeaderIfPresent(request.headers, headers, 'x-yucp-file-name');
  copyHeaderIfPresent(request.headers, headers, 'x-yucp-media-kind');
  copyHeaderIfPresent(request.headers, headers, 'x-yucp-source-path');

  const forwardedCookies = filterForwardedAuthCookieHeader(request.headers.get('cookie'));
  if (forwardedCookies) {
    headers.set('Cookie', forwardedCookies);
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let body: ArrayBuffer | undefined;
  try {
    body = hasBody
      ? await readRequestBodyWithLimit(request, API_PROXY_REQUEST_BODY_MAX_BYTES)
      : undefined;
  } catch (error) {
    if (error instanceof ApiProxyRequestBodyTooLargeError) {
      return Response.json(
        {
          error: 'Request body too large',
          limitBytes: error.limitBytes,
        },
        { status: 413 }
      );
    }
    throw error;
  }

  let response: Response;
  try {
    const init: RequestInit = {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    };
    response = await fetchApiTargetWithTimeout(targetUrl, init, API_PROXY_UPSTREAM_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof ApiProxyUpstreamTimeoutError) {
      return Response.json(
        {
          error: 'Upstream API request timed out',
          code: 'UPSTREAM_TIMEOUT',
        },
        { status: 504 }
      );
    }

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
