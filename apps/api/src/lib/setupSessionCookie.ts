import { buildCookie, clearCookie, getCookieValue, SETUP_SESSION_COOKIE } from './browserSessions';

export function readSetupSessionCookie(request: Request): string | null {
  return getCookieValue(request, SETUP_SESSION_COOKIE);
}

export function buildSetupSessionCookie(
  request: Request,
  value: string,
  maxAgeSeconds = 60 * 60
): string {
  return buildCookie(SETUP_SESSION_COOKIE, value, request, maxAgeSeconds);
}

export function clearSetupSessionCookie(request: Request): string {
  return clearCookie(SETUP_SESSION_COOKIE, request);
}

export function stripSetupParams(url: URL): URL {
  const redirectUrl = new URL(url);
  redirectUrl.searchParams.delete('s');
  redirectUrl.searchParams.delete('token');
  redirectUrl.searchParams.delete('tenant_id');
  redirectUrl.searchParams.delete('tenantId');
  redirectUrl.searchParams.delete('authUserId');
  redirectUrl.searchParams.delete('auth_user_id');
  redirectUrl.searchParams.delete('guild_id');
  redirectUrl.searchParams.delete('guildId');
  return redirectUrl;
}
