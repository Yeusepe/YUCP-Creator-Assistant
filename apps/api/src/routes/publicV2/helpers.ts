export const API_VERSION = '2025-03-01';

export function generateRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function buildApiHeaders(requestId: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId,
    'RateLimit-Limit': '120',
    'RateLimit-Remaining': '119',
    'RateLimit-Reset': '60',
    'Yucp-Version': API_VERSION,
  };
}

export function jsonResponse(body: unknown, status = 200, requestId?: string): Response {
  const reqId = requestId ?? generateRequestId();
  return new Response(JSON.stringify(body), {
    status,
    headers: buildApiHeaders(reqId),
  });
}

export function errorResponse(
  error: string,
  message: string,
  status: number,
  requestId?: string
): Response {
  const reqId = requestId ?? generateRequestId();
  return jsonResponse({ error, message, requestId: reqId, status }, status, reqId);
}

export function parsePagination(url: URL): { limit: number; cursor: string | undefined } {
  const rawLimit = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const limit = Math.max(1, Math.min(100, Number.isNaN(rawLimit) ? 50 : rawLimit));
  const cursor = url.searchParams.get('starting_after') ?? undefined;
  return { limit, cursor };
}

export function listResponse(
  data: unknown[],
  hasMore: boolean,
  nextCursor: string | null | undefined,
  requestId?: string
): Response {
  const reqId = requestId ?? generateRequestId();
  return jsonResponse(
    { object: 'list', data, hasMore, nextCursor: nextCursor ?? null },
    200,
    reqId
  );
}

export function addApiHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  const apiHeaders = buildApiHeaders(requestId);
  for (const [key, value] of Object.entries(apiHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** Normalises the shape returned by Convex list queries into a standard list payload. */
export function extractListData(result: unknown): {
  data: unknown[];
  hasMore: boolean;
  nextCursor: string | null;
} {
  if (!result || typeof result !== 'object') {
    return { data: [], hasMore: false, nextCursor: null };
  }
  if (Array.isArray(result)) {
    return { data: result, hasMore: false, nextCursor: null };
  }
  const r = result as Record<string, unknown>;
  const data = Array.isArray(r.page)
    ? r.page
    : Array.isArray(r.items)
      ? r.items
      : Array.isArray(r.data)
        ? r.data
        : [];
  const hasMore =
    typeof r.isDone === 'boolean' ? !r.isDone : typeof r.hasMore === 'boolean' ? r.hasMore : false;
  const nextCursor =
    typeof r.continueCursor === 'string'
      ? r.continueCursor
      : typeof r.cursor === 'string'
        ? r.cursor
        : null;
  return { data, hasMore, nextCursor };
}
