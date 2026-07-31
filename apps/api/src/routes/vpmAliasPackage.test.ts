import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { buildYucpAliasVpmPackage } from './vpmAliasPackage';

const aliasId = 'jammr';
const PUBLICATION_ID = '00000000-0000-4000-8000-000000000401';

function immutableArtifactUrl(version: string): string {
  return `https://vpm.example.test/api/vpm/alias-publications/${PUBLICATION_ID}/${version}.zip`;
}

describe('YUCP public VPM alias package', () => {
  it('uses the uploaded install ID and release version as the package identity shown by VPM clients', () => {
    const built = buildYucpAliasVpmPackage({
      aliasId: 'com.yucp.songthing',
      bootstrapVersion: '1.0.0',
      packageVersion: '2.0',
      vpmDependencies: {},
      artifactUrl: immutableArtifactUrl('1.0.0'),
    } as Parameters<typeof buildYucpAliasVpmPackage>[0] & { packageVersion: string });

    expect(built.packageId).toBe('com.yucp.songthing');
    expect(built.manifest).toMatchObject({
      name: 'com.yucp.songthing',
      version: '2.0.0',
      yucp: {
        aliasId: 'com.yucp.songthing',
        packageVersion: '2.0.0',
      },
    });
  });

  it('builds a public alias from only the stable package identity', () => {
    const built = buildYucpAliasVpmPackage({
      aliasId: 'com.yucp.jammr',
      bootstrapVersion: '1.20660.12345',
      vpmDependencies: {},
      artifactUrl: immutableArtifactUrl('1.20660.12345'),
    } as Parameters<typeof buildYucpAliasVpmPackage>[0]);

    expect(built.manifest.yucp).toMatchObject({
      aliasId: 'com.yucp.jammr',
      kind: 'alias-v1',
    });
    expect(built.manifest.yucp).not.toHaveProperty('catalogProductIds');
  });

  it('keeps the installed alias package ID stable across immutable bootstrap revisions', () => {
    const first = buildYucpAliasVpmPackage({
      aliasId: 'com.yucp.jammr',
      bootstrapVersion: '1.20660.12345',
      vpmDependencies: {},
      artifactUrl: immutableArtifactUrl('1.20660.12345'),
    });
    const linkedStorefront = buildYucpAliasVpmPackage({
      aliasId: 'com.yucp.jammr',
      bootstrapVersion: '1.20660.12346',
      vpmDependencies: {},
      artifactUrl: immutableArtifactUrl('1.20660.12346'),
    });

    expect(linkedStorefront.packageId).toBe(first.packageId);
    expect(linkedStorefront.manifest.version).not.toBe(first.manifest.version);
    expect(linkedStorefront.manifest.url).not.toBe(first.manifest.url);
  });

  it('builds one deterministic package.json-only archive', () => {
    const first = buildYucpAliasVpmPackage({
      aliasId,
      bootstrapVersion: '1.20660.12345',
      vpmDependencies: {
        'com.example.runtime': '>=2.0.0',
      },
      artifactUrl: immutableArtifactUrl('1.20660.12345'),
    });
    const second = buildYucpAliasVpmPackage({
      aliasId,
      bootstrapVersion: '1.20660.12345',
      vpmDependencies: {
        'com.example.runtime': '>=2.0.0',
      },
      artifactUrl: immutableArtifactUrl('1.20660.12345'),
    });

    expect(first.bytes).toEqual(second.bytes);
    expect(first.zipSha256).toBe(createHash('sha256').update(first.bytes).digest('hex'));

    const entries = unzipSync(first.bytes);
    expect(Object.keys(entries)).toEqual(['package.json']);
  });

  it('contains only public bootstrap metadata and the importer dependency', () => {
    const built = buildYucpAliasVpmPackage({
      aliasId,
      bootstrapVersion: '1.20660.12345',
      vpmDependencies: {
        'com.example.runtime': '>=2.0.0',
      },
      artifactUrl: immutableArtifactUrl('1.20660.12345'),
    });
    const entries = unzipSync(built.bytes);
    const packageJson = JSON.parse(
      Buffer.from(entries['package.json'] ?? []).toString('utf8')
    ) as Record<string, unknown>;
    const artifactUrl = built.manifest.url;

    expect(built.manifest).toMatchObject({
      displayName: 'YUCP Licensed Product',
      name: built.packageId,
      version: '1.20660.12345',
      url: artifactUrl,
      zipSHA256: built.zipSha256,
      vpmDependencies: {
        'com.example.runtime': '>=2.0.0',
        'com.yucp.importer': '>=0.1.71',
      },
      yucp: {
        kind: 'alias-v1',
        aliasId,
        channel: 'stable',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        minImporterVersion: '0.1.71',
      },
    });
    expect(artifactUrl).toBe(immutableArtifactUrl('1.20660.12345'));
    expect(packageJson).toEqual({
      name: built.packageId,
      displayName: 'YUCP Licensed Product',
      version: '1.20660.12345',
      unity: '2022.3',
      description: 'Adds this licensed product to your Unity project with YUCP.',
      author: {
        name: 'YUCP Club',
        email: 'contact@yucp.club',
        url: 'https://yucp.club/',
      },
      vpmDependencies: {
        'com.example.runtime': '>=2.0.0',
        'com.yucp.importer': '>=0.1.71',
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

  it('publishes friendly package metadata without paid delivery data', () => {
    const built = buildYucpAliasVpmPackage({
      aliasId,
      bootstrapVersion: '1.20660.12345',
      vpmDependencies: {},
      artifactUrl: immutableArtifactUrl('1.20660.12345'),
      packageMetadata: {
        packageName: 'JAMMR',
        author: 'Mapache',
        description: 'Adds the JAMMR product to this project.',
        tagline: 'Ready for your next avatar.',
      },
    });
    const entries = unzipSync(built.bytes);
    const packageJson = JSON.parse(Buffer.from(entries['package.json'] ?? []).toString('utf8')) as {
      displayName: string;
      description: string;
      author: { name: string };
      yucp: {
        packageDisplayName: string;
        packageMetadata: {
          packageName: string;
          author: string;
          description: string;
          tagline: string;
        };
      };
    };

    expect(packageJson.displayName).toBe('JAMMR');
    expect(packageJson.description).toBe('Adds the JAMMR product to this project.');
    expect(packageJson.author.name).toBe('Mapache');
    expect(packageJson.yucp.packageDisplayName).toBe('JAMMR');
    expect(packageJson.yucp.packageMetadata).toEqual({
      packageName: 'JAMMR',
      author: 'Mapache',
      description: 'Adds the JAMMR product to this project.',
      tagline: 'Ready for your next avatar.',
    });
    expect(Object.keys(entries)).toEqual(['package.json']);
    expect(JSON.stringify(packageJson)).not.toContain('/d/');
    expect(JSON.stringify(packageJson)).not.toContain('grant');
  });

  it('includes verified media without placing its bytes in the artifact URL', () => {
    const icon = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const banner = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const bannerSha256 = createHash('sha256').update(banner).digest('hex');
    const iconSha256 = createHash('sha256').update(icon).digest('hex');
    const built = buildYucpAliasVpmPackage({
      aliasId,
      bootstrapVersion: '1.20660.12345',
      vpmDependencies: {},
      artifactUrl: immutableArtifactUrl('1.20660.12345'),
      packageMetadata: {
        packageName: 'JAMMR',
        author: 'Mapache',
      },
      media: [
        {
          kind: 'banner',
          localPath: 'Documentation~/YUCP/banner.png',
          contentType: 'image/png',
          bytes: banner,
          sha256: bannerSha256,
        },
        {
          kind: 'icon',
          localPath: 'Documentation~/YUCP/icon.png',
          contentType: 'image/png',
          bytes: icon,
          sha256: iconSha256,
        },
      ],
    });

    const entries = unzipSync(built.bytes);
    expect(entries['Documentation~/YUCP/banner.png']).toEqual(banner);
    expect(entries['Documentation~/YUCP/icon.png']).toEqual(icon);
    expect(built.manifest.yucp).toMatchObject({
      media: [
        {
          kind: 'banner',
          byteSize: banner.byteLength,
          contentType: 'image/png',
          localPath: 'Documentation~/YUCP/banner.png',
          sha256: bannerSha256,
        },
        {
          kind: 'icon',
          byteSize: icon.byteLength,
          contentType: 'image/png',
          localPath: 'Documentation~/YUCP/icon.png',
          sha256: iconSha256,
        },
      ],
    });
    expect(built.manifest.url).not.toContain(Buffer.from(icon).toString('base64url'));
  });

  it('ships product links without icons as metadata-only media entries', () => {
    const built = buildYucpAliasVpmPackage({
      aliasId,
      bootstrapVersion: '1.20660.12345',
      vpmDependencies: {},
      artifactUrl: immutableArtifactUrl('1.20660.12345'),
      packageMetadata: {
        packageName: 'JAMMR',
        author: 'Mapache',
      },
      media: [
        {
          kind: 'product-link',
          label: 'Gumroad',
          ordinal: 0,
          url: 'https://creator.gumroad.com/l/jammr',
        },
        {
          kind: 'product-link',
          label: 'Patreon',
          ordinal: 1,
          url: 'https://www.patreon.com/creator',
        },
      ],
    });

    expect(Object.keys(unzipSync(built.bytes))).toEqual(['package.json']);
    expect(built.manifest.yucp).toMatchObject({
      media: [
        {
          kind: 'product-link',
          label: 'Gumroad',
          ordinal: 0,
          url: 'https://creator.gumroad.com/l/jammr',
        },
        {
          kind: 'product-link',
          label: 'Patreon',
          ordinal: 1,
          url: 'https://www.patreon.com/creator',
        },
      ],
    });
    const manifestMedia = (built.manifest.yucp as { media: Record<string, unknown>[] }).media;
    for (const entry of manifestMedia) {
      expect(entry.localPath).toBeUndefined();
      expect(entry.byteSize).toBeUndefined();
      expect(entry.sha256).toBeUndefined();
    }
    expect(() =>
      buildYucpAliasVpmPackage({
        aliasId,
        bootstrapVersion: '1.20660.12345',
        vpmDependencies: {},
        artifactUrl: immutableArtifactUrl('1.20660.12345'),
        media: [{ kind: 'icon' }],
      })
    ).toThrow('image payload');
  });

  it('rejects unsafe, oversized, unsupported, and digest-mismatched media', () => {
    const icon = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const media = {
      kind: 'icon' as const,
      localPath: 'Documentation~/YUCP/icon.png',
      contentType: 'image/png' as const,
      bytes: icon,
      sha256: createHash('sha256').update(icon).digest('hex'),
    };
    const build = (candidate: typeof media) =>
      buildYucpAliasVpmPackage({
        aliasId,
        bootstrapVersion: '1.20660.12345',
        vpmDependencies: {},
        artifactUrl: immutableArtifactUrl('1.20660.12345'),
        media: [candidate],
      });

    expect(() => build({ ...media, localPath: '../icon.png' })).toThrow('local path');
    expect(() => build({ ...media, contentType: 'image/gif' as 'image/png' })).toThrow(
      'content type'
    );
    expect(() => build({ ...media, sha256: '00'.repeat(32) })).toThrow('digest');
    expect(() =>
      build({
        ...media,
        bytes: new Uint8Array(16 * 1024 * 1024 + 1).fill(1),
        sha256: createHash('sha256')
          .update(new Uint8Array(16 * 1024 * 1024 + 1).fill(1))
          .digest('hex'),
      })
    ).toThrow('byte limit');
  });

  it('rejects unsafe origins and unbounded package identities', () => {
    expect(() =>
      buildYucpAliasVpmPackage({
        aliasId,
        bootstrapVersion: '1.20660.12345',
        vpmDependencies: {},
        artifactUrl: `http://vpm.example.test/api/vpm/alias-publications/${PUBLICATION_ID}/1.20660.12345.zip`,
      })
    ).toThrow('artifact URL');
    expect(() =>
      buildYucpAliasVpmPackage({
        aliasId: 'x'.repeat(513),
        bootstrapVersion: '1.20660.12345',
        vpmDependencies: {},
        artifactUrl: immutableArtifactUrl('1.20660.12345'),
      })
    ).toThrow('alias ID');
  });

  it('builds deterministic archives west of UTC at the ZIP epoch boundary', () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = 'America/Bogota';
    try {
      expect(() =>
        buildYucpAliasVpmPackage({
          aliasId,
          bootstrapVersion: '1.20660.12345',
          vpmDependencies: {},
          artifactUrl: immutableArtifactUrl('1.20660.12345'),
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
  it('republishes what the package needs so VCC can resolve it', () => {
    // The shape ingest reads out of JAMMR_2.1.8.unitypackage.
    const built = buildYucpAliasVpmPackage({
      aliasId,
      bootstrapVersion: '1.0.0',
      vpmDependencies: {
        'com.vrcfury.vrcfury': '>=1.1258.0',
        'com.yucp.importer': '>=0.1.75',
      },
      vpmRepositories: { 'VRCFury Repo': 'https://vcc.vrcfury.com/' },
      artifactUrl: immutableArtifactUrl('1.0.0'),
    });

    expect(built.manifest.vpmDependencies).toMatchObject({
      'com.vrcfury.vrcfury': '>=1.1258.0',
    });
    // The platform pins the importer, so a package cannot drag its own range in.
    expect(built.manifest.vpmDependencies['com.yucp.importer']).not.toBe('>=0.1.75');
    expect(built.manifest.vpmRepositories).toEqual({
      'VRCFury Repo': 'https://vcc.vrcfury.com/',
    });
  });

  it('refuses a repository the buyer cannot fetch over https', () => {
    expect(() =>
      buildYucpAliasVpmPackage({
        aliasId,
        bootstrapVersion: '1.0.0',
        vpmDependencies: {},
        vpmRepositories: { Sketchy: 'http://vcc.example.test/' },
        artifactUrl: immutableArtifactUrl('1.0.0'),
      })
    ).toThrow('repository URL is invalid');
  });
});
