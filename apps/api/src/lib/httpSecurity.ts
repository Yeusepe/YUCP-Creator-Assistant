const DEFAULT_RESPONSE_SECURITY_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

export function applyResponseSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(DEFAULT_RESPONSE_SECURITY_HEADERS)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  if (
    (contentType.includes('application/json') || contentType.includes('+json')) &&
    !headers.has('Cache-Control')
  ) {
    headers.set('Cache-Control', 'no-store');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
