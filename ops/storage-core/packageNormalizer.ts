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

const GUID_PATTERN = /^[0-9a-f]{32}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const OPAQUE_SPP_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}\.spp$/i;
export const MAX_UNITY_PACKAGE_ICON_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  contentType: 'image/png';
  kind: 'icon';
  name: '.icon.png';
  sha256: string;
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
  const envelopeMetadata: NormalizedPackageEnvelopeMetadata[] = [];
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
      envelopeMetadata.push({
        body: icon,
        bytes: details.size,
        contentType: 'image/png',
        kind: 'icon',
        name: '.icon.png',
        sha256: createHash('sha256').update(icon).digest('hex'),
      });
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
  return { envelopeMetadata, files };
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
