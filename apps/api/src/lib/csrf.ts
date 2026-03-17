/**
 * CSRF protection utilities for GET endpoints that perform state mutations.
 *
 * HTTP GET is a safe, idempotent verb by convention, but some endpoints need to
 * perform writes (e.g., syncing status, ensuring a tenant exists). These writes
 * must not be triggerable by a cross-site request from another origin.
 *
 * Strategy:
 *   1. Sec-Fetch-Site (Fetch Metadata, Chrome 76+, Firefox 90+, Safari 16.4+):
 *      If the browser sets this to 'cross-site', the request is definitively cross-origin
 *      and must be rejected.
 *   2. Origin header (present on all fetch() calls and some form POSTs):
 *      If Origin is present and not in the allowed-origins list, reject.
 *
 * Non-browser callers (server-to-server, curl) do not send these headers, so they
 * are unaffected.
 */

/**
 * Returns a 403 Response if the request appears to be a cross-site browser request,
 * or null if the request should be allowed to proceed.
 *
 * @param request The incoming Request object.
 * @param allowedOrigins The set of origins allowed to trigger this endpoint
 *   (e.g. `new Set([config.baseUrl's origin, config.frontendUrl's origin])`).
 */
export function rejectCrossSiteRequest(
  request: Request,
  allowedOrigins: Set<string>
): Response | null {
  // Sec-Fetch-Site is the most reliable signal — injected by the browser, not the page.
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite === 'cross-site') {
    return new Response(JSON.stringify({ error: 'Cross-site requests are not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Origin header: present on fetch() calls and CORS preflight. If it indicates a
  // foreign origin, reject.
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins.has(origin)) {
    return new Response(JSON.stringify({ error: 'Cross-site requests are not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}
