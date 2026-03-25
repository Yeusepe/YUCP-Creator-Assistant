import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import * as tar from 'tar';

export type ExtractedForensicsAsset = {
  assetPath: string;
  assetType: 'png' | 'fbx';
  filePath: string;
};

export type ForensicsArchiveExtraction = {
  assets: ExtractedForensicsAsset[];
  declaredPackageIds: string[];
};

const METADATA_FILE_NAMES = new Set(['yucp_packageinfo.json', 'packagemanifest.json']);
const MAX_CANDIDATE_ASSETS = 512;

function normalizeRelativeArchivePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function isSafeRelativeArchivePath(input: string): boolean {
  const normalized = normalizeRelativeArchivePath(input);
  if (!normalized) return false;
  if (path.posix.isAbsolute(normalized)) return false;
  return !normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

function getAssetTypeFromPath(assetPath: string): 'png' | 'fbx' | null {
  const ext = path.posix.extname(assetPath).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.fbx') return 'fbx';
  return null;
}

function isMetadataPath(assetPath: string): boolean {
  return METADATA_FILE_NAMES.has(path.posix.basename(assetPath).toLowerCase());
}

async function maybeReadPackageIdFromJsonFile(filePath: string): Promise<string | null> {
  try {
    const text = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(text) as { packageId?: unknown; package_id?: unknown };
    if (typeof parsed.packageId === 'string' && parsed.packageId.trim()) {
      return parsed.packageId.trim();
    }
    if (typeof parsed.package_id === 'string' && parsed.package_id.trim()) {
      return parsed.package_id.trim();
    }
  } catch {
    return null;
  }
  return null;
}

async function recordCandidateAsset(
  candidatesDir: string,
  assetPath: string,
  sourceFilePath: string,
  sequence: number
): Promise<ExtractedForensicsAsset | null> {
  const assetType = getAssetTypeFromPath(assetPath);
  if (!assetType) {
    return null;
  }
  const ext = path.posix.extname(assetPath).toLowerCase();
  const outputPath = path.join(candidatesDir, `${sequence}${ext}`);
  await copyFile(sourceFilePath, outputPath);
  return {
    assetPath,
    assetType,
    filePath: outputPath,
  };
}

async function extractZipCandidates(
  archivePath: string,
  workspaceDir: string
): Promise<ForensicsArchiveExtraction> {
  const candidatesDir = path.join(workspaceDir, 'candidates');
  await mkdir(candidatesDir, { recursive: true });
  const extractedDir = path.join(workspaceDir, 'zip');
  await mkdir(extractedDir, { recursive: true });

  const directory = unzipSync(new Uint8Array(await readFile(archivePath)));
  const assets: ExtractedForensicsAsset[] = [];
  const declaredPackageIds = new Set<string>();

  for (const [rawEntryPath, entryBytes] of Object.entries(directory)) {
    if (!entryBytes || entryBytes.byteLength === 0) {
      continue;
    }
    const entryPath = normalizeRelativeArchivePath(rawEntryPath);
    if (!isSafeRelativeArchivePath(entryPath)) {
      continue;
    }

    const destinationPath = path.join(extractedDir, entryPath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await Bun.write(destinationPath, entryBytes);

    if (isMetadataPath(entryPath)) {
      const packageId = await maybeReadPackageIdFromJsonFile(destinationPath);
      if (packageId) {
        declaredPackageIds.add(packageId);
      }
      continue;
    }

    const candidate = await recordCandidateAsset(
      candidatesDir,
      entryPath,
      destinationPath,
      assets.length
    );
    if (candidate) {
      assets.push(candidate);
      if (assets.length > MAX_CANDIDATE_ASSETS) {
        throw new Error('Archive contains too many coupling candidate assets');
      }
    }
  }

  return {
    assets,
    declaredPackageIds: [...declaredPackageIds].sort((left, right) => left.localeCompare(right)),
  };
}

async function extractUnityPackageCandidates(
  archivePath: string,
  workspaceDir: string
): Promise<ForensicsArchiveExtraction> {
  const extractedDir = path.join(workspaceDir, 'unitypackage');
  const candidatesDir = path.join(workspaceDir, 'candidates');
  await mkdir(extractedDir, { recursive: true });
  await mkdir(candidatesDir, { recursive: true });

  await tar.x({
    file: archivePath,
    cwd: extractedDir,
    gzip: true,
    strict: true,
    preservePaths: false,
    filter: (entryPath) => {
      if (!isSafeRelativeArchivePath(entryPath)) {
        return false;
      }
      return true;
    },
  });

  const assets: ExtractedForensicsAsset[] = [];
  const declaredPackageIds = new Set<string>();
  const entryDirs = await readdir(extractedDir);

  for (const entryDir of entryDirs) {
    const fullDir = path.join(extractedDir, entryDir);
    const entryStats = await stat(fullDir);
    if (!entryStats.isDirectory()) {
      continue;
    }

    const pathnameFile = path.join(fullDir, 'pathname');
    const assetFile = path.join(fullDir, 'asset');
    const pathnameStats = await stat(pathnameFile).catch(() => null);
    const assetStats = await stat(assetFile).catch(() => null);
    if (!pathnameStats?.isFile() || !assetStats?.isFile()) {
      continue;
    }

    const assetPath = normalizeRelativeArchivePath((await readFile(pathnameFile, 'utf8')).trim());
    if (!isSafeRelativeArchivePath(assetPath)) {
      continue;
    }

    if (isMetadataPath(assetPath)) {
      const packageId = await maybeReadPackageIdFromJsonFile(assetFile);
      if (packageId) {
        declaredPackageIds.add(packageId);
      }
      continue;
    }

    const candidate = await recordCandidateAsset(
      candidatesDir,
      assetPath,
      assetFile,
      assets.length
    );
    if (candidate) {
      assets.push(candidate);
      if (assets.length > MAX_CANDIDATE_ASSETS) {
        throw new Error('Archive contains too many coupling candidate assets');
      }
    }
  }

  return {
    assets,
    declaredPackageIds: [...declaredPackageIds].sort((left, right) => left.localeCompare(right)),
  };
}

export async function extractCouplingForensicsArchive(
  archivePath: string,
  originalFilename: string,
  workspaceDir: string
): Promise<ForensicsArchiveExtraction> {
  const normalizedName = originalFilename.trim().toLowerCase();
  if (normalizedName.endsWith('.unitypackage')) {
    return await extractUnityPackageCandidates(archivePath, workspaceDir);
  }
  if (normalizedName.endsWith('.zip')) {
    return await extractZipCandidates(archivePath, workspaceDir);
  }
  throw new Error('Unsupported upload type. Upload a .unitypackage or .zip file.');
}
