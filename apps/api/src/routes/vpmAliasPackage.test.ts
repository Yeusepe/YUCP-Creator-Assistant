import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { buildYucpAliasVpmPackage, YUCP_ALIAS_BOOTSTRAP_VERSION } from './vpmAliasPackage';

const catalogProductId = 'catalog_product_public_alias_123';

describe('YUCP public VPM alias package', () => {
  it('builds one deterministic package.json-only archive', () => {
    const first = buildYucpAliasVpmPackage({
      catalogProductId,
      vpmBaseUrl: 'https://vpm.example.test/',
    });
    const second = buildYucpAliasVpmPackage({
      catalogProductId,
      vpmBaseUrl: 'https://vpm.example.test/',
    });

    expect(first.bytes).toEqual(second.bytes);
    expect(first.zipSha256).toBe(createHash('sha256').update(first.bytes).digest('hex'));

    const entries = unzipSync(first.bytes);
    expect(Object.keys(entries)).toEqual(['package.json']);
  });

  it('contains only public bootstrap metadata and the importer dependency', () => {
    const built = buildYucpAliasVpmPackage({
      catalogProductId,
      vpmBaseUrl: 'https://vpm.example.test/',
    });
    const entries = unzipSync(built.bytes);
    const packageJson = JSON.parse(
      Buffer.from(entries['package.json'] ?? []).toString('utf8')
    ) as Record<string, unknown>;

    expect(built.manifest).toMatchObject({
      name: built.packageId,
      version: YUCP_ALIAS_BOOTSTRAP_VERSION,
      url: `https://vpm.example.test/api/vpm/aliases/${encodeURIComponent(
        catalogProductId
      )}/${YUCP_ALIAS_BOOTSTRAP_VERSION}.zip`,
      zipSHA256: built.zipSha256,
      vpmDependencies: {
        'com.yucp.importer': '>=0.1.14',
      },
      yucp: {
        kind: 'alias-v1',
        aliasId: catalogProductId,
        catalogProductIds: [catalogProductId],
        channel: 'stable',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        minImporterVersion: '0.1.14',
      },
    });
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
  });

  it('rejects unsafe origins and unbounded catalog product identifiers', () => {
    expect(() =>
      buildYucpAliasVpmPackage({
        catalogProductId,
        vpmBaseUrl: 'http://vpm.example.test/',
      })
    ).toThrow('VPM base URL');
    expect(() =>
      buildYucpAliasVpmPackage({
        catalogProductId: 'x'.repeat(513),
        vpmBaseUrl: 'https://vpm.example.test/',
      })
    ).toThrow('catalog product ID');
  });
});
