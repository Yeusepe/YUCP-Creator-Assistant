export const SETUP_SESSION_COOKIE = 'yucp_setup_session';
export const CONNECT_TOKEN_COOKIE = 'yucp_connect_token';
export const DISCORD_ROLE_SETUP_COOKIE = 'yucp_discord_role_setup';
export const JINXXY_PENDING_WEBHOOK_PREFIX = 'jinxxy_webhook_pending:';
export const JINXXY_PENDING_WEBHOOK_TTL_MS = 30 * 60 * 1000;

export function getCookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) return rest.join('=');
  }
  return null;
}

function isSecureRequest(request: Request): boolean {
  // In production, always set Secure regardless of headers — the proxy is trusted to
  // handle TLS termination. Relying on x-forwarded-proto lets any client that reaches
  // the service directly set the attribute arbitrarily.
  if (process.env.NODE_ENV === 'production') return true;

  const url = new URL(request.url);
  const forwardedProto = request.headers.get('x-forwarded-proto');
  return (
    url.protocol === 'https:' ||
    forwardedProto?.split(',').some((value) => value.trim() === 'https') === true
  );
}

export function buildCookie(
  name: string,
  value: string,
  request: Request,
  maxAgeSeconds?: number
): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isSecureRequest(request)) parts.push('Secure');
  if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export function clearCookie(name: string, request: Request): string {
  return buildCookie(name, '', request, 0);
}
