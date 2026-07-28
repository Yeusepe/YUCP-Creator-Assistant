import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { normalizePackageArtifact } from './packageNormalizer';
import { resolveGnuArchiveTools, runCommand } from './process';

describe('package normalizer', () => {
  test('normalizes a unitypackage inside a long pipeline scratch path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-normalizer-long-path-'));
    try {
      const records = join(root, 'records');
      const guid = 'd'.repeat(32);
      await mkdir(join(records, guid), { recursive: true });
      await writeFile(join(records, guid, 'asset'), 'shader bytes');
      await writeFile(join(records, guid, 'pathname'), 'Assets/Jammr/shader.shader');
      const archive = join(root, 'jammr.unitypackage');
      const tools = await resolveGnuArchiveTools();
      await runCommand(
        tools.tarCommand,
        ['--force-local', '--create', '--gzip', '--file', archive, '--directory', records, '.'],
        { env: tools.env }
      );
      const pipelinePath = join(
        root,
        'reserved-package-pipeline-scratch',
        'ingest-job-with-a-durable-identifier',
        'normalized-package-artifact'
      );

      const normalized = await normalizePackageArtifact({
        inputPath: archive,
        outputRoot: join(pipelinePath, 'tree'),
        packageId: 'com.yucp.jammr',
      });

      expect(normalized.files.map((file) => file.normalizedPath)).toEqual([
        'Assets/Jammr/shader.shader',
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('normalizes a unitypackage into its byte-exact logical tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-normalizer-unity-'));
    try {
      const records = join(root, 'records');
      const guid = 'a'.repeat(32);
      await mkdir(join(records, guid), { recursive: true });
      await writeFile(join(records, guid, 'asset'), 'shader bytes');
      await writeFile(join(records, guid, 'asset.meta'), 'fileFormatVersion: 2\n');
      await writeFile(join(records, guid, 'pathname'), 'Assets/Jammr/shader.shader');
      const archive = join(root, 'jammr.unitypackage');
      const tools = await resolveGnuArchiveTools();
      await runCommand(
        tools.tarCommand,
        ['--force-local', '--create', '--gzip', '--file', archive, '--directory', records, '.'],
        { env: tools.env }
      );

      const normalized = await normalizePackageArtifact({
        inputPath: archive,
        outputRoot: join(root, 'tree'),
        packageId: 'com.yucp.jammr',
      });

      expect(normalized.files.map((file) => file.normalizedPath)).toEqual([
        'Assets/Jammr/shader.shader',
        'Assets/Jammr/shader.shader.meta',
      ]);
      expect(await readFile(join(root, 'tree', 'Assets', 'Jammr', 'shader.shader'), 'utf8')).toBe(
        'shader bytes'
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('accepts bounded Unity package icon metadata without importing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-normalizer-unity-icon-'));
    try {
      const records = join(root, 'records');
      const guid = 'b'.repeat(32);
      const icon = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      await mkdir(join(records, guid), { recursive: true });
      await writeFile(join(records, '.icon.png'), icon);
      await writeFile(join(records, guid, 'asset'), 'material bytes');
      await writeFile(join(records, guid, 'pathname'), 'Assets/Jammr/material.mat');
      const archive = join(root, 'jammr-with-icon.unitypackage');
      const tools = await resolveGnuArchiveTools();
      await runCommand(
        tools.tarCommand,
        ['--force-local', '--create', '--gzip', '--file', archive, '--directory', records, '.'],
        { env: tools.env }
      );

      const normalized = await normalizePackageArtifact({
        inputPath: archive,
        outputRoot: join(root, 'tree'),
        packageId: 'com.yucp.jammr',
      });

      expect(normalized.files.map((file) => file.normalizedPath)).toEqual([
        'Assets/Jammr/material.mat',
      ]);
      expect(normalized.envelopeMetadata).toEqual([
        {
          body: icon,
          bytes: icon.byteLength,
          contentType: 'image/png',
          kind: 'icon',
          localPath: 'Documentation~/YUCP/icon.png',
          name: '.icon.png',
          sha256: '843ac23b1736b4487ec81cf7c07ddd9bb46ae5b7818c2c3843d99d62fa75f3c9',
        },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('extracts every package-exporter presentation image from YUCP metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-normalizer-presentation-media-'));
    try {
      const records = join(root, 'records');
      const packageRoot = 'Packages/yucp.installed-packages/Product';
      const media = [
        {
          guid: '1'.repeat(32),
          kind: 'icon',
          path: `${packageRoot}/Embedded/Icons/product.png`,
        },
        {
          guid: '2'.repeat(32),
          kind: 'banner',
          path: `${packageRoot}/Embedded/Banners/product.png`,
        },
        {
          guid: '3'.repeat(32),
          kind: 'gallery',
          path: `${packageRoot}/Embedded/Gallery/gallery-0.png`,
        },
        {
          guid: '4'.repeat(32),
          kind: 'product-link',
          path: `${packageRoot}/Embedded/ProductLinks/gumroad.png`,
        },
      ] as const;
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
      for (const item of media) {
        await mkdir(join(records, item.guid), { recursive: true });
        await writeFile(join(records, item.guid, 'asset'), png);
        await writeFile(join(records, item.guid, 'pathname'), item.path);
      }
      const metadataGuid = '5'.repeat(32);
      await mkdir(join(records, metadataGuid), { recursive: true });
      await writeFile(
        join(records, metadataGuid, 'asset'),
        JSON.stringify({
          packageName: 'Product',
          version: '1.0.0',
          author: 'Creator',
          icon: media[0].path,
          banner: media[1].path,
          galleryImages: [media[2].path],
          productLinks: [
            {
              label: 'Gumroad',
              url: 'https://creator.gumroad.com/l/product',
              icon: media[3].path,
            },
          ],
        })
      );
      await writeFile(
        join(records, metadataGuid, 'pathname'),
        `${packageRoot}/YUCP_PackageInfo.json`
      );
      const archive = join(root, 'presentation-media.unitypackage');
      const tools = await resolveGnuArchiveTools();
      await runCommand(
        tools.tarCommand,
        ['--force-local', '--create', '--gzip', '--file', archive, '--directory', records, '.'],
        { env: tools.env }
      );

      const normalized = await normalizePackageArtifact({
        inputPath: archive,
        outputRoot: join(root, 'tree'),
        packageId: 'com.yucp.product',
      });

      expect(normalized.envelopeMetadata).toEqual([
        expect.objectContaining({
          kind: 'banner',
          localPath: 'Documentation~/YUCP/banner.png',
        }),
        expect.objectContaining({
          kind: 'gallery',
          localPath: 'Documentation~/YUCP/gallery/000.png',
          ordinal: 0,
        }),
        expect.objectContaining({
          kind: 'icon',
          localPath: 'Documentation~/YUCP/icon.png',
        }),
        expect.objectContaining({
          kind: 'product-link',
          label: 'Gumroad',
          localPath: 'Documentation~/YUCP/product-links/000.png',
          ordinal: 0,
          url: 'https://creator.gumroad.com/l/product',
        }),
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('rejects unsupported Unity package icon media', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-normalizer-invalid-icon-'));
    try {
      const records = join(root, 'records');
      const guid = 'c'.repeat(32);
      await mkdir(join(records, guid), { recursive: true });
      await writeFile(join(records, '.icon.png'), 'not a png');
      await writeFile(join(records, guid, 'asset'), 'material bytes');
      await writeFile(join(records, guid, 'pathname'), 'Assets/Jammr/material.mat');
      const archive = join(root, 'invalid-icon.unitypackage');
      const tools = await resolveGnuArchiveTools();
      await runCommand(
        tools.tarCommand,
        ['--force-local', '--create', '--gzip', '--file', archive, '--directory', records, '.'],
        { env: tools.env }
      );

      await expect(
        normalizePackageArtifact({
          inputPath: archive,
          outputRoot: join(root, 'tree'),
          packageId: 'com.yucp.jammr',
        })
      ).rejects.toThrow('not a PNG');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('maps a VPM package ZIP into a package-owned logical root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-normalizer-vpm-'));
    try {
      const archive = join(root, 'jammr.zip');
      await writeFile(
        archive,
        zipSync({
          'package.json': new TextEncoder().encode(
            JSON.stringify({ name: 'com.yucp.jammr', version: '1.0.0' })
          ),
          'Runtime/Jammr.cs': new TextEncoder().encode('public sealed class Jammr {}'),
        })
      );

      const normalized = await normalizePackageArtifact({
        inputPath: archive,
        outputRoot: join(root, 'tree'),
        packageId: 'com.yucp.jammr',
      });

      expect(normalized.files.map((file) => file.normalizedPath)).toEqual([
        'Packages/com.yucp.jammr/Runtime/Jammr.cs',
        'Packages/com.yucp.jammr/package.json',
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('retains an SPP project as one byte-exact opaque logical file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-normalizer-spp-'));
    try {
      const source = join(root, 'Jammr Source.spp');
      const bytes = new Uint8Array([0x53, 0x50, 0x50, 0x00, 0xff, 0x42]);
      await writeFile(source, bytes);

      const normalized = await normalizePackageArtifact({
        inputPath: source,
        outputRoot: join(root, 'tree'),
        packageId: 'com.yucp.jammr',
      });

      expect(normalized.format).toBe('spp');
      expect(normalized.files.map((file) => file.normalizedPath)).toEqual([
        'Packages/com.yucp.jammr/Sources/Jammr Source.spp',
      ]);
      expect(
        new Uint8Array(
          await readFile(
            join(root, 'tree', 'Packages', 'com.yucp.jammr', 'Sources', 'Jammr Source.spp')
          )
        )
      ).toEqual(bytes);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
