/**
 * Pure functions for building the trusted browser origins list.
 * Extracted from auth.ts so they can be unit-tested in isolation.
 */

const LOCAL_BROWSER_ORIGIN_PATTERNS = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'https://localhost:*',
  'https://127.0.0.1:*',
];

export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
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
  const configured = all
    .map((v) => normalizeOrigin(v))
    .filter((o): o is string => Boolean(o));

  const hasLoopbackOrigin =
    configured.length === 0 ||
    configured.some((origin) => {
      const { hostname } = new URL(origin);
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    });

  const origins = hasLoopbackOrigin ? [...configured, ...LOCAL_BROWSER_ORIGIN_PATTERNS] : configured;
  return Array.from(new Set(origins));
}
