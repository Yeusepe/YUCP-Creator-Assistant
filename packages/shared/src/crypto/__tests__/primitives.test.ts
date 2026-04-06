import { describe, expect, it } from 'bun:test';
import {
  base64UrlDecodeToBytes,
  base64UrlEncode,
  bytesToHex,
  normalizeEmail,
  sha256Base64Url,
  sha256Bytes,
  sha256Hex,
} from '../index';

describe('crypto primitives', () => {
  it('encodes and decodes base64url values', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = base64UrlEncode(bytes);

    expect(encoded).toBe('AAEC-vv8_f7_');
    expect(base64UrlDecodeToBytes(encoded)).toEqual(bytes);
  });

  it('hashes strings to sha256 hex', async () => {
    expect(await sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('hashes strings to sha256 base64url', async () => {
    expect(await sha256Base64Url('hello')).toBe('LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ');
  });

  it('hashes raw bytes without string conversion', async () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]);
    expect(bytesToHex(await sha256Bytes(bytes))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('normalizes email values before hashing', () => {
    expect(normalizeEmail('  USER@Example.com  ')).toBe('user@example.com');
  });
});
