export function normalizePublicApiBaseUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim();
  if (!trimmed) {
    throw new Error('API_BASE_URL is required');
  }

  const url = new URL(trimmed);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API_BASE_URL must use http or https');
  }

  return url.toString().replace(/\/$/, '');
}

export function resolveConfiguredApiBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const configured = env.API_BASE_URL?.trim();
  if (!configured) {
    return '';
  }

  try {
    return normalizePublicApiBaseUrl(configured);
  } catch {
    return '';
  }
}

export function buildPublicAuthIssuer(apiBaseUrl: string): string {
  return `${normalizePublicApiBaseUrl(apiBaseUrl)}/api/auth`;
}
