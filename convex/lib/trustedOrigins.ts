/**
 * Pure functions for building the trusted browser origins list.
 * Extracted from auth.ts so they can be unit-tested in isolation.
 */

const LOCAL_TRUSTED_BROWSER_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
  'https://localhost:3000',
  'https://localhost:3001',
  'https://localhost:5173',
  'https://127.0.0.1:3000',
  'https://127.0.0.1:3001',
  'https://127.0.0.1:5173',
];

export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function parseConfiguredTrustedOrigins(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error('The configured trusted origins must be valid JSON');
  }
  if (!Array.isArray(decoded) || decoded.length > 16) {
    throw new Error('The configured trusted origins must be one bounded array');
  }
  const origins = decoded.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 2048) {
      throw new Error('The configured trusted origins contain an invalid value');
    }
    const normalized = normalizeOrigin(entry);
    if (!normalized || normalized !== entry) {
      throw new Error('The configured trusted origins must contain canonical HTTP origins');
    }
    const parsed = new URL(normalized);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('The configured trusted origins must contain canonical HTTP origins');
    }
    return normalized;
  });
  if (new Set(origins).size !== origins.length) {
    throw new Error('The configured trusted origins must be unique');
  }
  return origins;
}

export function buildTrustedBrowserOrigins({
  siteUrl,
  frontendUrl,
  additionalOrigins = [],
}: Readonly<{
  siteUrl?: string | null;
  frontendUrl?: string | null;
  additionalOrigins?: ReadonlyArray<string | null | undefined>;
}>): string[] {
  const all = [siteUrl, frontendUrl, ...additionalOrigins];
  const configured = all.map((v) => normalizeOrigin(v)).filter((o): o is string => Boolean(o));

  const hasLoopbackOrigin =
    configured.length === 0 ||
    configured.some((origin) => {
      const { hostname } = new URL(origin);
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    });

  const origins = hasLoopbackOrigin
    ? [...configured, ...LOCAL_TRUSTED_BROWSER_ORIGINS]
    : configured;
  return Array.from(new Set(origins));
}
