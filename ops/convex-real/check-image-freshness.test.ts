import { describe, expect, it } from 'bun:test';
import { latestImageDigest } from './check-image-freshness';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('latestImageDigest', () => {
  it('returns the descriptor digest from Buildx inspect output', () => {
    const buildxInspectOutput = `{"descriptor":{"digest":"${DIGEST}"},"manifest":{}}`;

    expect(latestImageDigest(buildxInspectOutput)).toBe(DIGEST);
  });

  it('explains when inspect output is malformed JSON', () => {
    expect(() => latestImageDigest('{')).toThrow(
      'Docker image inspection output was not valid JSON'
    );
  });

  it('explains when inspect output has no descriptor digest', () => {
    for (const inspectOutput of [JSON.stringify({ manifests: [] }), JSON.stringify([])]) {
      expect(() => latestImageDigest(inspectOutput)).toThrow(
        'Docker image inspection output is missing descriptor.digest'
      );
    }
  });

  it('explains when descriptor digest is not an immutable SHA-256 digest', () => {
    expect(() => latestImageDigest(JSON.stringify({ descriptor: { digest: 'sha512:not-a-digest' } }))).toThrow(
      'Docker image inspection output descriptor.digest was not an immutable SHA-256 digest'
    );
  });
});
