import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { verifyPinnedRoot } from './publishPackageInstaller';

describe('package installer TUF root pin', () => {
  test('accepts only the exact lowercase SHA-256 chosen by the offline ceremony', () => {
    const root = Buffer.from('signed root metadata');
    const digest = createHash('sha256').update(root).digest('hex');

    expect(verifyPinnedRoot(root, digest)).toBe(digest);
    expect(() => verifyPinnedRoot(root, '0'.repeat(64))).toThrow('does not match');
    expect(() => verifyPinnedRoot(root, digest.toUpperCase())).toThrow('canonical');
  });
});
