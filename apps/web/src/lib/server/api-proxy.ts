import { getInternalRpcSharedSecret } from '@yucp/shared';
import { filterForwardedAuthCookieHeader } from './forwardedAuthCookies';
import { getWebApiBaseUrl, getWebRuntimeEnv } from './runtimeEnv';

const API_PROXY_REQUEST_BODY_MAX_BYTES = 16 * 1024 * 1024;
const API_PROXY_UPSTREAM_TIMEOUT_MS = 30_000;
const FORENSICS_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
const FORENSICS_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const FORENSICS_PROXY_REQUEST_BODY_MAX_BYTES =
  FORENSICS_ARCHIVE_MAX_BYTES + FORENSICS_MULTIPART_OVERHEAD_BYTES;
/**
 * A trace scans every buyer of a package one batch at a time, so its cost grows
 * with the catalogue rather than with the upload. This must stay above the
 * API's own scan budget plus its reveal budget, or the proxy cuts the request
 * off before the scan can report the partial verdict it was designed to give:
 * an earlier 120 s ceiling turned a 141 s scan into a bare 504 and discarded
 * twelve batches of completed work.
 */
const FORENSICS_PROXY_UPSTREAM_TIMEOUT_MS = 540_000;

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

function getRequestBodyLimit(pathname: string): number {
  return pathname === '/api/forensics/lookup'
    ? FORENSICS_PROXY_REQUEST_BODY_MAX_BYTES
    : API_PROXY_REQUEST_BODY_MAX_BYTES;
}

function getUpstreamTimeout(pathname: string): number {
  return pathname === '/api/forensics/lookup'
    ? FORENSICS_PROXY_UPSTREAM_TIMEOUT_MS
    : API_PROXY_UPSTREAM_TIMEOUT_MS;
}

async function createBoundedRequestBody(
  request: Request,
  maxBytes: number
): Promise<{
  body: ArrayBuffer | ReadableStream<Uint8Array> | undefined;
  exceededLimit: () => boolean;
}> {
  const contentLength = readContentLength(request.headers);
  if (contentLength !== null && contentLength > maxBytes) {
    throw new ApiProxyRequestBodyTooLargeError(maxBytes);
  }

  if (!request.body) {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
      throw new ApiProxyRequestBodyTooLargeError(maxBytes);
    }
    return {
      body: bytes,
      exceededLimit: () => false,
    };
  }

  let limitExceeded = false;
  let byteLength = 0;
  const body = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        byteLength += chunk.byteLength;
        if (byteLength > maxBytes) {
          limitExceeded = true;
          controller.error(new ApiProxyRequestBodyTooLargeError(maxBytes));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );

  return {
    body,
    exceededLimit: () => limitExceeded,
  };
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
  headers.set('X-YUCP-Public-Host', url.host);

  copyHeaderIfPresent(request.headers, headers, 'content-type');
  copyHeaderIfPresent(request.headers, headers, 'idempotency-key');
  copyHeaderIfPresent(request.headers, headers, 'x-yucp-upload-completion-token');
  copyHeaderIfPresent(request.headers, headers, 'x-yucp-file-name');
  copyHeaderIfPresent(request.headers, headers, 'x-yucp-media-kind');
  copyHeaderIfPresent(request.headers, headers, 'x-yucp-source-path');
  copyHeaderIfPresent(request.headers, headers, 'traceparent');
  copyHeaderIfPresent(request.headers, headers, 'tracestate');
  copyHeaderIfPresent(request.headers, headers, 'x-yucp-diagnostics-session');

  const forwardedCookies = filterForwardedAuthCookieHeader(request.headers.get('cookie'));
  if (forwardedCookies) {
    headers.set('Cookie', forwardedCookies);
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const requestBodyLimit = getRequestBodyLimit(url.pathname);
  let boundedBody: Awaited<ReturnType<typeof createBoundedRequestBody>> = {
    body: undefined,
    exceededLimit: () => false,
  };
  try {
    boundedBody = hasBody ? await createBoundedRequestBody(request, requestBodyLimit) : boundedBody;
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
    response = await fetchApiTargetWithTimeout(
      targetUrl,
      {
        method: request.method,
        headers,
        body: boundedBody.body,
        redirect: 'manual',
      },
      getUpstreamTimeout(url.pathname)
    );
  } catch (error) {
    if (boundedBody.exceededLimit()) {
      return Response.json(
        {
          error: 'Request body too large',
          limitBytes: requestBodyLimit,
        },
        { status: 413 }
      );
    }
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
