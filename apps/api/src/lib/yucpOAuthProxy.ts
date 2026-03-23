/**
 * Native app OAuth authorize bridge for RFC 8252 loopback redirect URIs.
 *
 * Unity and other native clients initiate authorization on the API host, but
 * Better Auth validates redirect URIs against the OAuth client registration on
 * the Convex site. For loopback callbacks we therefore:
 * 1. Store the original loopback redirect URI by state.
 * 2. Redirect Better Auth to the fixed Convex callback URL.
 *
 * RFC 8252 reference: https://datatracker.ietf.org/doc/html/rfc8252#section-7.3
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const STATE_RE = /^[A-Za-z0-9\-_.~]{32,512}$/;

export interface OauthLoopbackSession {
  oauthState: string;
  originalRedirectUri: string;
}

export interface YucpOAuthAuthorizeDeps {
  convexSiteUrl: string;
  storeSession: (session: OauthLoopbackSession) => Promise<void>;
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function isLoopbackRedirectUri(uri: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(uri).hostname);
  } catch {
    return false;
  }
}

export async function handleYucpOAuthAuthorize(
  request: Request,
  deps: YucpOAuthAuthorizeDeps
): Promise<Response> {
  const convexSiteUrl = deps.convexSiteUrl.replace(/\/$/, '');
  if (!convexSiteUrl) {
    return errorResponse('Service not configured', 503);
  }

  const incoming = new URL(request.url);
  const redirectUri = incoming.searchParams.get('redirect_uri');
  const state = incoming.searchParams.get('state');

  if (!redirectUri || !state) {
    return errorResponse('redirect_uri and state are required', 400);
  }

  if (!STATE_RE.test(state)) {
    return errorResponse(
      'state must be at least 32 URL-safe characters (use a cryptographically random value)',
      400
    );
  }

  const target = new URL('/api/auth/oauth2/authorize', `${convexSiteUrl}/`);
  target.search = incoming.search;

  if (!isLoopbackRedirectUri(redirectUri)) {
    return Response.redirect(target.toString(), 302);
  }

  await deps.storeSession({
    oauthState: state,
    originalRedirectUri: redirectUri,
  });

  target.searchParams.set('redirect_uri', `${convexSiteUrl}/api/yucp/oauth/callback`);
  return Response.redirect(target.toString(), 302);
}
