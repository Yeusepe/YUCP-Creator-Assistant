import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PACKAGE_NORMALIZATION_POLICY_VERSION,
  prepareInstallablePackageTree,
} from './installablePackageTree';

async function writeLogicalFile(
  root: string,
  normalizedPath: string,
  body: string
): Promise<{
  bytes: number;
  normalizedPath: string;
  path: string;
  sha256: string;
}> {
  const path = join(root, ...normalizedPath.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
  return {
    bytes: Buffer.byteLength(body),
    normalizedPath,
    path,
    sha256: '11'.repeat(32),
  };
}

describe('installable package tree preparation', () => {
  test('consumes the legacy bootstrap container without publishing its files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-installable-tree-'));
    try {
      const files = [
        await writeLogicalFile(
          root,
          'Packages/yucp.installed-packages/package.json',
          JSON.stringify({
            name: 'yucp.installed-packages',
            version: '0.0.1',
          })
        ),
        await writeLogicalFile(
          root,
          'Packages/yucp.installed-packages/Product/_temp/YUCP_TempInstall_test.json',
          JSON.stringify({
            vpmDependencies: {
              'com.example.runtime': '>=1.0.0',
            },
          })
        ),
        await writeLogicalFile(
          root,
          'Packages/yucp.installed-packages/Editor/YUCP_InstallerPreflight_test.cs',
          'throw new System.Exception();'
        ),
        await writeLogicalFile(root, 'Assets/Product/product.asset', 'product'),
      ];

      const prepared = await prepareInstallablePackageTree(files);

      expect(PACKAGE_NORMALIZATION_POLICY_VERSION).toBe('package-normalization-policy-v2');
      expect(prepared.bootstrapMetadata.vpmDependencies).toEqual({
        'com.example.runtime': '>=1.0.0',
      });
      expect(prepared.files.map((file) => file.normalizedPath)).toEqual([
        'Assets/Product/product.asset',
      ]);
      expect(prepared.excludedFiles.map((file) => file.normalizedPath)).toEqual([
        'Packages/yucp.installed-packages/Editor/YUCP_InstallerPreflight_test.cs',
        'Packages/yucp.installed-packages/Product/_temp/YUCP_TempInstall_test.json',
        'Packages/yucp.installed-packages/package.json',
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('rejects an unrecognized legacy bootstrap container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-installable-tree-invalid-'));
    try {
      const files = [
        await writeLogicalFile(
          root,
          'Packages/yucp.installed-packages/package.json',
          JSON.stringify({
            name: 'com.example.unrelated',
            version: '1.0.0',
          })
        ),
        await writeLogicalFile(
          root,
          'Packages/yucp.installed-packages/Editor/Unexpected.cs',
          'public sealed class Unexpected {}'
        ),
      ];

      await expect(prepareInstallablePackageTree(files)).rejects.toThrow(
        'legacy bootstrap container identity'
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
