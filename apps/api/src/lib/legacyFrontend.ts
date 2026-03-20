export const LEGACY_FRONTEND_MESSAGE = 'This UI route has moved to the TanStack web app.';

export const HTML_RESPONSE_SECURITY_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

export function createLegacyFrontendMovedResponse(
  message: string = LEGACY_FRONTEND_MESSAGE
): Response {
  const safeMessage = escapeHtml(message);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Page not found</title></head><body><main><h1>Page not found</h1><p>${safeMessage}</p></main></body></html>`,
    {
      status: 404,
      headers: HTML_RESPONSE_SECURITY_HEADERS,
    }
  );
}

export function isLegacyFrontendAsset(pathname: string): boolean {
  return pathname === '/assets/dashboard' || pathname.startsWith('/assets/dashboard/');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
