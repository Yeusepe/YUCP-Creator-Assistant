import { closeSync, createReadStream, openSync, writeSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import {
  Unzip,
  type UnzipFile,
  UnzipInflate,
  Zip,
  ZipDeflate,
  type ZipInputFile,
  ZipPassThrough,
} from 'fflate';
import { list as listTar } from 'tar';
import { commandPathEnv, runCommand } from './process';

export const DEFAULT_MAX_DECOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;

export function canonicalizerChildEnv(): NodeJS.ProcessEnv {
  return {
    ...commandPathEnv(),
    LC_ALL: 'C',
    TZ: 'UTC',
  };
}

export const CANONICAL_FORMAT_TAGS = {
  opaque: 'RAW_OPAQUE_V1',
  tarGzip: 'CANONICAL_TARGZ_V1',
  zip: 'CANONICAL_ZIP_V1',
} as const;

export type CanonicalFormatTag = (typeof CANONICAL_FORMAT_TAGS)[keyof typeof CANONICAL_FORMAT_TAGS];

export type CanonicalArtifact = {
  byteLength: number;
  formatTag: CanonicalFormatTag;
  path: string;
};

type ZipEntry = {
  completed: boolean;
  directory: boolean;
  name: string;
  path?: string;
};

const FIXED_ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);
const ALREADY_COMPRESSED_ZIP_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.dds',
  '.flac',
  '.gif',
  '.gz',
  '.jpeg',
  '.jpg',
  '.ktx',
  '.ktx2',
  '.m4a',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.opus',
  '.png',
  '.rar',
  '.spp',
  '.unitypackage',
  '.webm',
  '.webp',
  '.zip',
]);

function formatTagForPath(inputPath: string): CanonicalFormatTag {
  const lowerPath = inputPath.toLowerCase();
  if (lowerPath.endsWith('.unitypackage') || lowerPath.endsWith('.tar.gz')) {
    return CANONICAL_FORMAT_TAGS.tarGzip;
  }
  if (lowerPath.endsWith('.zip')) {
    return CANONICAL_FORMAT_TAGS.zip;
  }
  return CANONICAL_FORMAT_TAGS.opaque;
}

function assertInside(parentPath: string, childPath: string): void {
  const childRelativePath = relative(resolve(parentPath), resolve(childPath));
  if (
    childRelativePath === '' ||
    childRelativePath === '..' ||
    childRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(childRelativePath)
  ) {
    throw new Error(`Refusing to use scratch path outside its parent: ${childPath}`);
  }
}

function canonicalZipEntryName(rawName: string): string {
  const normalized = rawName.replace(/\\/g, '/');
  const directory = normalized.endsWith('/');
  const pathWithoutTrailingSlash = directory ? normalized.slice(0, -1) : normalized;
  const segments = pathWithoutTrailingSlash.split('/');

  if (
    !pathWithoutTrailingSlash ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`ZIP contains an unsafe entry path: ${rawName}`);
  }

  return directory ? `${pathWithoutTrailingSlash}/` : pathWithoutTrailingSlash;
}

function canonicalTarEntryName(rawName: string): string | undefined {
  let normalized = rawName.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (normalized === '.' || normalized === '') {
    return undefined;
  }
  const pathWithoutTrailingSlash = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const segments = pathWithoutTrailingSlash.split('/');
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`tar.gz contains an unsafe tar entry path: ${rawName}`);
  }
  return pathWithoutTrailingSlash;
}

function assertSafeTarTarget(extractedPath: string, targetPath: string, rawName: string): void {
  try {
    assertInside(extractedPath, targetPath);
  } catch (error) {
    throw new Error(`tar.gz contains an unsafe tar entry target: ${rawName}`, { cause: error });
  }
}

