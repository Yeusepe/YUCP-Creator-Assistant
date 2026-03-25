const FORWARDED_AUTH_COOKIE_NAMES = new Set([
  'yucp.session_token',
  'yucp.session_data',
  'yucp_setup_session',
  'yucp_connect_token',
  'yucp_collab_session',
  'yucp_discord_role_setup',
  'yucp_vrchat_connect_pending',
  '__Secure-yucp.session_token',
  '__Secure-yucp.session_data',
]);

const FORWARDED_SESSION_COOKIE_NAMES = new Set([
  'yucp.session_token',
  'yucp.session_data',
  '__Secure-yucp.session_token',
  '__Secure-yucp.session_data',
]);

function filterCookieHeader(
  cookieHeader: string | null | undefined,
  allowedCookieNames: ReadonlySet<string>
): string | null {
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => allowedCookieNames.has(part.split('=')[0] ?? ''));

  return cookies.length > 0 ? cookies.join('; ') : null;
}

export function filterForwardedAuthCookieHeader(
  cookieHeader: string | null | undefined
): string | null {
  return filterCookieHeader(cookieHeader, FORWARDED_AUTH_COOKIE_NAMES);
}

export function filterForwardedSessionCookieHeader(
  cookieHeader: string | null | undefined
): string | null {
  return filterCookieHeader(cookieHeader, FORWARDED_SESSION_COOKIE_NAMES);
}
