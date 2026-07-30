import { describe, expect, it } from 'bun:test';
import { compareSemanticVersions, isPrereleaseSemanticVersion } from './semanticVersion';

describe('Semantic Version ordering', () => {
  it('orders stable and prerelease versions according to SemVer precedence', () => {
    expect(compareSemanticVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemanticVersions('2.0.0', '2.0.0-beta.4')).toBeGreaterThan(0);
    expect(compareSemanticVersions('2.0.0-beta.11', '2.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareSemanticVersions('2.0.0+build.2', '2.0.0+build.1')).toBe(0);
  });

  it('identifies prereleases without treating build metadata as a prerelease', () => {
    expect(isPrereleaseSemanticVersion('2.0.0-beta.1')).toBe(true);
    expect(isPrereleaseSemanticVersion('2.0.0+build.1')).toBe(false);
  });
});
