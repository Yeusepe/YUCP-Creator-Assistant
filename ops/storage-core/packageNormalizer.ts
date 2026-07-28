import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  canonicalizeArtifact,
  extractZipEntries,
  MAX_ARCHIVE_ENTRIES,
  type ZipEntry,
} from './canonicalizer';
import { resolveGnuArchiveTools, runCommand } from './process';
import {
  MAX_VPM_BOOTSTRAP_MEDIA_BYTES,
  type VpmBootstrapMediaContentType,
  type VpmBootstrapMediaKind,
} from './vpmBootstrapMedia';

const GUID_PATTERN = /^[0-9a-f]{32}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const OPAQUE_SPP_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}\.spp$/i;
export const MAX_UNITY_PACKAGE_ICON_BYTES = MAX_VPM_BOOTSTRAP_MEDIA_BYTES;
const MAX_PACKAGE_PRESENTATION_METADATA_BYTES = 256 * 1024;
const MAX_PRODUCT_LINKS = 32;
const MAX_GALLERY_IMAGES = 8;
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Uint8Array.from([0xff, 0xd8, 0xff]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type NormalizedPackageFile = {
  bytes: number;
  normalizedPath: string;
  path: string;
  sha256: string;
};

export type NormalizedPackage = {
  envelopeMetadata: NormalizedPackageEnvelopeMetadata[];
  files: NormalizedPackageFile[];
  format: 'project-zip' | 'spp' | 'unitypackage' | 'vpm-zip';
  outputRoot: string;
};

export type NormalizedPackageEnvelopeMetadata = {
  body: Uint8Array;
  bytes: number;
  contentType: VpmBootstrapMediaContentType;
  kind: VpmBootstrapMediaKind;
  label?: string;
  localPath: string;
  name: string;
  ordinal?: number;
  sha256: string;
  url?: string;
};

function normalizeLogicalPath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    (segments[0] !== 'Assets' && segments[0] !== 'Packages')
  ) {
    throw new Error(`Package contains an unsafe logical path: ${value}`);
  }
  return segments.join('/');
}

function assertInside(root: string, path: string): void {
  const value = relative(resolve(root), resolve(path));
  if (
    value === '' ||
    value === '..' ||
    value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(value)
  ) {
    throw new Error(`Package output escaped its logical root: ${path}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function copyLogicalFile(input: {
  names: Set<string>;
  normalizedPath: string;
  outputRoot: string;
  sourcePath: string;
}): Promise<NormalizedPackageFile> {
  const normalizedPath = normalizeLogicalPath(input.normalizedPath);
  const collisionKey = normalizedPath.toUpperCase();
  if (input.names.has(collisionKey)) {
    throw new Error(`Package contains a duplicate logical path: ${normalizedPath}`);
  }
  input.names.add(collisionKey);
  const destination = join(input.outputRoot, ...normalizedPath.split('/'));
  assertInside(input.outputRoot, destination);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(input.sourcePath, destination, 0);
  const details = await stat(destination);
  if (!details.isFile()) {
    throw new Error(`Package logical output is not a regular file: ${normalizedPath}`);
  }
  return {
    bytes: details.size,
    normalizedPath,
    path: destination,
    sha256: await sha256File(destination),
  };
}

function commonZipPrefix(entries: ZipEntry[]): string | undefined {
  const fileNames = entries.filter((entry) => !entry.directory).map((entry) => entry.name);
  if (fileNames.includes('package.json')) {
    return '';
  }
  const packageJsonEntries = fileNames.filter((name) => name.endsWith('/package.json'));
  if (packageJsonEntries.length !== 1) {
    return undefined;
  }
  const prefix = packageJsonEntries[0].slice(0, -'package.json'.length);
  return fileNames.every((name) => name.startsWith(prefix)) ? prefix : undefined;
}

function imageContentType(bytes: Uint8Array, sourcePath: string): VpmBootstrapMediaContentType {
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return 'image/png';
  }
  if (JPEG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return 'image/jpeg';
  }
  throw new Error(`Package presentation image is not a supported PNG or JPEG: ${sourcePath}`);
}

function presentationLocalPath(
  kind: VpmBootstrapMediaKind,
  contentType: VpmBootstrapMediaContentType,
  ordinal?: number
): string {
  const extension = contentType === 'image/png' ? 'png' : 'jpg';
  if (kind === 'icon' || kind === 'banner') {
    return `Documentation~/YUCP/${kind}.${extension}`;
  }
  const directory = kind === 'gallery' ? 'gallery' : 'product-links';
  return `Documentation~/YUCP/${directory}/${String(ordinal).padStart(3, '0')}.${extension}`;
}

function presentationText(
  value: unknown,
  field: string,
  maximumBytes: number,
  allowEmpty = false
): string {
  if (typeof value !== 'string') {
    throw new Error(`Package presentation ${field} is invalid`);
  }
  const normalized = value.trim();
  if (
    (!allowEmpty && !normalized) ||
    new TextEncoder().encode(normalized).byteLength > maximumBytes ||
    Array.from(normalized).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new Error(`Package presentation ${field} is invalid`);
  }
  return normalized;
}

function presentationUrl(value: unknown, field: string): string {
  const text = presentationText(value, field, 2_048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Package presentation ${field} is invalid`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`Package presentation ${field} is invalid`);
  }
  return url.toString();
}

