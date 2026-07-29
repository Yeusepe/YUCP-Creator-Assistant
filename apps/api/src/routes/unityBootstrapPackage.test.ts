import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'fflate';
import {
  buildYucpBootstrapUnityPackage,
  loadYucpBootstrapUnityPackageRuntime,
} from './unityBootstrapPackage';
import { buildYucpAliasVpmPackage } from './vpmAliasPackage';

const PUBLICATION_ID = '00000000-0000-4000-8000-000000000701';

function readNullTerminated(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function parseUnityPackage(bytes: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(bytes);
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const path = readNullTerminated(header.subarray(0, 100));
    const sizeText = readNullTerminated(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const bodyStart = offset + 512;
    entries.set(path, tar.slice(bodyStart, bodyStart + size));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function packageAssets(entries: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const assets = new Map<string, Uint8Array>();
  for (const [entryPath, bytes] of entries) {
    if (!entryPath.endsWith('/pathname')) {
      continue;
    }
    const directory = entryPath.slice(0, -'/pathname'.length);
    const pathname = new TextDecoder().decode(bytes);
    const asset = entries.get(`${directory}/asset`);
    if (asset) {
      assets.set(pathname, asset);
    }
  }
  return assets;
}

describe('YUCP bootstrap Unity package', () => {
  it('ships the package exporter autoinstall assembly byte-for-byte', async () => {
    const runtime = await loadYucpBootstrapUnityPackageRuntime();

    expect(createHash('sha256').update(runtime.installerRuntime).digest('hex')).toBe(
      '6bd2b176313ca9a7eae1665c284f78e0909ada0d7eb2468f3894662d69c1bbc6'
    );
    expect(new TextDecoder().decode(runtime.installerRuntimeMeta)).toContain(
      'guid: c0128f63522b4b0696235b4e328db9d2'
    );
  });

  it('embeds the complete VPM bootstrap and the package exporter autoinstall runtime', () => {
    const icon = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const gallery = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
    const productLink = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03]);
    const bootstrap = buildYucpAliasVpmPackage({
      aliasId: 'com.yucp.jammr',
      artifactUrl: `https://vpm.test/api/vpm/alias-publications/${PUBLICATION_ID}/1.2.3.zip`,
      bootstrapVersion: '1.2.3',
      packageMetadata: {
        author: 'Mapache',
        packageName: 'JAMMR',
      },
      media: [
        {
          bytes: icon,
          contentType: 'image/png',
          kind: 'icon',
          localPath: 'Documentation~/YUCP/icon.png',
          sha256: createHash('sha256').update(icon).digest('hex'),
        },
        {
          bytes: gallery,
          contentType: 'image/png',
          kind: 'gallery',
          localPath: 'Documentation~/YUCP/gallery/000.png',
          ordinal: 0,
          sha256: createHash('sha256').update(gallery).digest('hex'),
        },
        {
          bytes: productLink,
          contentType: 'image/png',
          kind: 'product-link',
          label: 'Gumroad',
          localPath: 'Documentation~/YUCP/product-links/000.png',
          ordinal: 0,
          sha256: createHash('sha256').update(productLink).digest('hex'),
          url: 'https://creator.gumroad.com/l/jammr',
        },
        {
          kind: 'product-link',
          label: 'Patreon',
          ordinal: 1,
          url: 'https://www.patreon.com/creator',
        },
      ],
      vpmDependencies: {},
    });
    const installerRuntime = Uint8Array.from([0x4d, 0x5a, 0x01, 0x02]);
    const installerRuntimeMeta = new TextEncoder().encode(
      'fileFormatVersion: 2\nPluginImporter:\n  serializedVersion: 2\n'
    );

    const unityPackage = buildYucpBootstrapUnityPackage({
      bootstrap,
      importerRepositoryUrl: 'https://vpm.yucp.club/index.json',
      installerRuntime,
      installerRuntimeMeta,
    });
    const assets = packageAssets(parseUnityPackage(unityPackage.bytes));
    const aliasRoot = `Packages/${bootstrap.packageId}`;

    expect(assets.get(`${aliasRoot}/package.json`)).toBeDefined();
    expect(assets.get(`${aliasRoot}/Documentation~/YUCP/icon.png`)).toEqual(icon);
    expect(assets.get(`${aliasRoot}/Documentation~/YUCP/gallery/000.png`)).toEqual(gallery);
    expect(assets.get(`${aliasRoot}/Documentation~/YUCP/product-links/000.png`)).toEqual(
      productLink
    );
    expect(assets.has(`${aliasRoot}/Documentation~/YUCP/product-links/001.png`)).toBe(false);
    const aliasManifest = JSON.parse(
      new TextDecoder().decode(assets.get(`${aliasRoot}/package.json`))
    ) as { yucp: { media: Array<Record<string, unknown>> } };
    expect(aliasManifest.yucp.media).toContainEqual({
      kind: 'product-link',
      label: 'Patreon',
      ordinal: 1,
      url: 'https://www.patreon.com/creator',
    });
    expect(
      assets.get('Packages/yucp.installed-packages/Editor/YUCP.DirectVpmInstaller.Runtime.dll')
    ).toEqual(installerRuntime);
    expect(assets.get('Packages/yucp.installed-packages/package.json')).toBeDefined();

    const descriptorEntry = [...assets].find(([pathname]) =>
      /^Packages\/yucp\.installed-packages\/JAMMR\/_temp\/YUCP_TempInstall_[0-9a-f]{32}\.json$/.test(
        pathname
      )
    );
    expect(descriptorEntry).toBeDefined();
    const descriptor = JSON.parse(new TextDecoder().decode(descriptorEntry?.[1])) as {
      vpmDependencies: Record<string, string>;
      vpmRepositories: Record<string, string>;
    };
    expect(descriptor.vpmDependencies).toEqual({
      'com.yucp.importer': '>=0.1.64',
    });
    expect(descriptor.vpmRepositories).toEqual({
      YUCP: 'https://vpm.yucp.club/index.json',
    });
  });
});
