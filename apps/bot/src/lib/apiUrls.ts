/**
 * API URL resolution for bot → API communication.
 *
 * - apiInternal: For server-to-server fetch() calls. Use Zeabur private hostname when set for faster, in-network traffic.
 * - apiPublic: Public API origin used for bot -> API HTTP requests when no internal URL exists.
 * - webPublic: User-facing frontend origin for links users open in their browser.
 *   This must be an actual frontend origin, never an API fallback.
 */

export function getApiUrls(): {
  apiInternal: string | undefined;
  apiPublic: string | undefined;
  webPublic: string | undefined;
} {
  const apiPublic = process.env.API_BASE_URL;
  const apiInternal = process.env.API_INTERNAL_URL ?? apiPublic;
  const webPublic = process.env.FRONTEND_URL ?? process.env.VERIFY_BASE_URL;
  return { apiInternal, apiPublic, webPublic };
}

function normalizeApiBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/$/, '');
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a bot-to-API request target with explicit transport requirements.
 * Requests carrying credentials or Discord interaction tokens must require TLS.
 */
export function resolveApiRequestBaseUrl(options?: {
  fallback?: string;
  preferPublic?: boolean;
  requireTls?: boolean;
}): string | undefined {
  const { apiInternal, apiPublic } = getApiUrls();
  const candidates = options?.preferPublic
    ? [apiPublic, options.fallback, apiInternal]
    : [apiInternal, apiPublic, options?.fallback];
  const uniqueCandidates = [
    ...new Set(candidates.map(normalizeApiBaseUrl).filter((value): value is string => !!value)),
  ];

  if (options?.requireTls) {
    return uniqueCandidates.find((value) => new URL(value).protocol === 'https:');
  }

  return uniqueCandidates[0];
}
