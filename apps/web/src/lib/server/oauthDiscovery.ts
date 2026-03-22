import { resolveConvexSiteUrl } from '@yucp/shared';

const OAUTH_AUTH_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server/api/auth';

export async function proxyOAuthAuthorizationServerMetadata(request: Request): Promise<Response> {
  const convexSiteUrl = resolveConvexSiteUrl(process.env);
  if (!convexSiteUrl) {
    return new Response(JSON.stringify({ error: 'CONVEX_SITE_URL is required' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const targetUrl = new URL(OAUTH_AUTH_SERVER_METADATA_PATH, convexSiteUrl);
  const headers = new Headers();
  const accept = request.headers.get('accept');
  if (accept) {
    headers.set('accept', accept);
  }

  const upstream = await fetch(targetUrl, {
    method: 'GET',
    headers,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: new Headers(upstream.headers),
  });
}
