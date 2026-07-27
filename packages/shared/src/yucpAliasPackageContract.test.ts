import { describe, expect, it } from 'bun:test';

import {
  applyYucpAliasPackageManifestDefaults,
  getYucpAliasPackageContract,
  mergeYucpAliasPackageMetadata,
  normalizeYucpAliasPackageContract,
  resolveSharedYucpAliasIdFromCatalogProducts,
  resolveYucpAliasIdFromCatalogProduct,
  YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION,
  YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_VERSION,
  YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES,
  YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES,
  YUCP_ALIAS_PACKAGE_KIND,
} from './yucpAliasPackageContract';

describe('normalizeYucpAliasPackageContract', () => {
  it('requires the current immutable importer release', () => {
    expect(YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION).toBe('0.1.36');
    expect(YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_VERSION).toBe('>=0.1.36');
  });

  it('normalizes the shared alias package contract shape', () => {
    expect(
      normalizeYucpAliasPackageContract({
        kind: ' alias-v1 ',
        aliasId: ' creator-alias ',
        installStrategy: ' server-authorized ',
        importerPackage: ' com.yucp.importer ',
        minImporterVersion: ' 1.2.0 ',
        catalogProductIds: [' product-a ', 'product-b', 'product-a'],
        channel: ' stable ',
        ignored: true,
      })
    ).toEqual({
      kind: YUCP_ALIAS_PACKAGE_KIND,
      aliasId: 'creator-alias',
      installStrategy: YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES.serverAuthorized,
      importerPackage: YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES.importer,
      minImporterVersion: '1.2.0',
      channel: 'stable',
    });
  });

  it('preserves only public alias package identity metadata', () => {
    expect(
      normalizeYucpAliasPackageContract({
        kind: 'alias-v1',
        aliasId: 'song-thing',
        packageName: ' com.yucp.songthing ',
        packageDisplayName: ' Song Thing ',
        packageVersion: ' 1.0.12 ',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
      })
    ).toEqual({
      kind: YUCP_ALIAS_PACKAGE_KIND,
      aliasId: 'song-thing',
      packageName: 'com.yucp.songthing',
      packageDisplayName: 'Song Thing',
      packageVersion: '1.0.12',
      installStrategy: YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES.serverAuthorized,
      importerPackage: YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES.importer,
    });
  });

  it('normalizes friendly package metadata and local media references', () => {
    expect(
      normalizeYucpAliasPackageContract({
        kind: 'alias-v1',
        aliasId: 'jammr',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        packageMetadata: {
          packageName: ' JAMMR ',
          version: ' 0.1.15 ',
          author: ' Mapache ',
          description: ' Avatar tools. ',
          tagline: ' Ready to use. ',
        },
        media: [
          {
            kind: 'icon',
            localPath: 'Documentation~/YUCP/icon.png',
            contentType: 'image/png',
            byteSize: 1024,
            sha256: 'a'.repeat(64),
          },
        ],
      })
    ).toMatchObject({
      packageMetadata: {
        packageName: 'JAMMR',
        author: 'Mapache',
        description: 'Avatar tools.',
        tagline: 'Ready to use.',
      },
      media: [
        {
          kind: 'icon',
          localPath: 'Documentation~/YUCP/icon.png',
          contentType: 'image/png',
          byteSize: 1024,
          sha256: 'a'.repeat(64),
        },
      ],
    });
  });

  it('rejects removed install-plan and resolved artifact fields', () => {
    expect(() =>
      normalizeYucpAliasPackageContract({
        kind: 'alias-v1',
        aliasId: 'song-thing',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        installPlan: { id: 'removed-plan' },
      })
    ).toThrow('installPlan is not supported');
    expect(() =>
      normalizeYucpAliasPackageContract({
        kind: 'alias-v1',
        aliasId: 'song-thing',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        resolvedArtifact: { artifactId: 'removed-artifact' },
      })
    ).toThrow('resolvedArtifact is not supported');
    expect(() =>
      normalizeYucpAliasPackageContract({
        kind: 'alias-v1',
        aliasId: 'song-thing',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        resolvedRelease: { releaseId: 'removed-release' },
      })
    ).toThrow('resolvedRelease is not supported');
  });

  it('returns undefined when the contract is absent', () => {
    expect(normalizeYucpAliasPackageContract(undefined)).toBeUndefined();
  });

  it('throws when the contract uses an unsupported install strategy', () => {
    expect(() =>
      normalizeYucpAliasPackageContract({
        kind: 'alias-v1',
        aliasId: 'creator-alias',
        installStrategy: 'download-direct',
        importerPackage: 'com.yucp.importer',
      })
    ).toThrow('metadata.yucp.installStrategy must be "server-authorized"');
  });
});