async function readPresentationImage(input: {
  fileByPath: ReadonlyMap<string, NormalizedPackageFile>;
  kind: VpmBootstrapMediaKind;
  label?: string;
  ordinal?: number;
  sourcePath: unknown;
  url?: string;
}): Promise<NormalizedPackageEnvelopeMetadata> {
  const sourcePath = presentationText(input.sourcePath, `${input.kind} path`, 2_048).replaceAll(
    '\\',
    '/'
  );
  const file = input.fileByPath.get(sourcePath);
  if (!file) {
    throw new Error(`Package presentation image is missing: ${sourcePath}`);
  }
  if (file.bytes < PNG_SIGNATURE.byteLength || file.bytes > MAX_VPM_BOOTSTRAP_MEDIA_BYTES) {
    throw new Error(`Package presentation image size is invalid: ${sourcePath}`);
  }
  const body = Uint8Array.from(await readFile(file.path));
  if (body.byteLength !== file.bytes) {
    throw new Error(`Package presentation image changed during ingest: ${sourcePath}`);
  }
  const contentType = imageContentType(body, sourcePath);
  return {
    body,
    bytes: body.byteLength,
    contentType,
    kind: input.kind,
    localPath: presentationLocalPath(input.kind, contentType, input.ordinal),
    name: basename(sourcePath),
    sha256: file.sha256,
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.url === undefined ? {} : { url: input.url }),
  };
}

