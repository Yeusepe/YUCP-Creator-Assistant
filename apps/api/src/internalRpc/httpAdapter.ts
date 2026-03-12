export function createJsonRequest(
  url: string,
  body: unknown,
  init?: {
    headers?: HeadersInit;
    method?: string;
  }
): Request {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  return new Request(url, {
    method: init?.method ?? 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

export type ReadJsonResponseOptions = {
  allowErrorStatuses?: number[];
};

type RpcHttpError = Error & {
  body?: unknown;
  status?: number;
  statusText?: string;
};

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return await response.text();
  }
  return await response.json();
}

function buildHttpError(response: Response, body: unknown): RpcHttpError {
  const error = new Error(
    `Request failed with status ${response.status} ${response.statusText}`
  ) as RpcHttpError;
  error.status = response.status;
  error.statusText = response.statusText;
  error.body = body;
  return error;
}

/**
 * Reads a JSON response, throwing for unexpected transport failures while still
 * allowing selected non-2xx business-response statuses to flow through.
 */
export async function readJsonResponse<T>(
  response: Response,
  options?: ReadJsonResponseOptions
): Promise<T> {
  const body = await parseResponseBody(response);
  const allowErrorStatuses = new Set(options?.allowErrorStatuses ?? []);
  if (!response.ok && !allowErrorStatuses.has(response.status)) {
    throw buildHttpError(response, body);
  }

  return body as T;
}
