const tsNoCheckBanner = '// @ts-nocheck';

export function normalizeGeneratedSource(source: string): string {
  const normalized = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.startsWith(tsNoCheckBanner) ? normalized : `${tsNoCheckBanner}\n${normalized}`;
}
