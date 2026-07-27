import { describe, expect, it } from 'bun:test';
import {
  assertPublicImporterIndexMatchesReleaseLedger,
  assertPublicImporterVersionsImmutable,
  type VpmImporterManifest,
} from './vpmImporterPackage';

function manifest(version: string, zipSHA256: string): VpmImporterManifest {
  return {
    displayName: 'YUCP Package Importer',
    name: 'com.yucp.importer',
    url: `https://vpm.yucp.club/com.yucp.importer-${version}.zip`,
    version,
    zipSHA256,
  };
}

describe('public importer version immutability', () => {
  it('rejects a changed older release even when the latest release remains unchanged', () => {
    const index = {
      packages: {
        'com.yucp.importer': {
          versions: {
            '0.1.32': manifest('0.1.32', 'b'.repeat(64)),
            '0.1.33': manifest('0.1.33', 'c'.repeat(64)),
          },
        },
      },
    };

    expect(() =>
      assertPublicImporterIndexMatchesReleaseLedger(index, {
        releases: {
          '0.1.32': { sha256: 'a'.repeat(64) },
          '0.1.33': { sha256: 'c'.repeat(64) },
        },
        schemaVersion: 1,
      })
    ).toThrow('changed published version 0.1.32');
  });

  it('rejects an importer release that has no persistent pin', () => {
    const index = {
      packages: {
        'com.yucp.importer': {
          versions: {
            '0.1.33': manifest('0.1.33', 'c'.repeat(64)),
            '0.1.34': manifest('0.1.34', 'd'.repeat(64)),
          },
        },
      },
    };

    expect(() =>
      assertPublicImporterIndexMatchesReleaseLedger(index, {
        releases: {
          '0.1.32': { sha256: 'a'.repeat(64) },
          '0.1.33': { sha256: 'c'.repeat(64) },
        },
        schemaVersion: 1,
      })
    ).toThrow('not pinned');
  });

  it('rejects changed package bytes under an already published semantic version', () => {
    const published = manifest('0.1.32', 'a'.repeat(64));
    const changed = manifest('0.1.32', 'b'.repeat(64));

    expect(() => assertPublicImporterVersionsImmutable(published, changed)).toThrow(
      'must publish a new semantic version'
    );
  });

  it('accepts the same bytes or a new semantic version', () => {
    const published = manifest('0.1.32', 'a'.repeat(64));

    expect(() =>
      assertPublicImporterVersionsImmutable(published, manifest('0.1.32', 'a'.repeat(64)))
    ).not.toThrow();
    expect(() =>
      assertPublicImporterVersionsImmutable(published, manifest('0.1.33', 'b'.repeat(64)))
    ).not.toThrow();
  });
});
