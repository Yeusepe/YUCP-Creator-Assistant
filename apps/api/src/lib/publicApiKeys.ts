import { randomBytes } from 'node:crypto';

export const PUBLIC_API_KEY_PREFIX = 'ypsk_';

export function generatePublicApiKeyValue(prefix = PUBLIC_API_KEY_PREFIX): string {
  return `${prefix}${randomBytes(24).toString('hex')}`;
}

export function getPublicApiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, Math.min(apiKey.length, PUBLIC_API_KEY_PREFIX.length + 8));
}
