import { describe, expect, it } from 'bun:test';

// hashLicenseKey is private to manual-licenses.ts — replicate the identical algorithm here
// so we can test its properties independently without importing the production module.
async function hashKey(key: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('hashKey (SHA-256 hex)', () => {
  it('produces a deterministic 64-character hex string for "test"', async () => {
    const result = await hashKey('test');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the known SHA-256 hex digest for "hello"', async () => {
    const result = await hashKey('hello');
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('is deterministic — same input always produces same hash', async () => {
    const a = await hashKey('consistent-input');
    const b = await hashKey('consistent-input');
    expect(a).toBe(b);
  });

  it('different keys produce different hashes', async () => {
    const a = await hashKey('abc');
    const b = await hashKey('xyz');
    expect(a).not.toBe(b);
  });

  it('produces a valid 64-char hex even for an empty string', async () => {
    const result = await hashKey('');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles unicode input without throwing', async () => {
    const result = await hashKey('héllo wörld 🎉');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});
