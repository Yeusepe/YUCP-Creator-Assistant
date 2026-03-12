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

export async function readJsonResponse<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
