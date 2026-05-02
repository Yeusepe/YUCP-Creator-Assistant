export function resolveSetupApiBase(raw: string | null, currentOrigin: string): string {
  if (!raw) return currentOrigin;

  try {
    const parsed = new URL(raw, currentOrigin);
    const isHttp = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    if (!isHttp || parsed.origin !== currentOrigin) {
      return currentOrigin;
    }

    const normalizedPath =
      parsed.pathname !== '/' && parsed.pathname.endsWith('/')
        ? parsed.pathname.slice(0, -1)
        : parsed.pathname;

    return `${parsed.origin}${normalizedPath === '/' ? '' : normalizedPath}`;
  } catch {
    return currentOrigin;
  }
}
