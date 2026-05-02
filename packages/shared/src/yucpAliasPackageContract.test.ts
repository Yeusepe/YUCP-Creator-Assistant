import { describe, expect, it } from 'bun:test';

import {
  applyYucpAliasPackageManifestDefaults,
  getYucpAliasPackageContract,
  mergeYucpAliasPackageMetadata,
  normalizeYucpAliasPackageContract,
  resolveSharedYucpAliasIdFromCatalogProducts,
  resolveYucpAliasIdFromCatalogProduct,
  YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_VERSION,
  YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES,
  YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES,
  YUCP_ALIAS_PACKAGE_KIND,
} from './yucpAliasPackageContract';

describe('normalizeYucpAliasPackageContract', () => {
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
      catalogProductIds: ['product-a', 'product-b'],
      channel: 'stable',
    });
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
  it('adds the shared alias contract without dropping existing metadata', () => {
    expect(
      mergeYucpAliasPackageMetadata({
        metadata: {
          description: 'Legacy package',
        },
        aliasId: 'song-thing',
        catalogProductIds: ['product-a', 'product-a', 'product-b'],
        channel: 'stable',
      })
    ).toEqual({
      description: 'Legacy package',
      yucp: {
        kind: 'alias-v1',
        aliasId: 'song-thing',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        minImporterVersion: '0.1.0',
        catalogProductIds: ['product-a', 'product-b'],
        channel: 'stable',
      },
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
      },
      vpmDependencies: {
        'com.yucp.importer': YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_VERSION,
      },
    });
  });
});
