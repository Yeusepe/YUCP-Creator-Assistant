import type { Logger } from '@yucp/shared';
import {
  getSafeRelativeRedirectTarget,
  normalizeAuthRedirectTarget,
} from '@yucp/shared/authRedirects';

export type DiscordSignInFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;
const DEFAULT_AUTH_CALLBACK_PATH = '/sign-in';
const AUTH_CALLBACK_PAGES = new Set(['/sign-in', '/sign-in-redirect']);

interface DiscordSignInBridgeOptions {
  requestUrl: URL;
  callbackURL: string | null;
  allowedBrowserOrigins: ReadonlySet<string>;
  convexSiteUrl: string;
  logger: Logger;
  fetchImpl?: DiscordSignInFetch;
}

export function buildDiscordCallbackUrl(
  browserAuthBaseUrl: string,
  returnTo: string | null | undefined
): string {
  const safeReturnTo = getSafeRelativeRedirectTarget(returnTo) ?? DEFAULT_AUTH_CALLBACK_PATH;
  const callbackUrl = new URL(safeReturnTo, `${browserAuthBaseUrl.replace(/\/$/, '')}/`);

  if (AUTH_CALLBACK_PAGES.has(callbackUrl.pathname)) {
    callbackUrl.searchParams.set(
      'redirectTo',
      normalizeAuthRedirectTarget(callbackUrl.searchParams.get('redirectTo'))
    );
  }

  return callbackUrl.toString();
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleDiscordSignInBridge({
  requestUrl,
  callbackURL,
  allowedBrowserOrigins,
  convexSiteUrl,
  logger,
  fetchImpl = fetch,
}: DiscordSignInBridgeOptions): Promise<Response> {
  if (!callbackURL) {
    logger.warn('Discord sign-in bridge missing callbackURL', { pathname: requestUrl.pathname });
    return jsonError('callbackURL is required', 400);
  }

  let callbackOrigin: string;
  try {
    callbackOrigin = new URL(callbackURL).origin;
  } catch {
    logger.warn('Discord sign-in bridge received malformed callbackURL');
    return jsonError('Invalid callbackURL', 400);
  }

  if (!allowedBrowserOrigins.has(callbackOrigin)) {
    logger.warn('Discord sign-in bridge rejected callbackURL with disallowed origin', {
      callbackOrigin,
    });
    return jsonError('callbackURL origin is not allowed', 400);
  }

  if (!convexSiteUrl) {
    logger.error('Discord sign-in bridge missing CONVEX_SITE_URL');
    return jsonError('CONVEX_SITE_URL must be set', 500);
  }

  logger.info('Starting Discord sign-in bridge', {
    callbackOrigin,
    requestOrigin: requestUrl.origin,
  });

  const authResponse = await fetchImpl(
    `${convexSiteUrl.replace(/\/$/, '')}/api/auth/sign-in/social`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'discord',
        callbackURL,
      }),
    }
  );

  const payloadText = await authResponse.text();
  let payload: { url?: string; error?: { message?: string } } | null = null;
  try {
    payload = payloadText
      ? (JSON.parse(payloadText) as { url?: string; error?: { message?: string } })
      : null;
  } catch {
    logger.warn('Discord sign-in bridge received non-JSON response', {
      status: authResponse.status,
      statusText: authResponse.statusText,
      bodyPreview: payloadText.slice(0, 300),
    });
  }

  const redirectUrl = payload?.url;
  if (!authResponse.ok || !redirectUrl) {
    logger.error('Discord sign-in bridge failed', {
      callbackOrigin,
      status: authResponse.status,
      statusText: authResponse.statusText,
      responseError: payload?.error?.message,
      responseBodyPreview: payloadText.slice(0, 300),
    });
    return jsonError(payload?.error?.message ?? 'Failed to start Discord sign-in', 502);
  }

  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(redirectUrl);
  } catch {
    logger.error('Discord sign-in bridge received invalid redirect URL', {
      callbackOrigin,
      redirectUrl,
    });
    return jsonError('Failed to start Discord sign-in', 502);
  }

  logger.info('Discord sign-in bridge redirecting', {
    callbackOrigin,
    redirectOrigin: parsedRedirect.origin,
    redirectUri: parsedRedirect.searchParams.get('redirect_uri'),
    clientId: parsedRedirect.searchParams.get('client_id'),
    scope: parsedRedirect.searchParams.get('scope'),
  });

  return Response.redirect(parsedRedirect.toString(), 302);
}