async function validateTarArchiveEntries(
  sourceTarPath: string,
  extractedPath: string
): Promise<void> {
  let validationError: Error | undefined;
  await listTar({
    file: sourceTarPath,
    onReadEntry(entry) {
      if (validationError) {
        return;
      }
      try {
        const entryName = canonicalTarEntryName(entry.path);
        if (!entryName) {
          return;
        }
        assertSafeTarTarget(extractedPath, resolve(extractedPath, entryName), entry.path);
        if (!entry.linkpath) {
          return;
        }
        const linkName = entry.linkpath.replace(/\\/g, '/');
        const linkTarget =
          entry.type === 'SymbolicLink'
            ? resolve(extractedPath, dirname(entryName), linkName)
            : resolve(extractedPath, linkName);
        assertSafeTarTarget(extractedPath, linkTarget, `${entry.path} -> ${entry.linkpath}`);
      } catch (error) {
        validationError = error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  if (validationError) {
    throw validationError;
  }
}

async function validateExtractedTarEntries(extractedPath: string): Promise<void> {
  async function visit(directoryPath: string): Promise<void> {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const entryPath = join(directoryPath, entry.name);
      assertSafeTarTarget(extractedPath, entryPath, entryPath);
      const entryStats = await lstat(entryPath);
      if (entryStats.isSymbolicLink()) {
        const linkTarget = resolve(dirname(entryPath), await readlink(entryPath));
        assertSafeTarTarget(extractedPath, linkTarget, entryPath);
        try {
          assertSafeTarTarget(extractedPath, await realpath(entryPath), entryPath);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            throw error;
          }
        }
      } else if (entryStats.isDirectory()) {
        await visit(entryPath);
      }
    }
  }

  await visit(extractedPath);
}

async function extractZipEntries(
  inputPath: string,
  scratchPath: string,
  maxDecompressedBytes: number
): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const openFiles = new Set<number>();
  let extractionError: Error | undefined;
  let decompressedBytes = 0;

  const unzip = new Unzip((file: UnzipFile) => {
    if (extractionError) {
      file.terminate();
      return;
    }

    try {
      const name = canonicalZipEntryName(file.name);
      if (names.has(name)) {
        throw new Error(`ZIP contains a duplicate canonical entry path: ${name}`);
      }
      names.add(name);

      const directory = name.endsWith('/');
      const entryPath = directory
        ? undefined
        : join(scratchPath, `${entries.length.toString().padStart(8, '0')}.entry`);
      const entry: ZipEntry = {
        completed: false,
        directory,
        name,
        ...(entryPath ? { path: entryPath } : {}),
      };
      entries.push(entry);
      const outputFile = entryPath ? openSync(entryPath, 'w') : undefined;
      if (outputFile !== undefined) {
        openFiles.add(outputFile);
      }

      file.ondata = (error, data, final) => {
        if (error) {
          extractionError = error;
        } else if (data.byteLength > 0) {
          decompressedBytes += data.byteLength;
          if (decompressedBytes > maxDecompressedBytes) {
            extractionError = new Error(
              `ZIP decompressed byte budget exceeded (${maxDecompressedBytes} bytes)`
            );
            file.terminate();
          } else if (outputFile === undefined) {
            extractionError = new Error(`ZIP directory entry contains data: ${name}`);
          } else {
            writeSync(outputFile, data);
          }
        }

        if (final) {
          entry.completed = true;
          if (outputFile !== undefined && openFiles.delete(outputFile)) {
            closeSync(outputFile);
          }
        }
      };
      file.start();
    } catch (error) {
      extractionError = error instanceof Error ? error : new Error(String(error));
      file.terminate();
    }
  });
  unzip.register(UnzipInflate);

  try {
    for await (const chunk of createReadStream(inputPath)) {
      unzip.push(chunk, false);
      if (extractionError) {
        throw extractionError;
      }
    }
    unzip.push(new Uint8Array(), true);
    if (extractionError) {
      throw extractionError;
    }
    const incompleteEntry = entries.find((entry) => !entry.completed);
    if (incompleteEntry) {
      throw new Error(`ZIP entry did not finish decoding: ${incompleteEntry.name}`);
    }
    return entries;
  } finally {
    for (const openFile of openFiles) {
      closeSync(openFile);
    }
  }
}

function shouldStoreZipEntry(entryName: string): boolean {
  return ALREADY_COMPRESSED_ZIP_EXTENSIONS.has(extname(entryName).toLowerCase());
}

async function canonicalizeZip(
  inputPath: string,
  outputPath: string,
  scratchPath: string,
  maxDecompressedBytes: number
) {
  const entries = (await extractZipEntries(inputPath, scratchPath, maxDecompressedBytes)).sort(
    (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  );
  const outputFile = openSync(outputPath, 'w');
  let archiveError: Error | undefined;
  const archive = new Zip((error, data) => {
    if (error) {
      archiveError = error;
      return;
    }
    if (data.byteLength > 0) {
      writeSync(outputFile, data);
    }
  });

  try {
    for (const entry of entries) {
      const file: ZipInputFile =
        entry.directory || shouldStoreZipEntry(entry.name)
          ? new ZipPassThrough(entry.name)
          : new ZipDeflate(entry.name, { level: 9 });
      file.mtime = FIXED_ZIP_MTIME;
      file.os = 3;
      file.attrs = (entry.directory ? 0o755 : 0o644) << 16;
      archive.add(file);

      if (entry.path) {
        for await (const chunk of createReadStream(entry.path)) {
          (file as ZipPassThrough | ZipDeflate).push(chunk, false);
          if (archiveError) {
            throw archiveError;
          }
        }
      }
      (file as ZipPassThrough | ZipDeflate).push(new Uint8Array(), true);
      if (archiveError) {
        throw archiveError;
      }
    }
    archive.end();
    if (archiveError) {
      throw archiveError;
    }
  } finally {
    closeSync(outputFile);
    if (archiveError) {
      archive.terminate();
    }
  }
}

async function canonicalizeTarGzip(
  inputPath: string,
  outputPath: string,
  scratchPath: string,
  maxDecompressedBytes: number
): Promise<void> {
  const sourceTarPath = join(scratchPath, 'source.tar');
  const canonicalTarPath = join(scratchPath, 'canonical.tar');
  const extractedPath = join(scratchPath, 'entries');
  const deterministicEnvironment = canonicalizerChildEnv();
  await mkdir(extractedPath);

  const sourceTarFile = openSync(sourceTarPath, 'w');
  let decompressedBytes = 0;
  try {
    const decompressed = createReadStream(inputPath).pipe(createGunzip());
    for await (const chunk of decompressed) {
      decompressedBytes += chunk.byteLength;
      if (decompressedBytes > maxDecompressedBytes) {
        decompressed.destroy();
        throw new Error(`tar.gz decompressed byte budget exceeded (${maxDecompressedBytes} bytes)`);
      }
      writeSync(sourceTarFile, chunk);
    }
  } finally {
    closeSync(sourceTarFile);
  }
  await validateTarArchiveEntries(sourceTarPath, extractedPath);
  await runCommand(
    'tar',
    [
      '--force-local',
      '--extract',
      '--file',
      sourceTarPath,
      '--directory',
      extractedPath,
      '--no-same-owner',
      '--no-same-permissions',
      '--no-overwrite-dir',
    ],
    { env: deterministicEnvironment }
  );
  await validateExtractedTarEntries(extractedPath);
  await runCommand(
    'tar',
    [
      '--force-local',
      '--create',
      '--file',
      canonicalTarPath,
      '--format=gnu',
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--mode=a-x,a=r,u+w,a+X',
      '--directory',
      extractedPath,
      '.',
    ],
    { env: deterministicEnvironment }
  );
  await runCommand('gzip', ['-n', '--rsyncable', '--stdout', '--', canonicalTarPath], {
    env: deterministicEnvironment,
    stdoutPath: outputPath,
  });
}

export async function canonicalizeArtifact(input: {
  inputPath: string;
  maxDecompressedBytes?: number;
  outputPath: string;
}): Promise<CanonicalArtifact> {
  const inputPath = resolve(input.inputPath);
  const outputPath = resolve(input.outputPath);
  if (inputPath === outputPath) {
    throw new Error('Canonical output path must differ from the input path.');
  }
  const inputStats = await stat(inputPath);
  if (!inputStats.isFile()) {
    throw new Error(`Canonical input is not a regular file: ${inputPath}`);
  }
  const maxDecompressedBytes = input.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
  if (!Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes <= 0) {
    throw new Error('maxDecompressedBytes must be a positive safe integer');
  }

  const outputDirectory = dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const scratchPath = await mkdtemp(join(outputDirectory, '.canonicalize-'));
  assertInside(outputDirectory, scratchPath);
  const scratchOutputPath = join(scratchPath, 'artifact.canonical');
  const formatTag = formatTagForPath(inputPath);

  try {
    if (formatTag === CANONICAL_FORMAT_TAGS.tarGzip) {
      await canonicalizeTarGzip(inputPath, scratchOutputPath, scratchPath, maxDecompressedBytes);
    } else if (formatTag === CANONICAL_FORMAT_TAGS.zip) {
      await canonicalizeZip(inputPath, scratchOutputPath, scratchPath, maxDecompressedBytes);
    } else {
      await copyFile(inputPath, scratchOutputPath);
    }
    await copyFile(scratchOutputPath, outputPath);
    const outputStats = await stat(outputPath);
    return {
      byteLength: outputStats.size,
      formatTag,
      path: outputPath,
    };
  } finally {
    assertInside(outputDirectory, scratchPath);
    await rm(scratchPath, { force: true, recursive: true });
  }
}
