import { copyFile, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { canonicalizeArtifact } from './canonicalizer';
import { resolveGnuArchiveTools, runCommand } from './process';

export type PackageCorpusFormat = 'opaque' | 'unitypackage' | 'zip';

export type PackageCorpusCase = {
  files: string[];
  format: PackageCorpusFormat;
  name: string;
};

export type PackageCorpusLogicalFile = {
  path: string;
  relativePath: string;
};

export type PackageCorpusLogicalVersion = {
  files: PackageCorpusLogicalFile[];
  name: string;
};

export async function listPackageCorpusFiles(directoryPath: string): Promise<string[]> {
  const paths: string[] = [];

  async function visit(currentPath: string): Promise<void> {
    for (const entry of await readdir(currentPath, { withFileTypes: true })) {
      const entryPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        paths.push(entryPath);
      } else {
        throw new Error(`Corpus contains a non-file entry: ${entryPath}`);
      }
    }
  }

  await visit(resolve(directoryPath));
  return paths.sort((left, right) => left.localeCompare(right));
}

function sequenceIdentity(
  filePath: string
): { format: PackageCorpusFormat; key: string; versionIndex: number } | null {
  const name = basename(filePath);
  const unityVersion = name.match(/ \((\d+)\)(?=\.unitypackage$)/i);
  if (/\.unitypackage$/i.test(name)) {
    return {
      format: 'unitypackage',
      key: name.replace(/ \(\d+\)(?=\.unitypackage$)/i, '').toLowerCase(),
      versionIndex: unityVersion ? Number(unityVersion[1]) : 0,
    };
  }

  const zipVersion = name.match(/ \((\d+)\)(?=\.zip$)/i);
  if (/\.zip$/i.test(name)) {
    return {
      format: 'zip',
      key: name.replace(/ \(\d+\)(?=\.zip$)/i, '').toLowerCase(),
      versionIndex: zipVersion ? Number(zipVersion[1]) : 0,
    };
  }

  const sppVersion = name.match(/_autosave_(\d+)(?=\.spp$)/i);
  if (/\.spp$/i.test(name)) {
    return {
      format: 'opaque',
      key: name.replace(/_autosave_\d+(?=\.spp$)/i, '').toLowerCase(),
      versionIndex: sppVersion ? Number(sppVersion[1]) : 0,
    };
  }

  return null;
}

export async function discoverPackageCorpusCases(corpusPath: string): Promise<PackageCorpusCase[]> {
  const groups = new Map<
    string,
    PackageCorpusCase & { entries: Array<{ filePath: string; versionIndex: number }> }
  >();

  for (const filePath of await listPackageCorpusFiles(corpusPath)) {
    const sequence = sequenceIdentity(filePath);
    if (!sequence) {
      continue;
    }
    const groupKey = `${sequence.format}:${sequence.key}`;
    const group = groups.get(groupKey) ?? {
      entries: [],
      files: [],
      format: sequence.format,
      name: sequence.key.replace(/\.(spp|unitypackage|zip)$/i, ''),
    };
    group.entries.push({ filePath, versionIndex: sequence.versionIndex });
    groups.set(groupKey, group);
  }

  const patternValue = process.env.YUCP_STORAGE_CORPUS_CASE_PATTERN?.trim();
  const pattern = patternValue ? new RegExp(patternValue, 'i') : null;
  return [...groups.values()]
    .filter((group) => group.entries.length >= 2 && (!pattern || pattern.test(group.name)))
    .map((group) => ({
      files: group.entries
        .sort(
          (left, right) =>
            left.versionIndex - right.versionIndex || left.filePath.localeCompare(right.filePath)
        )
        .map((entry) => entry.filePath),
      format: group.format,
      name: group.name,
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.format.localeCompare(right.format)
    );
}

function normalizeLogicalPath(rawPath: string): string {
  const normalized = rawPath.trim().replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    isAbsolute(normalized) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Package corpus contains an unsafe logical path: ${rawPath}`);
  }
  return segments.join('/');
}

function assertInside(parentPath: string, childPath: string): void {
  const relativePath = relative(resolve(parentPath), resolve(childPath));
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Package corpus logical path escapes its output root: ${childPath}`);
  }
}

