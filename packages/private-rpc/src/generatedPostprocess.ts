const tsNoCheckBanner = '// @ts-nocheck';

export function normalizeGeneratedSource(source: string): string {
  const normalized = source.replace(/\r\n/g, '\n');
  return normalized.startsWith(tsNoCheckBanner) ? normalized : `${tsNoCheckBanner}\n${normalized}`;
}
