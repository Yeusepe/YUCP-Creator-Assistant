import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { buildLocalImporterRepository } from './localVpmRepository';
import {
  buildNativeRuntimePackageOverlay,
  createNativeRuntimeRelease,
  readNativeRuntimeReleaseManifest,
} from './nativeRuntimeRelease';
import { buildPinnedLocalImporterRepository } from './publicImporterRelease';

const TRUST_SOURCE = `namespace YUCP.Importer.Editor.PackageManager.Core
{
    internal static class NativePackageRuntimeReleaseTrust
    {
        internal const string ExecutableSha256 = "";
        internal const string MetadataUrl = "";
        internal const string PublisherCertificateSha256 = "";
        internal const string PublisherSubject = "";
        internal const string PublisherTrustMode = "";
        internal const string TargetsUrl = "";
        internal const string TrustedRootSha256 = "";
    }
}
`;
const METADATA_URL = 'https://api.creators.yucp.club/api/v2/package-installer/tuf/metadata';
const TARGETS_URL = 'https://api.creators.yucp.club/api/v2/package-installer/tuf/targets';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('native importer runtime release', () => {
  test('injects exact reviewed artifacts and release trust', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-native-runtime-release-'));
    try {
      const importerPath = join(scratchPath, 'com.yucp.importer');
      const releasePath = join(scratchPath, 'release');
      const trustSourcePath = join(
        importerPath,
        'Editor',
        'PackageManager',
        'Core',
        'NativePackageRuntimeTrust.cs'
      );
      const executable = Uint8Array.from([0x4d, 0x5a, 0x01, 0x02]);
      const root = new TextEncoder().encode('{"signed":{"_type":"root"}}');
      await mkdir(join(importerPath, 'Editor', 'PackageManager', 'Core'), {
        recursive: true,
      });
      await mkdir(releasePath, { recursive: true });
      await writeFile(trustSourcePath, TRUST_SOURCE);
      await writeFile(join(releasePath, 'yucp-transfer-helper.exe'), executable);
      await writeFile(join(releasePath, '1.root.json'), root);
      const manifestPath = join(releasePath, 'native-runtime-release.json');
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          executable: {
            fileName: 'yucp-transfer-helper.exe',
            sha256: sha256(executable),
          },
          metadataUrl: METADATA_URL,
          publisher: {
            certificateSha256: 'c'.repeat(64),
            subject: 'CN=YUCP Club, O=YUCP Club, C=US',
            trustMode: 'system',
          },
          schemaVersion: 1,
          targetsUrl: TARGETS_URL,
          trustedRoot: {
            fileName: '1.root.json',
            sha256: sha256(root),
          },
        })}\n`
      );

      const release = await readNativeRuntimeReleaseManifest(manifestPath, async () => {});
      const overlay = await buildNativeRuntimePackageOverlay(importerPath, release);

      expect(
        new TextDecoder().decode(
          overlay['Editor/PackageManager/Runtime/Windows/x64/yucp-transfer-helper.exe']
        )
      ).toBe(new TextDecoder().decode(executable));
      expect(new TextDecoder().decode(overlay['Editor/PackageManager/Trust/1.root.json'])).toBe(
        new TextDecoder().decode(root)
      );
      const generatedTrust = new TextDecoder().decode(
        overlay['Editor/PackageManager/Core/NativePackageRuntimeTrust.cs']
      );
      expect(generatedTrust).toContain(`ExecutableSha256 = "${sha256(executable)}"`);
      expect(generatedTrust).toContain(`MetadataUrl = "${METADATA_URL}"`);
      expect(generatedTrust).toContain(`TrustedRootSha256 = "${sha256(root)}"`);
      expect(generatedTrust).toContain(`PublisherCertificateSha256 = "${'c'.repeat(64)}"`);
      expect(generatedTrust).toContain('PublisherSubject = "CN=YUCP Club, O=YUCP Club, C=US"');
      expect(generatedTrust).toContain('PublisherTrustMode = "system"');
      expect(generatedTrust).toContain(`TargetsUrl = "${TARGETS_URL}"`);
    } finally {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test('rejects a changed artifact before packaging', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-native-runtime-tamper-'));
    try {
      await writeFile(join(scratchPath, 'yucp-transfer-helper.exe'), 'changed');
      await writeFile(join(scratchPath, '1.root.json'), '{}');
      const manifestPath = join(scratchPath, 'native-runtime-release.json');
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          executable: {
            fileName: 'yucp-transfer-helper.exe',
            sha256: 'a'.repeat(64),
          },
          metadataUrl: METADATA_URL,
          publisher: {
            certificateSha256: 'c'.repeat(64),
            subject: 'CN=YUCP Club',
            trustMode: 'system',
          },
          schemaVersion: 1,
          targetsUrl: TARGETS_URL,
          trustedRoot: {
            fileName: '1.root.json',
            sha256: 'b'.repeat(64),
          },
        })}\n`
      );

      await expect(readNativeRuntimeReleaseManifest(manifestPath, async () => {})).rejects.toThrow(
        'does not match its release manifest'
      );
    } finally {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test('packages the generated release overlay without changing the source tree', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-native-runtime-package-'));
    try {
      const importerPath = join(scratchPath, 'com.yucp.importer');
      const releasePath = join(scratchPath, 'release');
      const trustSourcePath = join(
        importerPath,
        'Editor',
        'PackageManager',
        'Core',
        'NativePackageRuntimeTrust.cs'
      );
      const executable = Uint8Array.from([0x4d, 0x5a, 0x03, 0x04]);
      const root = new TextEncoder().encode('{"signed":{"_type":"root","version":1}}');
      await mkdir(join(importerPath, 'Editor', 'PackageManager', 'Core'), {
        recursive: true,
      });
      await mkdir(releasePath, { recursive: true });
      await writeFile(
        join(importerPath, 'package.json'),
        '{"name":"com.yucp.importer","displayName":"Importer","version":"0.1.54"}\n'
      );
      await writeFile(trustSourcePath, TRUST_SOURCE);
      await writeFile(join(releasePath, 'yucp-transfer-helper.exe'), executable);
      await writeFile(join(releasePath, '1.root.json'), root);
      const manifestPath = join(releasePath, 'native-runtime-release.json');
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          executable: {
            fileName: 'yucp-transfer-helper.exe',
            sha256: sha256(executable),
          },
          metadataUrl: METADATA_URL,
          publisher: {
            certificateSha256: 'c'.repeat(64),
            subject: 'CN=YUCP Club',
            trustMode: 'system',
          },
          schemaVersion: 1,
          targetsUrl: TARGETS_URL,
          trustedRoot: {
            fileName: '1.root.json',
            sha256: sha256(root),
          },
        })}\n`
      );
      const release = await readNativeRuntimeReleaseManifest(manifestPath, async () => {});
      const repository = await buildLocalImporterRepository({
        baseUrl: 'http://127.0.0.1:3004',
        importerPath,
        nativeRuntimeRelease: release,
      });
      const files = unzipSync(repository.archive);

      expect(files['Editor/PackageManager/Runtime/Windows/x64/yucp-transfer-helper.exe']).toEqual(
        executable
      );
      expect(files['Editor/PackageManager/Trust/1.root.json']).toEqual(root);
      expect(new TextDecoder().decode(await readFile(trustSourcePath))).toBe(TRUST_SOURCE);
    } finally {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test('rejects a public importer build without reviewed runtime release input', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-native-runtime-required-'));
    try {
      await writeFile(
        join(scratchPath, 'package.json'),
        '{"name":"com.yucp.importer","displayName":"Importer","version":"0.1.54"}\n'
      );

      await expect(
        buildPinnedLocalImporterRepository({
          baseUrl: 'http://127.0.0.1:3004',
          importerPath: scratchPath,
          releaseLedgerPath: join(scratchPath, 'missing-ledger.json'),
        })
      ).rejects.toThrow('native runtime release manifest is required');
    } finally {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test('creates a release manifest from an OS-verified signed executable', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-native-runtime-create-'));
    try {
      const sourcePath = join(scratchPath, 'source-helper.exe');
      const rootPath = join(scratchPath, 'reviewed-root.json');
      const releasePath = join(scratchPath, 'release');
      const executable = Uint8Array.from([0x4d, 0x5a, 0x05, 0x06]);
      const root = new TextEncoder().encode('{"signed":{"_type":"root","version":1}}');
      await writeFile(sourcePath, executable);
      await writeFile(rootPath, root);

      const manifestPath = await createNativeRuntimeRelease({
        executablePath: sourcePath,
        metadataUrl: METADATA_URL,
        publisherInspector: async () => ({
          certificateSha256: 'd'.repeat(64),
          subject: 'CN=YUCP Club',
        }),
        publisherTrustMode: 'system',
        releasePath,
        targetsUrl: TARGETS_URL,
        trustedRootPath: rootPath,
      });
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        executable: { sha256: string };
        publisher: { certificateSha256: string; subject: string; trustMode: string };
        trustedRoot: { sha256: string };
      };

      expect(manifest.executable.sha256).toBe(sha256(executable));
      expect(manifest.trustedRoot.sha256).toBe(sha256(root));
      expect(manifest.publisher).toEqual({
        certificateSha256: 'd'.repeat(64),
        subject: 'CN=YUCP Club',
        trustMode: 'system',
      });
      expect(new Uint8Array(await readFile(join(releasePath, 'yucp-transfer-helper.exe')))).toEqual(
        executable
      );
      expect(new Uint8Array(await readFile(join(releasePath, '1.root.json')))).toEqual(root);
    } finally {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test('limits pinned development publishers to local repositories and identities', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-native-runtime-dev-trust-'));
    try {
      const sourcePath = join(scratchPath, 'source-helper.exe');
      const rootPath = join(scratchPath, 'reviewed-root.json');
      await writeFile(sourcePath, Uint8Array.from([0x4d, 0x5a, 0x07, 0x08]));
      await writeFile(rootPath, '{"signed":{"_type":"root","version":1}}');

      await expect(
        createNativeRuntimeRelease({
          executablePath: sourcePath,
          metadataUrl: METADATA_URL,
          publisherInspector: async () => ({
            certificateSha256: 'e'.repeat(64),
            subject: 'CN=YUCP Local Development test',
          }),
          publisherTrustMode: 'pinned-development',
          releasePath: join(scratchPath, 'release'),
          targetsUrl: TARGETS_URL,
          trustedRootPath: rootPath,
        })
      ).rejects.toThrow('pinned development publisher requires loopback');
    } finally {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test('pins the production publisher to canonical HTTPS repositories and identity', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-native-runtime-production-trust-'));
    try {
      const sourcePath = join(scratchPath, 'source-helper.exe');
      const rootPath = join(scratchPath, 'reviewed-root.json');
      await writeFile(sourcePath, Uint8Array.from([0x4d, 0x5a, 0x09, 0x0a]));
      await writeFile(rootPath, '{"signed":{"_type":"root","version":1}}');

      const manifestPath = await createNativeRuntimeRelease({
        executablePath: sourcePath,
        metadataUrl: 'https://verify.creators.yucp.club/api/v2/package-installer/tuf/metadata',
        publisherInspector: async () => ({
          certificateSha256: 'f'.repeat(64),
          subject: 'CN=YUCP Package Runtime',
        }),
        publisherTrustMode: 'pinned-production',
        releasePath: join(scratchPath, 'release'),
        targetsUrl: 'https://verify.creators.yucp.club/api/v2/package-installer/tuf/targets',
        trustedRootPath: rootPath,
      });
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        publisher: { trustMode: string };
      };

      expect(manifest.publisher.trustMode).toBe('pinned-production');

      await expect(
        createNativeRuntimeRelease({
          executablePath: sourcePath,
          metadataUrl: METADATA_URL,
          publisherInspector: async () => ({
            certificateSha256: 'f'.repeat(64),
            subject: 'CN=Different Publisher',
          }),
          publisherTrustMode: 'pinned-production',
          releasePath: join(scratchPath, 'invalid-release'),
          targetsUrl: TARGETS_URL,
          trustedRootPath: rootPath,
        })
      ).rejects.toThrow('pinned production publisher');
    } finally {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });
});
