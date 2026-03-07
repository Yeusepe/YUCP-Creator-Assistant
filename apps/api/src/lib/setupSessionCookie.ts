const SETUP_SESSION_COOKIE = 'yucp_setup_session';

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) return rest.join('=');
  }
  return null;
}

export function readSetupSessionCookie(request: Request): string | null {
  return getCookieValue(request.headers.get('cookie'), SETUP_SESSION_COOKIE);
}

export function buildSetupSessionCookie(
  request: Request,
  value: string,
  maxAgeSeconds = 60 * 60,
): string {
  const isSecure = new URL(request.url).protocol === 'https:';
  const parts = [
    `${SETUP_SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSetupSessionCookie(request: Request): string {
  return buildSetupSessionCookie(request, '', 0);
}

export function stripSetupParams(url: URL): URL {
  const redirectUrl = new URL(url);
  redirectUrl.searchParams.delete('s');
  redirectUrl.searchParams.delete('token');
  redirectUrl.searchParams.delete('tenant_id');
  redirectUrl.searchParams.delete('tenantId');
  redirectUrl.searchParams.delete('guild_id');
  redirectUrl.searchParams.delete('guildId');
  return redirectUrl;
}

