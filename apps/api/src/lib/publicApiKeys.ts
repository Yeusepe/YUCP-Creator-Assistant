import { randomBytes } from 'node:crypto';

export const PUBLIC_API_KEY_PREFIX = 'ypsk_';
const PUBLIC_API_KEY_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export function generatePublicApiKeyValue(prefix = PUBLIC_API_KEY_PREFIX): string {
  return `${prefix}${randomBytes(24).toString('hex')}`;
}

export function getPublicApiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, Math.min(apiKey.length, PUBLIC_API_KEY_PREFIX.length + 8));
}

/**
 * Performs only a bounded transport-shape check before the managed key store
 * performs authoritative verification. The suffix is intentionally opaque so
 * both legacy hex keys and the configured Better Auth generator remain valid.
 */
export function isPublicApiKeyCandidate(apiKey: string): boolean {
  return (
    apiKey.startsWith(PUBLIC_API_KEY_PREFIX) &&
    PUBLIC_API_KEY_SUFFIX_PATTERN.test(apiKey.slice(PUBLIC_API_KEY_PREFIX.length))
  );
}