async function extractPackagePresentationMedia(input: {
  fallbackIcon?: NormalizedPackageEnvelopeMetadata;
  files: readonly NormalizedPackageFile[];
}): Promise<NormalizedPackageEnvelopeMetadata[]> {
  const metadataFiles = input.files.filter(
    (file) =>
      file.normalizedPath.startsWith('Packages/yucp.installed-packages/') &&
      file.normalizedPath.endsWith('/YUCP_PackageInfo.json')
  );
  if (metadataFiles.length === 0) {
    return input.fallbackIcon ? [input.fallbackIcon] : [];
  }
  if (metadataFiles.length > 1) {
    throw new Error('Unity package contains multiple YUCP presentation metadata files');
  }
  const metadataFile = metadataFiles[0] as NormalizedPackageFile;
  if (metadataFile.bytes < 2 || metadataFile.bytes > MAX_PACKAGE_PRESENTATION_METADATA_BYTES) {
    throw new Error('YUCP package presentation metadata size is invalid');
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(metadataFile.path, 'utf8'));
  } catch (error) {
    throw new Error('YUCP package presentation metadata is invalid', { cause: error });
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('YUCP package presentation metadata is invalid');
  }
  const value = metadata as Record<string, unknown>;
  const fileByPath = new Map(input.files.map((file) => [file.normalizedPath, file]));
  const media: NormalizedPackageEnvelopeMetadata[] = [];
  for (const kind of ['banner', 'icon'] as const) {
    const sourcePath = value[kind];
    if (sourcePath === undefined || sourcePath === null || sourcePath === '') {
      continue;
    }
    media.push(
      await readPresentationImage({
        fileByPath,
        kind,
        sourcePath,
      })
    );
  }
  if (!media.some((item) => item.kind === 'icon') && input.fallbackIcon) {
    media.push(input.fallbackIcon);
  }

  const galleryImages = value.galleryImages;
  if (galleryImages !== undefined) {
    if (!Array.isArray(galleryImages) || galleryImages.length > MAX_GALLERY_IMAGES) {
      throw new Error('YUCP package gallery metadata is invalid');
    }
    for (const [ordinal, sourcePath] of galleryImages.entries()) {
      media.push(
        await readPresentationImage({
          fileByPath,
          kind: 'gallery',
          ordinal,
          sourcePath,
        })
      );
    }
  }

  const productLinks = value.productLinks;
  if (productLinks !== undefined) {
    if (!Array.isArray(productLinks) || productLinks.length > MAX_PRODUCT_LINKS) {
      throw new Error('YUCP package product link metadata is invalid');
    }
    for (const [ordinal, candidate] of productLinks.entries()) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error(`YUCP package product link ${ordinal} is invalid`);
      }
      const link = candidate as Record<string, unknown>;
      if (link.icon === undefined || link.icon === null || link.icon === '') {
        continue;
      }
      media.push(
        await readPresentationImage({
          fileByPath,
          kind: 'product-link',
          label: presentationText(link.label, `product link ${ordinal} label`, 120),
          ordinal,
          sourcePath: link.icon,
          url: presentationUrl(link.url, `product link ${ordinal} URL`),
        })
      );
    }
  }
  return media.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      (left.ordinal ?? 0) - (right.ordinal ?? 0) ||
      left.localPath.localeCompare(right.localPath)
  );
}

async function normalizeZip(
  canonicalPath: string,
  extractionRoot: string,
  outputRoot: string,
  packageId: string
): Promise<{ files: NormalizedPackageFile[]; format: 'vpm-zip' | 'project-zip' }> {
  await mkdir(extractionRoot);
  const entries = await extractZipEntries(canonicalPath, extractionRoot, 20 * 1024 ** 3);
  const fileEntries = entries.filter(
    (entry): entry is ZipEntry & { path: string } => !entry.directory && Boolean(entry.path)
  );
  if (fileEntries.length === 0 || fileEntries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('ZIP contains no installable files');
  }
  const names = new Set<string>();
  const directProjectTree = fileEntries.every(
    (entry) => entry.name.startsWith('Assets/') || entry.name.startsWith('Packages/')
  );
  if (directProjectTree) {
    const files: NormalizedPackageFile[] = [];
    for (const entry of fileEntries.sort((left, right) => compareText(left.name, right.name))) {
      files.push(
        await copyLogicalFile({
          names,
          normalizedPath: entry.name,
          outputRoot,
          sourcePath: entry.path,
        })
      );
    }
    return { files, format: 'project-zip' };
  }

  const prefix = commonZipPrefix(entries);
  if (prefix === undefined) {
    throw new Error('ZIP is neither a Unity project tree nor one VPM package');
  }
  const packageJson = fileEntries.find((entry) => entry.name === `${prefix}package.json`);
  if (!packageJson) {
    throw new Error('VPM ZIP has no package.json');
  }
  let packageName: unknown;
  try {
    packageName = JSON.parse(await readFile(packageJson.path, 'utf8')).name;
  } catch (error) {
    throw new Error('VPM ZIP package.json is invalid', { cause: error });
  }
  if (typeof packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new Error('VPM ZIP package name is invalid');
  }
  if (packageName !== packageId) {
    throw new Error('VPM ZIP package name does not match the registered package ID');
  }
  const files: NormalizedPackageFile[] = [];
  for (const entry of fileEntries.sort((left, right) => compareText(left.name, right.name))) {
    const relativeName = entry.name.slice(prefix.length);
    files.push(
      await copyLogicalFile({
        names,
        normalizedPath: `Packages/${packageName}/${relativeName}`,
        outputRoot,
        sourcePath: entry.path,
      })
    );
  }
  return { files, format: 'vpm-zip' };
}

