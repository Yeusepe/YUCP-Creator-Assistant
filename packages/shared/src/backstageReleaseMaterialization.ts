import { gunzipSync, gzipSync, unzipSync, type Zippable, zipSync } from 'fflate';
import { inferBackstageVpmDeliverySourceKind } from './backstageVpmDelivery';
import { sha256Hex } from './crypto';

const FIXED_ZIP_MTIME = new Date(315619200000);
const FIXED_GZIP_MTIME_SECONDS = 315619200;
const FIXED_TAR_MTIME_SECONDS = 315619200;

type ArchiveSourceKind = 'unitypackage' | 'zip';

export type MaterializedBackstageReleaseArtifact = {
  bytes: Uint8Array;
  byteSize: number;
  contentType: 'application/octet-stream' | 'application/zip';
  deliveryName: string;
  materializationStrategy: 'normalized_repack';
  sha256: string;
  sourceKind: ArchiveSourceKind;
};

type TarFileEntry = {
  path: string;
  data: Uint8Array;
};

function normalizeRelativeArchivePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
}

function assertSafeArchivePath(input: string): string {
  const normalized = normalizeRelativeArchivePath(input);
  if (!normalized) {
    throw new Error('Backstage release artifact contains an empty archive path.');
  }
  if (normalized.startsWith('../') || normalized === '..') {
    throw new Error(`Backstage release artifact contains unsafe archive path: ${input}`);
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Backstage release artifact contains unsafe archive path: ${input}`);
  }
  return normalized;
}

function readAscii(input: Uint8Array, start: number, length: number): string {
  return new TextDecoder()
    .decode(input.subarray(start, start + length))
    .replace(/\0.*$/, '')
    .trim();
}

function readTarOctal(input: Uint8Array, start: number, length: number): number {
  const raw = readAscii(input, start, length).replace(/\s+$/g, '');
  if (!raw) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid tar header field: ${raw}`);
  }
  return parsed;
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = new TextEncoder().encode(value);
  target.set(encoded.subarray(0, length), offset);
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeAscii(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function writeTarChecksum(target: Uint8Array, value: number): void {
  const encoded = value.toString(8).padStart(6, '0');
  writeAscii(target, 148, 6, encoded);
  target[154] = 0;
  target[155] = 0x20;
}

function splitTarPath(input: string): { name: string; prefix?: string } {
  if (input.length <= 100) {
    return { name: input };
  }

  const lastSlash = input.lastIndexOf('/');
  if (lastSlash <= 0) {
    throw new Error(`Tar entry path exceeds header limit: ${input}`);
  }
  const prefix = input.slice(0, lastSlash);
  const name = input.slice(lastSlash + 1);
  if (!name || name.length > 100 || prefix.length > 155) {
    throw new Error(`Tar entry path exceeds header limit: ${input}`);
  }
  return { name, prefix };
}

function buildTarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const { name, prefix } = splitTarPath(path);
  writeAscii(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, FIXED_TAR_MTIME_SECONDS);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(header, 257, 5, 'ustar');
  header[262] = 0;
  writeAscii(header, 263, 2, '00');
  if (prefix) {
    writeAscii(header, 345, 155, prefix);
  }
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeTarChecksum(header, checksum);
  return header;
}

function parseTarFileEntries(input: Uint8Array): TarFileEntry[] {
  const entries: TarFileEntry[] = [];
  let offset = 0;
  let pendingLongPath: string | null = null;

  while (offset + 512 <= input.byteLength) {
    const header = input.subarray(offset, offset + 512);
    offset += 512;

    if (header.every((value) => value === 0)) {
      break;
    }

    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = readTarOctal(header, 124, 12);
    const rawName = readAscii(header, 0, 100);
    const rawPrefix = readAscii(header, 345, 155);
    const combinedPath = pendingLongPath ?? [rawPrefix, rawName].filter(Boolean).join('/');
    pendingLongPath = null;
    if (!combinedPath) {
      throw new Error('Tar entry is missing its path.');
    }

    const dataEnd = offset + size;
    if (dataEnd > input.byteLength) {
      throw new Error(`Tar entry overruns archive payload: ${combinedPath}`);
    }
    const entryData = input.slice(offset, dataEnd);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === 'L') {
      pendingLongPath = assertSafeArchivePath(
        new TextDecoder().decode(entryData).replace(/\0.*$/, '').trim()
      );
      continue;
    }

    if (typeFlag !== '0' && typeFlag !== '7') {
      continue;
    }

    entries.push({
      path: assertSafeArchivePath(combinedPath),
      data: entryData,
    });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function buildCanonicalTar(entries: TarFileEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = buildTarHeader(entry.path, entry.data.byteLength);
    blocks.push(header);
    blocks.push(entry.data);
    const remainder = entry.data.byteLength % 512;
    if (remainder !== 0) {
      blocks.push(new Uint8Array(512 - remainder));
    }
  }
  blocks.push(new Uint8Array(1024));

  const totalSize = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const output = new Uint8Array(totalSize);
  let offset = 0;
  for (const block of blocks) {
    output.set(block, offset);
    offset += block.byteLength;
  }
  return output;
}

