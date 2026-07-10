import { describe, expect, it } from 'bun:test';
import { latestImageDigest } from './check-image-freshness';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('latestImageDigest', () => {
  it('returns a valid manifest digest', () => {
    expect(latestImageDigest(JSON.stringify({ manifest: { digest: DIGEST } }))).toBe(DIGEST);
  });

  it('explains when inspect output has no manifest digest', () => {
    for (const inspectOutput of [JSON.stringify({ manifests: [] }), JSON.stringify([])]) {
      expect(() => latestImageDigest(inspectOutput)).toThrow(
        'Docker image inspection output is missing manifest.digest; inspect output may be a manifest list or use a different field casing'
      );
    }
  });
});
