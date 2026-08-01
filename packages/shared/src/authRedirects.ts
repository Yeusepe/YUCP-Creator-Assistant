const DEFAULT_AUTH_REDIRECT_TARGET = '/dashboard';
const AUTH_REDIRECT_ORIGIN = 'https://auth.invalid';
const AUTH_LOOP_PATHS = new Set(['/sign-in', '/sign-in-redirect']);
const DASHBOARD_QUERY_KEYS_TO_STRIP = ['guild_id', 'guildId', 'tenant_id', 'authUserId'] as const;

function toRelativeTarget(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

function hasDashboardBootstrapHash(url: URL): boolean {
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  return Boolean(hashParams.get('s') || hashParams.get('token'));
}

function resolvesToAuthRedirectOrigin(value: string): boolean {
  try {
    return (
      new URL(value.replaceAll('\\', '/'), AUTH_REDIRECT_ORIGIN).origin === AUTH_REDIRECT_ORIGIN
    );
  } catch {
    return false;
  }
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * A native client's own loopback callback, the only absolute redirect target we accept.
 * The package broker opens a browser page and listens on 127.0.0.1 for the buyer to come
 * back, the same shape its OAuth callback already uses. Loopback is not an open-redirect
 * vector: the browser can only reach a listener on the buyer's own machine.
 */
export function getSafeLoopbackRedirectTarget(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return null;
  }
  if (url.username || url.password) {
    return null;
  }
  return url.toString();
}

// Source: https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html
export function getSafeRelativeRedirectTarget(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (!value.startsWith('/')) {
    return null;
  }

  if (!resolvesToAuthRedirectOrigin(value)) {
    return null;
  }

  try {
    if (!resolvesToAuthRedirectOrigin(decodeURIComponent(value))) {
      return null;
    }
  } catch {
    return null;
  }

  return value;
}

export function normalizeAuthRedirectTarget(
  value: string | null | undefined,
  fallback = DEFAULT_AUTH_REDIRECT_TARGET
): string {
  const safeTarget = getSafeRelativeRedirectTarget(value);
  if (!safeTarget) {
    return fallback;
  }

  const url = new URL(safeTarget, AUTH_REDIRECT_ORIGIN);

  if (AUTH_LOOP_PATHS.has(url.pathname)) {
    return fallback;
  }

  if (
    (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) &&
    !hasDashboardBootstrapHash(url)
  ) {
    for (const key of DASHBOARD_QUERY_KEYS_TO_STRIP) {
      url.searchParams.delete(key);
    }
  }

  return toRelativeTarget(url) || fallback;
}
