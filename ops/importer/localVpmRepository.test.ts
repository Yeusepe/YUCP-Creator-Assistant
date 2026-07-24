import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { buildLocalImporterRepository } from './localVpmRepository';

describe('local public importer repository', () => {
  test('packages the configured real importer tree into a valid VPM index', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-local-vpm-'));
    const importerPath = join(scratchPath, 'com.yucp.importer');
    try {
      await mkdir(join(importerPath, 'Editor'), { recursive: true });
      await writeFile(
        join(importerPath, 'package.json'),
        `${JSON.stringify(
          {
            name: 'com.yucp.importer',
            displayName: 'YUCP Package Importer',
            version: '0.1.14',
          },
          null,
          2
        )}\n`
      );
      await writeFile(join(importerPath, 'Editor', 'Importer.cs'), 'namespace YUCP {}\n');

      const repository = await buildLocalImporterRepository({
        baseUrl: 'http://127.0.0.1:3004',
        importerPath,
      });
      const manifest = repository.index.packages['com.yucp.importer']?.versions['0.1.14'];

      expect(manifest).toMatchObject({
        name: 'com.yucp.importer',
        displayName: 'YUCP Package Importer',
        version: '0.1.14',
        url: 'http://127.0.0.1:3004/packages/com.yucp.importer-0.1.14.zip',
      });
      expect(manifest?.zipSHA256).toBe(
        createHash('sha256').update(repository.archive).digest('hex')
      );
      const files = unzipSync(repository.archive);
      expect(new TextDecoder().decode(files['Editor/Importer.cs'])).toBe('namespace YUCP {}\n');
      expect(JSON.parse(new TextDecoder().decode(files['package.json']))).toMatchObject({
        name: 'com.yucp.importer',
        version: '0.1.14',
      });
    } finally {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test('rejects a source tree that is not the importer package', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-local-vpm-invalid-'));
    try {
      await writeFile(
        join(scratchPath, 'package.json'),
        '{"name":"com.example.other","displayName":"Other","version":"1.0.0"}\n'
      );
      await expect(
        buildLocalImporterRepository({
          baseUrl: 'http://127.0.0.1:3004',
          importerPath: scratchPath,
        })
      ).rejects.toThrow('must identify com.yucp.importer');
    } finally {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test('packages the importer when the local timezone is behind UTC', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-local-vpm-timezone-'));
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = 'America/Bogota';
      await writeFile(
        join(scratchPath, 'package.json'),
        '{"name":"com.yucp.importer","displayName":"Importer","version":"0.1.14"}\n'
      );

      const repository = await buildLocalImporterRepository({
        baseUrl: 'http://127.0.0.1:3004',
        importerPath: scratchPath,
      });

      expect(repository.archive.byteLength).toBeGreaterThan(0);
    } finally {
      if (originalTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimezone;
      }
      await rm(scratchPath, { force: true, recursive: true });
    }
  });
});