function materializeZip(sourceBytes: Uint8Array): Uint8Array {
  const archive = unzipSync(sourceBytes);
  const canonicalEntries = Object.entries(archive)
    .map(([rawPath, bytes]) => [assertSafeArchivePath(rawPath), bytes] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  const zippable: Zippable = {};
  for (const [entryPath, entryBytes] of canonicalEntries) {
    zippable[entryPath] = [
      entryBytes,
      {
        attrs: 0o644 << 16,
        level: 9,
        mtime: FIXED_ZIP_MTIME,
        os: 3,
      },
    ];
  }
  return zipSync(zippable, { level: 9 });
}

function materializeUnitypackage(sourceBytes: Uint8Array): Uint8Array {
  const tarBytes = gunzipSync(sourceBytes);
  const entries = parseTarFileEntries(tarBytes);
  const canonicalTar = buildCanonicalTar(entries);
  return gzipSync(canonicalTar, {
    level: 9,
    mtime: FIXED_GZIP_MTIME_SECONDS,
  });
}

function sanitizeCSharpIdentifier(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(normalized) ? normalized : `pkg_${normalized}`;
}

function sanitizeAssemblyNameSegment(input: string): string {
  return input.replace(/[^A-Za-z0-9_.]/g, '_').replace(/^\.*/, '') || 'package';
}

function buildEmbeddedUnitypackageInstallerSource(input: { className: string }): string {
  return [
    'using System;',
    'using System.IO;',
    'using UnityEditor;',
    'using UnityEngine;',
    '',
    'namespace Yucp.Backstage.Generated',
    '{',
    '    [Serializable]',
    '    internal sealed class BackstagePayloadManifest',
    '    {',
    '        public string packageId = "";',
    '        public string version = "";',
    '        public string displayName = "";',
    '        public string payloadFileName = "";',
    '        public string payloadSha256 = "";',
    '    }',
    '',
    '    [InitializeOnLoad]',
    `    internal static class ${input.className}`,
    '    {',
    '        private const string ManifestRelativePath = "BackstagePayload~/backstage-payload.json";',
    '        private const string PayloadRelativePath = "BackstagePayload~/payload.unitypackage";',
    '        private const string ImportStatePrefix = "yucp.backstage.imported.";',
    '',
    `        static ${input.className}()`,
    '        {',
    '            EditorApplication.delayCall += MaybeImportPayload;',
    '        }',
    '',
    '        private static void MaybeImportPayload()',
    '        {',
    '            if (EditorApplication.isCompiling || EditorApplication.isUpdating)',
    '            {',
    '                EditorApplication.delayCall += MaybeImportPayload;',
    '                return;',
    '            }',
    '',
    `            var packageInfo = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(${input.className}).Assembly);`,
    '            if (packageInfo == null || string.IsNullOrWhiteSpace(packageInfo.resolvedPath))',
    '            {',
    '                return;',
    '            }',
    '',
    '            var manifestPath = Path.Combine(packageInfo.resolvedPath, ManifestRelativePath);',
    '            var payloadPath = Path.Combine(packageInfo.resolvedPath, PayloadRelativePath);',
    '            if (!File.Exists(manifestPath) || !File.Exists(payloadPath))',
    '            {',
    '                return;',
    '            }',
    '',
    '            var manifest = JsonUtility.FromJson<BackstagePayloadManifest>(File.ReadAllText(manifestPath));',
    '            if (manifest == null || string.IsNullOrWhiteSpace(manifest.packageId) || string.IsNullOrWhiteSpace(manifest.payloadSha256))',
    '            {',
    '                return;',
    '            }',
    '',
    '            var importKey = ImportStatePrefix + manifest.packageId + "@" + manifest.version + ":" + manifest.payloadSha256;',
    '            if (EditorPrefs.GetBool(importKey, false))',
    '            {',
    '                return;',
    '            }',
    '',
    '            var displayLabel = string.IsNullOrWhiteSpace(manifest.displayName) ? manifest.packageId : manifest.displayName;',
    '            try',
    '            {',
    '                AssetDatabase.ImportPackage(payloadPath, false);',
    '                EditorPrefs.SetBool(importKey, true);',
    '                Debug.Log("[YUCP Backstage] Imported " + displayLabel + " from Backstage Repos.");',
    '            }',
    '            catch (Exception ex)',
    '            {',
    '                Debug.LogError("[YUCP Backstage] Failed to import " + displayLabel + ": " + ex.Message);',
    '            }',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
}

async function buildEmbeddedUnitypackageZip(input: {
  packageId: string;
  version: string;
  displayName?: string;
  payloadFileName: string;
  payloadBytes: Uint8Array;
}): Promise<MaterializedBackstageReleaseArtifact> {
  const payloadSha256 = await sha256Hex(input.payloadBytes);
  const suffix = payloadSha256.slice(0, 8);
  const className = `${sanitizeCSharpIdentifier(input.packageId)}_${suffix}`;
  const installerClassName = `YucpBackstageEmbeddedUnitypackageInstaller_${className}`;
  const asmdefName = `Yucp.Backstage.PackageInstaller.${sanitizeAssemblyNameSegment(input.packageId)}_${suffix}`;
  const packageJson = JSON.stringify(
    {
      name: input.packageId,
      version: input.version,
      displayName: input.displayName?.trim() || input.packageId,
    },
    null,
    2
  );
  const payloadManifest = JSON.stringify(
    {
      packageId: input.packageId,
      version: input.version,
      displayName: input.displayName?.trim() || input.packageId,
      payloadFileName: input.payloadFileName,
      payloadSha256,
    },
    null,
    2
  );
  const zippable: Zippable = {
    'package.json': [
      new TextEncoder().encode(packageJson),
      { attrs: 0o644 << 16, level: 9, mtime: FIXED_ZIP_MTIME, os: 3 },
    ],
    'Editor/Yucp.Backstage.PackageInstaller.asmdef': [
      new TextEncoder().encode(
        JSON.stringify(
          {
            name: asmdefName,
            includePlatforms: ['Editor'],
          },
          null,
          2
        )
      ),
      { attrs: 0o644 << 16, level: 9, mtime: FIXED_ZIP_MTIME, os: 3 },
    ],
    'Editor/YucpBackstageEmbeddedUnitypackageInstaller.cs': [
      new TextEncoder().encode(
        buildEmbeddedUnitypackageInstallerSource({
          className: installerClassName,
        })
      ),
      { attrs: 0o644 << 16, level: 9, mtime: FIXED_ZIP_MTIME, os: 3 },
    ],
    'BackstagePayload~/payload.unitypackage': [
      input.payloadBytes,
      { attrs: 0o644 << 16, level: 9, mtime: FIXED_ZIP_MTIME, os: 3 },
    ],
    'BackstagePayload~/backstage-payload.json': [
      new TextEncoder().encode(payloadManifest),
      { attrs: 0o644 << 16, level: 9, mtime: FIXED_ZIP_MTIME, os: 3 },
    ],
  };
  const bytes = zipSync(zippable, { level: 9 });
  return {
    bytes,
    byteSize: bytes.byteLength,
    contentType: 'application/zip',
    deliveryName: `vrc-get-${input.packageId}-${input.version}.zip`,
    materializationStrategy: 'normalized_repack',
    sha256: await sha256Hex(bytes),
    sourceKind: 'zip',
  };
}

export async function materializeBackstageReleaseArtifact(input: {
  sourceBytes: Uint8Array;
  deliveryName: string;
  contentType?: string;
  packageId?: string;
  version?: string;
  displayName?: string;
}): Promise<MaterializedBackstageReleaseArtifact> {
  const sourceKind = inferBackstageVpmDeliverySourceKind({
    deliveryName: input.deliveryName,
    contentType: input.contentType,
  });
  if (sourceKind === 'unitypackage') {
    if (!input.packageId?.trim() || !input.version?.trim()) {
      throw new Error(
        'Backstage unitypackage materialization requires packageId and version to build the deliverable wrapper.'
      );
    }
    const payloadBytes = materializeUnitypackage(input.sourceBytes);
    return await buildEmbeddedUnitypackageZip({
      packageId: input.packageId.trim(),
      version: input.version.trim(),
      displayName: input.displayName?.trim(),
      payloadFileName: input.deliveryName,
      payloadBytes,
    });
  }

  const bytes = materializeZip(input.sourceBytes);

  return {
    bytes,
    byteSize: bytes.byteLength,
    contentType: 'application/zip',
    deliveryName: input.deliveryName,
    materializationStrategy: 'normalized_repack',
    sha256: await sha256Hex(bytes),
    sourceKind: 'zip',
  };
}