describe('getYucpAliasPackageContract', () => {
  it('reads the contract from root package metadata', () => {
    expect(
      getYucpAliasPackageContract({
        yucp: {
          kind: 'alias-v1',
          aliasId: 'creator-alias',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
        },
      })
    ).toEqual({
      kind: YUCP_ALIAS_PACKAGE_KIND,
      aliasId: 'creator-alias',
      installStrategy: YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES.serverAuthorized,
      importerPackage: YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES.importer,
    });
  });
});

describe('resolveYucpAliasIdFromCatalogProduct', () => {
  it('prefers canonical slugs over provider product refs', () => {
    expect(
      resolveYucpAliasIdFromCatalogProduct({
        canonicalSlug: ' song-thing ',
        providerProductRef: 'gumroad-song-thing',
      })
    ).toBe('song-thing');
  });

  it('falls back to the provider product ref when needed', () => {
    expect(
      resolveYucpAliasIdFromCatalogProduct({
        providerProductRef: ' gumroad-song-thing ',
      })
    ).toBe('gumroad-song-thing');
  });
});

describe('resolveSharedYucpAliasIdFromCatalogProducts', () => {
  it('synthesizes a shared alias id from matching display names when provider slugs differ', () => {
    expect(
      resolveSharedYucpAliasIdFromCatalogProducts([
        {
          canonicalSlug: 'gumroad-songthing',
          displayName: 'Song Thing',
          providerProductRef: 'gumroad-songthing',
        },
        {
          canonicalSlug: 'jinxxy-song-thing',
          displayName: 'Song Thing',
          providerProductRef: 'jinxxy-song-thing',
        },
      ])
    ).toBe('song-thing');
  });

  it('does not synthesize a shared alias id when the display names disagree', () => {
    expect(
      resolveSharedYucpAliasIdFromCatalogProducts([
        {
          canonicalSlug: 'gumroad-song-release',
          displayName: 'Song Release',
          providerProductRef: 'gumroad-song-release',
        },
        {
          canonicalSlug: 'patreon-song-membership',
          displayName: 'Song Members Tier',
          providerProductRef: 'patreon-song-membership',
        },
      ])
    ).toBeUndefined();
  });
});

