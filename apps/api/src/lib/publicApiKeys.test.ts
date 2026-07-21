import { describe, expect, it } from 'bun:test';
import {
  generatePublicApiKeyValue,
  getPublicApiKeyPrefix,
  isPublicApiKeyCandidate,
  PUBLIC_API_KEY_PREFIX,
} from './publicApiKeys';

describe('publicApiKeys', () => {
  it('generates prefixed API keys', () => {
    const key = generatePublicApiKeyValue();
    expect(key.startsWith(PUBLIC_API_KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThan(PUBLIC_API_KEY_PREFIX.length);
  });

  it('returns a short display prefix', () => {
    const key = `${PUBLIC_API_KEY_PREFIX}0123456789abcdef`;
    expect(getPublicApiKeyPrefix(key)).toBe(`${PUBLIC_API_KEY_PREFIX}01234567`);
  });

  it('accepts legacy and Better Auth opaque key suffixes for authoritative verification', () => {
    expect(isPublicApiKeyCandidate(`${PUBLIC_API_KEY_PREFIX}${'a'.repeat(48)}`)).toBe(true);
    expect(isPublicApiKeyCandidate(`${PUBLIC_API_KEY_PREFIX}${'Ab'.repeat(32)}`)).toBe(true);
  });

  it('rejects unbounded or malformed transport values', () => {
    expect(isPublicApiKeyCandidate(`wrong_${'a'.repeat(64)}`)).toBe(false);
    expect(isPublicApiKeyCandidate(`${PUBLIC_API_KEY_PREFIX}too-short`)).toBe(false);
    expect(isPublicApiKeyCandidate(`${PUBLIC_API_KEY_PREFIX}${'a'.repeat(32)}!`)).toBe(false);
    expect(isPublicApiKeyCandidate(`${PUBLIC_API_KEY_PREFIX}${'a'.repeat(257)}`)).toBe(false);
  });
});
