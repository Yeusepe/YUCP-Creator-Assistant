const LOCAL_BROWSER_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
] as const;

const LOCAL_BROWSER_ORIGIN_PATTERNS = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'https://localhost:*',
  'https://127.0.0.1:*',
] as const;

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function shouldTrustLocalBrowserOrigins(
  origins: ReadonlyArray<string | null | undefined>
): boolean {
  const normalizedOrigins = origins
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin));

  if (normalizedOrigins.length === 0) {
    return true;
  }

  return normalizedOrigins.some((origin) => isLoopbackHostname(new URL(origin).hostname));
}

function dedupe(values: ReadonlyArray<string>): string[] {
  return Array.from(new Set(values));
}

export function buildAllowedBrowserOrigins({
  siteUrl,
  frontendUrl,
  additionalOrigins = [],
}: Readonly<{
  siteUrl?: string | null;
  frontendUrl?: string | null;
  additionalOrigins?: ReadonlyArray<string | null | undefined>;
}>): string[] {
  const configuredOrigins = [siteUrl, frontendUrl, ...additionalOrigins]
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin));

  if (shouldTrustLocalBrowserOrigins([siteUrl, frontendUrl, ...additionalOrigins])) {
    return dedupe([...configuredOrigins, ...LOCAL_BROWSER_ORIGINS]);
  }

  return dedupe(configuredOrigins);
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
  const configuredOrigins = [siteUrl, frontendUrl, ...additionalOrigins]
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin));

  if (shouldTrustLocalBrowserOrigins([siteUrl, frontendUrl, ...additionalOrigins])) {
    return dedupe([...configuredOrigins, ...LOCAL_BROWSER_ORIGIN_PATTERNS]);
  }

  return dedupe(configuredOrigins);
}