async function normalizeUnityPackage(
  canonicalPath: string,
  recordRoot: string,
  outputRoot: string
): Promise<{
  envelopeMetadata: NormalizedPackageEnvelopeMetadata[];
  files: NormalizedPackageFile[];
}> {
  const tools = await resolveGnuArchiveTools();
  await mkdir(recordRoot);
  const archiveWorkingDirectory = dirname(canonicalPath);
  await runCommand(
    tools.tarCommand,
    [
      '--force-local',
      '--extract',
      '--gzip',
      '--file',
      basename(canonicalPath),
      '--directory',
      basename(recordRoot),
      '--no-same-owner',
      '--no-same-permissions',
    ],
    { cwd: archiveWorkingDirectory, env: tools.env }
  );
  const records = await readdir(recordRoot, { withFileTypes: true });
  if (records.length === 0 || records.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('Unity package record count is invalid');
  }
  const names = new Set<string>();
  let fallbackIcon: NormalizedPackageEnvelopeMetadata | undefined;
  const files: NormalizedPackageFile[] = [];
  for (const record of records.sort((left, right) => compareText(left.name, right.name))) {
    if (record.name === '.icon.png' && record.isFile()) {
      const iconPath = join(recordRoot, record.name);
      const details = await lstat(iconPath);
      if (
        !details.isFile() ||
        details.size < PNG_SIGNATURE.byteLength ||
        details.size > MAX_UNITY_PACKAGE_ICON_BYTES
      ) {
        throw new Error('Unity package icon metadata is invalid');
      }
      const icon = await readFile(iconPath);
      if (PNG_SIGNATURE.some((value, index) => icon[index] !== value)) {
        throw new Error('Unity package icon metadata is not a PNG file');
      }
      fallbackIcon = {
        body: Uint8Array.from(icon),
        bytes: details.size,
        contentType: 'image/png',
        kind: 'icon',
        localPath: 'Documentation~/YUCP/icon.png',
        name: '.icon.png',
        sha256: createHash('sha256').update(icon).digest('hex'),
      };
      continue;
    }
    if (!record.isDirectory() || !GUID_PATTERN.test(record.name)) {
      throw new Error(`Unity package contains an invalid record: ${record.name}`);
    }
    const root = join(recordRoot, record.name);
    const pathnamePath = join(root, 'pathname');
    const assetPath = join(root, 'asset');
    const metaPath = join(root, 'asset.meta');
    const pathnameDetails = await lstat(pathnamePath).catch(() => null);
    const assetDetails = await lstat(assetPath).catch(() => null);
    const metaDetails = await lstat(metaPath).catch(() => null);
    if (
      !pathnameDetails?.isFile() ||
      (!assetDetails?.isFile() && !metaDetails?.isFile()) ||
      (assetDetails && !assetDetails.isFile()) ||
      (metaDetails && !metaDetails.isFile())
    ) {
      throw new Error(`Unity package record is incomplete: ${record.name}`);
    }
    const logicalPath = normalizeLogicalPath(await readFile(pathnamePath, 'utf8'));
    if (assetDetails?.isFile()) {
      files.push(
        await copyLogicalFile({
          names,
          normalizedPath: logicalPath,
          outputRoot,
          sourcePath: assetPath,
        })
      );
    } else {
      const directory = join(outputRoot, ...logicalPath.split('/'));
      assertInside(outputRoot, directory);
      await mkdir(directory, { recursive: true });
    }
    if (metaDetails?.isFile()) {
      files.push(
        await copyLogicalFile({
          names,
          normalizedPath: `${logicalPath}.meta`,
          outputRoot,
          sourcePath: metaPath,
        })
      );
    }
  }
  return {
    envelopeMetadata: await extractPackagePresentationMedia({
      files,
      ...(fallbackIcon ? { fallbackIcon } : {}),
    }),
    files,
  };
}

