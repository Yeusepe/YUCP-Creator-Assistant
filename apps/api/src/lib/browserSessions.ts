export const SETUP_SESSION_COOKIE = 'yucp_setup_session';
export const CONNECT_TOKEN_COOKIE = 'yucp_connect_token';
export const DISCORD_ROLE_SETUP_COOKIE = 'yucp_discord_role_setup';
export const JINXXY_PENDING_WEBHOOK_PREFIX = 'jinxxy_webhook_pending:';
export const JINXXY_PENDING_WEBHOOK_TTL_MS = 30 * 60 * 1000;

export interface BrowserCookieOptions {
  maxAgeSeconds?: number;
  path?: string;
}

function resolveCookieOptions(
  maxAgeSecondsOrOptions?: number | BrowserCookieOptions
): BrowserCookieOptions {
  if (typeof maxAgeSecondsOrOptions === 'number') {
    return { maxAgeSeconds: maxAgeSecondsOrOptions };
  }
  return maxAgeSecondsOrOptions ?? {};
}

export function getCookieValueFromHeader(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) return rest.join('=');
  }
  return null;
}

export function getCookieValue(request: Request, name: string): string | null {
  return getCookieValueFromHeader(request.headers.get('cookie'), name);
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
  maxAgeSecondsOrOptions?: number | BrowserCookieOptions
): string {
  const options = resolveCookieOptions(maxAgeSecondsOrOptions);
  const parts = [`${name}=${value}`, `Path=${options.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (isSecureRequest(request)) parts.push('Secure');
  if (typeof options.maxAgeSeconds === 'number') {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  return parts.join('; ');
}

export function clearCookie(
  name: string,
  request: Request,
  options?: Omit<BrowserCookieOptions, 'maxAgeSeconds'>
): string {
  return buildCookie(name, '', request, { ...options, maxAgeSeconds: 0 });
}
