const DEFAULT_AUTH_REDIRECT_TARGET = '/dashboard';
const AUTH_LOOP_PATHS = new Set(['/sign-in', '/sign-in-redirect']);
const DASHBOARD_QUERY_KEYS_TO_STRIP = ['guild_id', 'guildId', 'tenant_id', 'authUserId'] as const;

function toRelativeTarget(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

function hasDashboardBootstrapHash(url: URL): boolean {
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  return Boolean(hashParams.get('s') || hashParams.get('token'));
}

// Source: https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html
export function getSafeRelativeRedirectTarget(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (!value.startsWith('/')) {
    return null;
  }

  if (value.startsWith('//')) {
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

  const url = new URL(safeTarget, 'https://auth.invalid');

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