export async function normalizePackageArtifact(input: {
  inputPath: string;
  outputRoot: string;
  packageId: string;
}): Promise<NormalizedPackage> {
  const inputPath = resolve(input.inputPath);
  const outputRoot = resolve(input.outputRoot);
  if (!PACKAGE_NAME_PATTERN.test(input.packageId)) {
    throw new Error('Registered package ID is invalid');
  }
  const parent = dirname(outputRoot);
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, '.normalize-package-'));
  const stagedTree = join(scratch, 'tree');
  const canonicalPath = join(
    scratch,
    basename(inputPath).toLowerCase().endsWith('.zip')
      ? 'package.canonical.zip'
      : basename(inputPath).toLowerCase().endsWith('.spp')
        ? 'package.canonical.spp'
        : 'package.canonical.unitypackage'
  );
  await mkdir(stagedTree);
  let complete = false;
  try {
    await canonicalizeArtifact({ inputPath, outputPath: canonicalPath });
    let normalized:
      | {
          envelopeMetadata: NormalizedPackageEnvelopeMetadata[];
          files: NormalizedPackageFile[];
          format: 'unitypackage';
        }
      | {
          envelopeMetadata: NormalizedPackageEnvelopeMetadata[];
          files: NormalizedPackageFile[];
          format: 'vpm-zip' | 'project-zip';
        }
      | {
          envelopeMetadata: NormalizedPackageEnvelopeMetadata[];
          files: NormalizedPackageFile[];
          format: 'spp';
        };
    if (inputPath.toLowerCase().endsWith('.zip')) {
      normalized = {
        ...(await normalizeZip(
          canonicalPath,
          join(scratch, 'zip-entries'),
          stagedTree,
          input.packageId
        )),
        envelopeMetadata: [],
      };
    } else if (inputPath.toLowerCase().endsWith('.unitypackage')) {
      const unityPackage = await normalizeUnityPackage(
        canonicalPath,
        join(scratch, 'unity-records'),
        stagedTree
      );
      normalized = {
        ...unityPackage,
        format: 'unitypackage',
      };
    } else if (inputPath.toLowerCase().endsWith('.spp')) {
      const filename = basename(inputPath);
      if (!OPAQUE_SPP_FILENAME_PATTERN.test(filename)) {
        throw new Error('SPP filename is not portable');
      }
      normalized = {
        envelopeMetadata: [],
        files: [
          await copyLogicalFile({
            names: new Set(),
            normalizedPath: `Packages/${input.packageId}/Sources/${filename}`,
            outputRoot: stagedTree,
            sourcePath: canonicalPath,
          }),
        ],
        format: 'spp',
      };
    } else {
      throw new Error('Package normalization supports .unitypackage, .zip, and .spp inputs');
    }
    if (normalized.files.length === 0) {
      throw new Error('Package normalization produced no logical files');
    }
    await rename(stagedTree, outputRoot);
    complete = true;
    return {
      ...normalized,
      files: normalized.files
        .map((file) => ({
          ...file,
          path: join(outputRoot, ...file.normalizedPath.split('/')),
        }))
        .sort((left, right) => compareText(left.normalizedPath, right.normalizedPath)),
      outputRoot,
    };
  } finally {
    await rm(scratch, { force: true, recursive: true });
    if (!complete) {
      await rm(outputRoot, { force: true, recursive: true });
    }
  }
}
