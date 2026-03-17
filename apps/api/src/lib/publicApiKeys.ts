import { createHmac, randomBytes } from 'node:crypto';

export const PUBLIC_API_KEY_PREFIX = 'ypsk_';

export function generatePublicApiKeyValue(prefix = PUBLIC_API_KEY_PREFIX): string {
  return `${prefix}${randomBytes(24).toString('hex')}`;
}

export function getPublicApiKeyPepper(): string {
  const pepper = process.env.PUBLIC_API_KEY_PEPPER;
  if (!pepper) {
    throw new Error('PUBLIC_API_KEY_PEPPER must be set');
  }
  return pepper;
}

export function hashPublicApiKey(apiKey: string, pepper = getPublicApiKeyPepper()): string {
  return createHmac('sha256', pepper).update(apiKey).digest('hex');
}

export function getPublicApiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, Math.min(apiKey.length, PUBLIC_API_KEY_PREFIX.length + 8));
}