async function writeLogicalFile(
  outputRoot: string,
  relativePath: string,
  bytes: Uint8Array,
  names: Set<string>
): Promise<void> {
  const normalizedPath = normalizeLogicalPath(relativePath);
  if (names.has(normalizedPath)) {
    throw new Error(`Package corpus contains a duplicate logical path: ${normalizedPath}`);
  }
  names.add(normalizedPath);
  const outputPath = resolve(outputRoot, normalizedPath);
  assertInside(outputRoot, outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
}

async function materializeZip(
  archivePath: string,
  outputRoot: string,
  canonicalPath: string
): Promise<void> {
  await canonicalizeArtifact({
    inputPath: archivePath,
    outputPath: canonicalPath,
  });
  const entries = unzipSync(new Uint8Array(await readFile(canonicalPath)));
  const names = new Set<string>();
  for (const [entryPath, bytes] of Object.entries(entries)) {
    if (entryPath.endsWith('/')) {
      continue;
    }
    await writeLogicalFile(outputRoot, entryPath, bytes, names);
  }
}

async function materializeUnityPackage(
  archivePath: string,
  outputRoot: string,
  workRoot: string
): Promise<void> {
  const canonicalPath = join(workRoot, 'source.canonical.unitypackage');
  const extractedRoot = join(workRoot, 'unitypackage');
  await mkdir(extractedRoot, { recursive: true });
  await canonicalizeArtifact({
    inputPath: archivePath,
    outputPath: canonicalPath,
  });
  const tarArguments = [
    '--force-local',
    '--extract',
    '--gzip',
    '--file',
    canonicalPath,
    '--directory',
    extractedRoot,
    '--no-same-owner',
    '--no-same-permissions',
  ];
  const archiveTools = await resolveGnuArchiveTools();
  await runCommand(archiveTools.tarCommand, tarArguments, { env: archiveTools.env });

  const names = new Set<string>();
  for (const entry of await readdir(extractedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      throw new Error(`Unity package contains an unexpected top-level entry: ${entry.name}`);
    }
    const entryRoot = join(extractedRoot, entry.name);
    const pathnamePath = join(entryRoot, 'pathname');
    const assetPath = join(entryRoot, 'asset');
    const pathnameStats = await lstat(pathnamePath).catch(() => null);
    const assetStats = await lstat(assetPath).catch(() => null);
    if (!pathnameStats?.isFile() || !assetStats?.isFile()) {
      throw new Error(`Unity package entry is missing a regular pathname or asset: ${entry.name}`);
    }
    const logicalPath = normalizeLogicalPath(await readFile(pathnamePath, 'utf8'));
    await writeLogicalFile(
      outputRoot,
      logicalPath,
      new Uint8Array(await readFile(assetPath)),
      names
    );

    const metaPath = join(entryRoot, 'asset.meta');
    const metaStats = await lstat(metaPath).catch(() => null);
    if (metaStats) {
      if (!metaStats.isFile()) {
        throw new Error(`Unity package metadata is not a regular file: ${entry.name}`);
      }
      await writeLogicalFile(
        outputRoot,
        `${logicalPath}.meta`,
        new Uint8Array(await readFile(metaPath)),
        names
      );
    }
  }
}

export async function materializePackageCorpusVersion(input: {
  archivePath: string;
  format: PackageCorpusFormat;
  outputRoot: string;
}): Promise<PackageCorpusLogicalVersion> {
  const outputRoot = resolve(input.outputRoot);
  const workRoot = join(dirname(outputRoot), `.${basename(outputRoot)}-evaluation-work`);
  await mkdir(outputRoot, { recursive: true });
  await mkdir(workRoot, { recursive: true });

  if (input.format === 'opaque') {
    const outputPath = join(outputRoot, 'payload.spp');
    await copyFile(input.archivePath, outputPath);
  } else if (input.format === 'zip') {
    await materializeZip(input.archivePath, outputRoot, join(workRoot, 'source.canonical.zip'));
  } else {
    await materializeUnityPackage(input.archivePath, outputRoot, workRoot);
  }

  const files = (await listPackageCorpusFiles(outputRoot)).map((filePath) => ({
    path: filePath,
    relativePath: relative(outputRoot, filePath).replaceAll('\\', '/'),
  }));
  if (files.length === 0) {
    throw new Error(`Package corpus archive produced no logical files: ${input.archivePath}`);
  }
  for (const file of files) {
    const fileStats = await stat(file.path);
    if (!fileStats.isFile()) {
      throw new Error(`Package corpus logical path is not a file: ${file.path}`);
    }
  }
  return {
    files,
    name: basename(input.archivePath),
  };
}

export async function materializePackageCorpusCase(
  corpusCase: PackageCorpusCase,
  outputRoot: string
): Promise<PackageCorpusLogicalVersion[]> {
  const versions: PackageCorpusLogicalVersion[] = [];
  for (const [versionIndex, archivePath] of corpusCase.files.entries()) {
    versions.push(
      await materializePackageCorpusVersion({
        archivePath,
        format: corpusCase.format,
        outputRoot: join(outputRoot, `v${versionIndex}`),
      })
    );
  }
  return versions;
}
