import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gzipSync, unzipSync } from 'fflate';
import type { BuiltYucpAliasVpmPackage } from './vpmAliasPackage';

const TAR_BLOCK_BYTES = 512;
const UNITY_PACKAGE_END_BLOCKS = 2;
const INSTALLER_RUNTIME_PATH =
  'Packages/yucp.installed-packages/Editor/YUCP.DirectVpmInstaller.Runtime.dll';
const INSTALLED_PACKAGE_MANIFEST_PATH = 'Packages/yucp.installed-packages/package.json';
const INSTALLER_RUNTIME_URL = new URL(
  '../assets/YUCP.DirectVpmInstaller.Runtime.dll',
  import.meta.url
);
const INSTALLER_RUNTIME_META_URL = new URL(
  '../assets/YUCP.DirectVpmInstaller.Runtime.dll.meta',
  import.meta.url
);
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const VPM_PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,213}$/;

export type YucpBootstrapUnityPackageRuntime = {
  installerRuntime: Uint8Array;
  installerRuntimeMeta: Uint8Array;
};

export type BuiltYucpBootstrapUnityPackage = {
  bytes: Uint8Array;
  sha256: string;
};

type UnityPackageAsset = {
  bytes: Uint8Array;
  meta: Uint8Array;
  pathname: string;
};

function writeText(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = TEXT_ENCODER.encode(value);
  if (bytes.byteLength > length) {
    throw new Error('Unity package tar metadata exceeds its field limit');
  }
  target.set(bytes, offset);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
  suffix = '\0'
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Unity package tar metadata contains an invalid number');
  }
  const digits = value.toString(8).padStart(length - suffix.length, '0');
  if (digits.length + suffix.length > length) {
    throw new Error('Unity package tar metadata exceeds its numeric field limit');
  }
  writeText(target, offset, length, `${digits}${suffix}`);
}

function buildTarHeader(pathname: string, byteSize: number): Uint8Array {
  if (!pathname || TEXT_ENCODER.encode(pathname).byteLength > 100) {
    throw new Error('Unity package tar entry path is invalid');
  }
  const header = new Uint8Array(TAR_BLOCK_BYTES);
  writeText(header, 0, 100, pathname);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, byteSize);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeText(header, 257, 6, 'ustar\0');
  writeText(header, 263, 2, '00');
  writeText(header, 265, 32, 'yucp');
  writeText(header, 297, 32, 'yucp');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeOctal(header, 148, 8, checksum, '\0 ');
  return header;
}

