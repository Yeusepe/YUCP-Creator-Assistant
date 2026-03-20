function normalizeUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(/\/$/, '');
}

export function resolveConvexSiteUrl(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const explicit = normalizeUrl(env.CONVEX_SITE_URL);
  if (explicit) {
    return explicit;
  }

  const convexUrl = normalizeUrl(env.CONVEX_URL);
  if (!convexUrl) {
    return undefined;
  }

  return convexUrl.replace('.convex.cloud', '.convex.site');
}