describe('mergeYucpAliasPackageMetadata', () => {
  it('emits only the stable package identity for storefront-independent aliases', () => {
    const merged = mergeYucpAliasPackageMetadata({
      aliasId: 'com.yucp.jammr',
      channel: 'stable',
    } as Parameters<typeof mergeYucpAliasPackageMetadata>[0]);

    expect(merged.yucp).toMatchObject({
      aliasId: 'com.yucp.jammr',
      kind: 'alias-v1',
    });
    expect(merged.yucp).not.toHaveProperty('catalogProductIds');
  });

  it('adds the shared alias contract without dropping existing metadata', () => {
    expect(
      mergeYucpAliasPackageMetadata({
        metadata: {
          description: 'Legacy package',
        },
        aliasId: 'song-thing',
        channel: 'stable',
      })
    ).toEqual({
      description: 'Legacy package',
      yucp: {
        kind: 'alias-v1',
        aliasId: 'song-thing',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        minImporterVersion: YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION,
        channel: 'stable',
      },
    });
  });

  it('raises stale alias importer minimums to the shared floor', () => {
    expect(
      mergeYucpAliasPackageMetadata({
        metadata: {
          yucp: {
            kind: 'alias-v1',
            aliasId: 'song-thing',
            installStrategy: 'server-authorized',
            importerPackage: 'com.yucp.importer',
            minImporterVersion: '0.1.0',
          },
        },
        aliasId: 'song-thing',
        channel: 'stable',
      }).yucp
    ).toMatchObject({
      minImporterVersion: YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION,
    });
  });

  it('preserves normalized friendly metadata when merging the alias contract', () => {
    const merged = mergeYucpAliasPackageMetadata({
      metadata: {
        yucp: {
          kind: 'alias-v1',
          aliasId: 'jammr',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          packageMetadata: {
            packageName: 'JAMMR',
            author: 'Mapache',
          },
          media: [
            {
              kind: 'icon',
              localPath: 'Documentation~/YUCP/icon.png',
              contentType: 'image/png',
              byteSize: 1024,
              sha256: 'a'.repeat(64),
            },
          ],
        },
      },
      aliasId: 'jammr',
      channel: 'stable',
    });

    expect(merged.yucp).toMatchObject({
      packageMetadata: {
        packageName: 'JAMMR',
        author: 'Mapache',
      },
      media: [
        {
          kind: 'icon',
          localPath: 'Documentation~/YUCP/icon.png',
          contentType: 'image/png',
          byteSize: 1024,
          sha256: 'a'.repeat(64),
        },
      ],
    });
  });

  it('raises unparseable alias importer minimum ranges to the shared floor', () => {
    expect(
      mergeYucpAliasPackageMetadata({
        metadata: {
          yucp: {
            kind: 'alias-v1',
            aliasId: 'song-thing',
            installStrategy: 'server-authorized',
            importerPackage: 'com.yucp.importer',
            minImporterVersion: '<0.1.9',
          },
        },
        aliasId: 'song-thing',
        channel: 'stable',
      }).yucp
    ).toMatchObject({
      minImporterVersion: YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION,
    });
  });
});

describe('applyYucpAliasPackageManifestDefaults', () => {
  it('injects the importer dependency from the alias contract minimum version', () => {
    expect(
      applyYucpAliasPackageManifestDefaults({
        yucp: {
          kind: 'alias-v1',
          aliasId: 'creator-alias',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          minImporterVersion: '1.4.0',
        },
      })
    ).toEqual({
      yucp: {
        kind: 'alias-v1',
        aliasId: 'creator-alias',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        minImporterVersion: '1.4.0',
      },
      vpmDependencies: {
        'com.yucp.importer': '>=1.4.0',
      },
    });
  });

  it('falls back to the shared importer floor when the alias contract omits a minimum version', () => {
    expect(
      applyYucpAliasPackageManifestDefaults({
        yucp: {
          kind: 'alias-v1',
          aliasId: 'creator-alias',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
        },
      })
    ).toEqual({
      yucp: {
        kind: 'alias-v1',
        aliasId: 'creator-alias',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        minImporterVersion: YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION,
      },
      vpmDependencies: {
        'com.yucp.importer': YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_VERSION,
      },
    });
  });

  it('replaces a stale manifest dependency with the alias contract minimum', () => {
    expect(
      applyYucpAliasPackageManifestDefaults({
        vpmDependencies: {
          'com.yucp.importer': '>=0.1.25',
        },
        yucp: {
          kind: 'alias-v1',
          aliasId: 'creator-alias',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          minImporterVersion: '0.1.31',
        },
      })
    ).toMatchObject({
      vpmDependencies: {
        'com.yucp.importer': '>=0.1.36',
      },
    });
  });
});
