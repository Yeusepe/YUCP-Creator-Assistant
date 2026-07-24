import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import {
  buildYucpAliasVpmPackage,
  decodeYucpAliasArtifactDescriptor,
  YUCP_ALIAS_BOOTSTRAP_VERSION,
} from './vpmAliasPackage';

const catalogProductId = 'catalog_product_public_alias_123';
const secondCatalogProductId = 'catalog_product_public_alias_456';
const aliasId = 'jammr';

describe('YUCP public VPM alias package', () => {
  it('builds one deterministic package.json-only archive', () => {
    const first = buildYucpAliasVpmPackage({
      aliasId,
      catalogProductIds: [catalogProductId, secondCatalogProductId],
      vpmBaseUrl: 'https://vpm.example.test/',
    });
    const second = buildYucpAliasVpmPackage({
      aliasId,
      catalogProductIds: [secondCatalogProductId, catalogProductId],
      vpmBaseUrl: 'https://vpm.example.test/',
    });

    expect(first.bytes).toEqual(second.bytes);
    expect(first.zipSha256).toBe(createHash('sha256').update(first.bytes).digest('hex'));

    const entries = unzipSync(first.bytes);
    expect(Object.keys(entries)).toEqual(['package.json']);
  });

  it('contains only public bootstrap metadata and the importer dependency', () => {
    const built = buildYucpAliasVpmPackage({
      aliasId,
      catalogProductIds: [catalogProductId, secondCatalogProductId],
      vpmBaseUrl: 'https://vpm.example.test/',
    });
    const entries = unzipSync(built.bytes);
    const packageJson = JSON.parse(
      Buffer.from(entries['package.json'] ?? []).toString('utf8')
    ) as Record<string, unknown>;
    const artifactUrl = built.manifest.url;

    expect(built.manifest).toMatchObject({
      name: built.packageId,
      version: YUCP_ALIAS_BOOTSTRAP_VERSION,
      url: artifactUrl,
      zipSHA256: built.zipSha256,
      vpmDependencies: {
        'com.yucp.importer': '>=0.1.14',
      },
      yucp: {
        kind: 'alias-v1',
        aliasId,
        catalogProductIds: [catalogProductId, secondCatalogProductId],
        channel: 'stable',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        minImporterVersion: '0.1.14',
      },
    });
    expect(artifactUrl).toMatch(
      /^https:\/\/vpm\.example\.test\/api\/vpm\/aliases\/[A-Za-z0-9_-]+\/1\.0\.0\.zip$/
    );
    expect(packageJson).toEqual({
      name: built.packageId,
      displayName: built.manifest.displayName,
      version: YUCP_ALIAS_BOOTSTRAP_VERSION,
      unity: '2022.3',
      description:
        'Public YUCP bootstrap. Sign in through the importer to resolve licensed product content.',
      author: {
        name: 'YUCP Club',
        email: 'contact@yucp.club',
        url: 'https://yucp.club/',
      },
      vpmDependencies: {
        'com.yucp.importer': '>=0.1.14',
      },
      yucp: built.manifest.yucp,
    });

    const serialized = JSON.stringify(packageJson);
    expect(serialized).not.toContain('versionId');
    expect(serialized).not.toContain('delivery');
    expect(serialized).not.toContain('download');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('sig');

    const descriptor = artifactUrl.split('/').at(-2);
    expect(descriptor).toBeDefined();
    expect(decodeYucpAliasArtifactDescriptor(descriptor ?? '')).toEqual({
      aliasId,
      catalogProductIds: [catalogProductId, secondCatalogProductId],
    });
  });

  it('rejects unsafe origins and unbounded catalog product identifiers', () => {
    expect(() =>
      buildYucpAliasVpmPackage({
        aliasId,
        catalogProductIds: [catalogProductId],
        vpmBaseUrl: 'http://vpm.example.test/',
      })
    ).toThrow('VPM base URL');
    expect(() =>
      buildYucpAliasVpmPackage({
        aliasId,
        catalogProductIds: ['x'.repeat(513)],
        vpmBaseUrl: 'https://vpm.example.test/',
      })
    ).toThrow('catalog product ID');
  });

  it('builds deterministic archives west of UTC at the ZIP epoch boundary', () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = 'America/Bogota';
    try {
      expect(() =>
        buildYucpAliasVpmPackage({
          aliasId,
          catalogProductIds: [catalogProductId],
          vpmBaseUrl: 'https://vpm.example.test/',
        })
      ).not.toThrow();
    } finally {
      if (originalTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimezone;
      }
    }
  });
});
