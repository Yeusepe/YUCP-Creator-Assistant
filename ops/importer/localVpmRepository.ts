import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Zippable } from 'fflate';
import { zipSync } from 'fflate';

const IMPORTER_PACKAGE_ID = 'com.yucp.importer';
const PUBLIC_ARCHIVE_EXCLUDED_ROOTS = new Set(['Tests', 'Tests.meta']);
const ZIP_TIMESTAMP_EPOCH = Date.UTC(2000, 0, 1, 12, 0, 0);
const ZIP_TIMESTAMP_SLOT_COUNT = 36_525 * 21_600;

type ImporterManifest = Record<string, unknown> & {
  displayName: string;
  name: typeof IMPORTER_PACKAGE_ID;
  version: string;
};

export type LocalImporterRepository = {
  archive: Uint8Array;
  archivePath: string;
  index: {
    author: string;
    id: string;
    name: string;
    packages: Record<
      typeof IMPORTER_PACKAGE_ID,
      {
        versions: Record<
          string,
          ImporterManifest & {
            url: string;
            zipSHA256: string;
          }
        >;
      }
    >;
    url: string;
  };
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function packageVersionTimestamp(packageVersion: string): Date {
  const digest = createHash('sha256')
    .update('yucp-vpm-package-timestamp-v1\0')
    .update(packageVersion)
    .digest();
  const slot = digest.readUInt32BE(0) % ZIP_TIMESTAMP_SLOT_COUNT;
  const reference = new Date(ZIP_TIMESTAMP_EPOCH + slot * 2_000);
  return new Date(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate(),
    reference.getUTCHours(),
    reference.getUTCMinutes(),
    reference.getUTCSeconds()
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('The local VPM repository URL must use loopback HTTP');
  }
  return url.toString().replace(/\/+$/, '');
}

function validateManifest(value: unknown): ImporterManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The importer package manifest must be a JSON object');
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.name !== IMPORTER_PACKAGE_ID) {
    throw new Error(`The importer package manifest must identify ${IMPORTER_PACKAGE_ID}`);
  }
  if (typeof manifest.displayName !== 'string' || !manifest.displayName.trim()) {
    throw new Error('The importer package manifest must have a display name');
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('The importer package manifest must have a stable semantic version');
  }
  return {
    ...manifest,
    displayName: manifest.displayName.trim(),
    name: IMPORTER_PACKAGE_ID,
    version: manifest.version,
  };
}

export async function buildVpmPackageArchive(
  packagePath: string,
  packageVersion: string
): Promise<Uint8Array> {
  const entries: Zippable = {};
  const timestamp = packageVersionTimestamp(packageVersion);

  async function addDirectory(directoryPath: string): Promise<void> {
    const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directoryEntries) {
      const absolutePath = join(directoryPath, entry.name);
      const archivePath = relative(packagePath, absolutePath).split(sep).join('/');
      const archiveRoot = archivePath.split('/', 1)[0];
      if (archiveRoot && PUBLIC_ARCHIVE_EXCLUDED_ROOTS.has(archiveRoot)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`The importer package contains a symbolic link: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        await addDirectory(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`The importer package contains an unsupported entry: ${absolutePath}`);
      }
      entries[archivePath] = [
        new Uint8Array(await readFile(absolutePath)),
        { level: 9, mtime: timestamp },
      ];
    }
  }

  await addDirectory(packagePath);
  return zipSync(entries, { level: 9 });
}

export async function resolveLocalImporterPackagePath(
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const configured = env.YUCP_IMPORTER_PACKAGE_DIR?.trim();
  const candidates = [
    configured,
    process.platform === 'win32'
      ? 'E:\\Unity\\Components\\YUCP-Components\\Packages\\com.yucp.importer'
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (isAbsolute(candidate) && (await pathExists(join(candidate, 'package.json')))) {
      return candidate;
    }
  }
  throw new Error(
    'Set YUCP_IMPORTER_PACKAGE_DIR to the absolute com.yucp.importer package directory'
  );
}

export async function buildLocalImporterRepository(input: {
  baseUrl: string;
  importerPath: string;
}): Promise<LocalImporterRepository> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const manifest = validateManifest(
    JSON.parse(await readFile(join(input.importerPath, 'package.json'), 'utf8'))
  );
  const archive = await buildVpmPackageArchive(input.importerPath, manifest.version);
  const archivePath = `/packages/${IMPORTER_PACKAGE_ID}-${manifest.version}.zip`;
  const indexUrl = `${baseUrl}/index.json`;
  const packageManifest = {
    ...manifest,
    url: `${baseUrl}${archivePath}`,
    zipSHA256: sha256(archive),
  };

  return {
    archive,
    archivePath,
    index: {
      name: 'YUCP Local Importer',
      author: 'YUCP',
      id: 'club.yucp.local-importer',
      url: indexUrl,
      packages: {
        [IMPORTER_PACKAGE_ID]: {
          versions: {
            [manifest.version]: packageManifest,
          },
        },
      },
    },
  };
}