function buildTar(entries: ReadonlyArray<{ bytes: Uint8Array; path: string }>): Uint8Array {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes =
    sorted.reduce(
      (sum, entry) =>
        sum +
        TAR_BLOCK_BYTES +
        Math.ceil(entry.bytes.byteLength / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES,
      0
    ) +
    UNITY_PACKAGE_END_BLOCKS * TAR_BLOCK_BYTES;
  const tar = new Uint8Array(totalBytes);
  let offset = 0;
  for (const entry of sorted) {
    tar.set(buildTarHeader(entry.path, entry.bytes.byteLength), offset);
    offset += TAR_BLOCK_BYTES;
    tar.set(entry.bytes, offset);
    offset += Math.ceil(entry.bytes.byteLength / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  return tar;
}

function deterministicGuid(seed: string): string {
  return createHash('sha256')
    .update(seed.replaceAll('\\', '/').toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

function textImporterMeta(guid: string): Uint8Array {
  return TEXT_ENCODER.encode(
    `fileFormatVersion: 2\nguid: ${guid}\nTextScriptImporter:\n  externalObjects: {}\n  userData:\n  assetBundleName:\n  assetBundleVariant:\n`
  );
}

function textureImporterMeta(guid: string): Uint8Array {
  return TEXT_ENCODER.encode(
    `fileFormatVersion: 2\nguid: ${guid}\nTextureImporter:\n  internalIDToNameTable: []\n  externalObjects: {}\n  serializedVersion: 11\n  mipmaps:\n    mipMapMode: 0\n    enableMipMap: 1\n    sRGBTexture: 1\n  isReadable: 0\n  streamingMipmaps: 0\n  textureType: 0\n  textureShape: 1\n  maxTextureSizeSet: 0\n  compressionQualitySet: 0\n  textureFormatSet: 0\n  platformSettings: []\n  spriteSheet:\n    serializedVersion: 2\n    sprites: []\n    outline: []\n    physicsShape: []\n    bones: []\n    spriteID:\n    internalID: 0\n    vertices: []\n    indices:\n    edges: []\n    weights: []\n    secondaryTextures: []\n  userData:\n  assetBundleName:\n  assetBundleVariant:\n`
  );
}

function normalizeImporterRepositoryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Unity bootstrap importer repository must use an absolute HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Unity bootstrap importer repository must use an absolute HTTPS URL');
  }
  return url.toString();
}

function safeWorkspaceName(value: unknown, packageId: string): string {
  const source = typeof value === 'string' ? value.trim() : '';
  const normalized = (source || packageId)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'YUCP-Bootstrap';
}

function parseBootstrapManifest(bootstrap: BuiltYucpAliasVpmPackage): Record<string, unknown> {
  if (!VPM_PACKAGE_ID_PATTERN.test(bootstrap.packageId)) {
    throw new Error('Unity bootstrap package ID is invalid');
  }
  const archive = unzipSync(bootstrap.bytes);
  const packageJson = archive['package.json'];
  if (!packageJson) {
    throw new Error('Unity bootstrap VPM archive is missing package.json');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(TEXT_DECODER.decode(packageJson));
  } catch {
    throw new Error('Unity bootstrap VPM package.json is invalid');
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    (manifest as Record<string, unknown>).name !== bootstrap.packageId ||
    (manifest as Record<string, unknown>).version !== bootstrap.manifest.version
  ) {
    throw new Error('Unity bootstrap VPM manifest does not match its package');
  }
  return manifest as Record<string, unknown>;
}

function bootstrapAssets(
  bootstrap: BuiltYucpAliasVpmPackage,
  manifest: Record<string, unknown>
): UnityPackageAsset[] {
  const archive = unzipSync(bootstrap.bytes);
  const yucp =
    manifest.yucp && typeof manifest.yucp === 'object' && !Array.isArray(manifest.yucp)
      ? (manifest.yucp as Record<string, unknown>)
      : {};
  const media = Array.isArray(yucp.media) ? yucp.media : [];
  const allowedPaths = new Set(['package.json']);
  for (const candidate of media) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Unity bootstrap VPM media descriptor is invalid');
    }
    const localPath = (candidate as Record<string, unknown>).localPath;
    if (
      typeof localPath !== 'string' ||
      !/^Documentation~\/YUCP\/(?:(?:icon|banner)\.(?:png|jpg)|(?:gallery|product-links)\/\d{3}\.(?:png|jpg))$/.test(
        localPath
      )
    ) {
      throw new Error('Unity bootstrap VPM media descriptor path is invalid');
    }
    allowedPaths.add(localPath);
  }
  return Object.entries(archive).map(([relativePath, bytes]) => {
    if (!allowedPaths.has(relativePath)) {
      throw new Error(`Unity bootstrap VPM archive contains an unsupported path: ${relativePath}`);
    }
    const pathname = `Packages/${bootstrap.packageId}/${relativePath}`;
    const guid = deterministicGuid(pathname);
    return {
      bytes,
      meta:
        relativePath.endsWith('.png') || relativePath.endsWith('.jpg')
          ? textureImporterMeta(guid)
          : textImporterMeta(guid),
      pathname,
    };
  });
}

function installedPackageManifest(): Uint8Array {
  return TEXT_ENCODER.encode(
    `${JSON.stringify(
      {
        name: 'yucp.installed-packages',
        version: '0.0.1',
        displayName: 'YUCP Installed Packages',
        description: 'Local container for YUCP installer metadata and helper assemblies.',
        unity: '2019.4',
        hideInEditor: true,
      },
      null,
      2
    )}\n`
  );
}

function installerDescriptor(input: {
  bootstrap: BuiltYucpAliasVpmPackage;
  importerRepositoryUrl: string;
  manifest: Record<string, unknown>;
}): Uint8Array {
  return TEXT_ENCODER.encode(
    `${JSON.stringify(
      {
        name: input.bootstrap.packageId,
        displayName: input.manifest.displayName,
        version: input.bootstrap.manifest.version,
        vpmDependencies: {
          'com.yucp.importer': '>=0.1.55',
        },
        vpmRepositories: {
          YUCP: input.importerRepositoryUrl,
        },
      },
      null,
      2
    )}\n`
  );
}

function unityPackageEntries(assets: readonly UnityPackageAsset[]) {
  const entries: Array<{ bytes: Uint8Array; path: string }> = [];
  for (const asset of assets) {
    const guid = deterministicGuid(asset.pathname);
    entries.push(
      { bytes: asset.bytes, path: `${guid}/asset` },
      { bytes: asset.meta, path: `${guid}/asset.meta` },
      { bytes: TEXT_ENCODER.encode(asset.pathname), path: `${guid}/pathname` }
    );
  }
  return entries;
}

export async function loadYucpBootstrapUnityPackageRuntime(): Promise<YucpBootstrapUnityPackageRuntime> {
  const [installerRuntime, installerRuntimeMeta] = await Promise.all([
    readFile(INSTALLER_RUNTIME_URL),
    readFile(INSTALLER_RUNTIME_META_URL),
  ]);
  if (
    installerRuntime.byteLength < 2 ||
    installerRuntime[0] !== 0x4d ||
    installerRuntime[1] !== 0x5a
  ) {
    throw new Error('YUCP autoinstall runtime is not a valid Windows PE assembly');
  }
  return {
    installerRuntime: Uint8Array.from(installerRuntime),
    installerRuntimeMeta: Uint8Array.from(installerRuntimeMeta),
  };
}

export function buildYucpBootstrapUnityPackage(input: {
  bootstrap: BuiltYucpAliasVpmPackage;
  importerRepositoryUrl: string;
  installerRuntime: Uint8Array;
  installerRuntimeMeta: Uint8Array;
}): BuiltYucpBootstrapUnityPackage {
  const manifest = parseBootstrapManifest(input.bootstrap);
  const importerRepositoryUrl = normalizeImporterRepositoryUrl(input.importerRepositoryUrl);
  const workspaceName = safeWorkspaceName(manifest.displayName, input.bootstrap.packageId);
  const descriptorBytes = installerDescriptor({
    bootstrap: input.bootstrap,
    importerRepositoryUrl,
    manifest,
  });
  const descriptorGuid = deterministicGuid(
    `${input.bootstrap.packageId}:${input.bootstrap.manifest.version}:temp-install`
  );
  const descriptorPath =
    `Packages/yucp.installed-packages/${workspaceName}/_temp/` +
    `YUCP_TempInstall_${descriptorGuid}.json`;
  const manifestGuid = deterministicGuid(INSTALLED_PACKAGE_MANIFEST_PATH);
  const assets: UnityPackageAsset[] = [
    ...bootstrapAssets(input.bootstrap, manifest),
    {
      bytes: installedPackageManifest(),
      meta: textImporterMeta(manifestGuid),
      pathname: INSTALLED_PACKAGE_MANIFEST_PATH,
    },
    {
      bytes: Uint8Array.from(input.installerRuntime),
      meta: Uint8Array.from(input.installerRuntimeMeta),
      pathname: INSTALLER_RUNTIME_PATH,
    },
    {
      bytes: descriptorBytes,
      meta: textImporterMeta(descriptorGuid),
      pathname: descriptorPath,
    },
  ];
  const tar = buildTar(unityPackageEntries(assets));
  const bytes = gzipSync(tar, { level: 9, mtime: 0 });
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
