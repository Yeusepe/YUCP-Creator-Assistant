import { describe, expect, it } from 'bun:test';
import {
  PUBLIC_API_KEY_PREFIX,
  generatePublicApiKeyValue,
  getPublicApiKeyPrefix,
  hashPublicApiKey,
} from './publicApiKeys';

describe('publicApiKeys', () => {
  it('generates prefixed API keys', () => {
    const key = generatePublicApiKeyValue();
    expect(key.startsWith(PUBLIC_API_KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThan(PUBLIC_API_KEY_PREFIX.length);
  });

  it('hashes the same key deterministically for the same pepper', () => {
    const pepper = 'test-pepper';
    const key = `${PUBLIC_API_KEY_PREFIX}abc123`;
    expect(hashPublicApiKey(key, pepper)).toBe(hashPublicApiKey(key, pepper));
  });

  it('returns a short display prefix', () => {
    const key = `${PUBLIC_API_KEY_PREFIX}0123456789abcdef`;
    expect(getPublicApiKeyPrefix(key)).toBe(`${PUBLIC_API_KEY_PREFIX}01234567`);
  });
});
