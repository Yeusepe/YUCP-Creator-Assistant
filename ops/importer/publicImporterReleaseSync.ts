import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import {
  type PublicImporterReleaseLedger,
  readPublicImporterReleaseLedger,
} from './publicImporterRelease';

const IMPORTER_PACKAGE_ID = 'com.yucp.importer';
const RELEASE_LEDGER_PATH = join(import.meta.dir, 'public-importer-releases.json');
const COMPONENTS_REPOSITORY = 'Yeusepe/YUCP-Components';
const SEMVER_IDENTIFIER = '(?:0|[1-9]\\d*)';
const STABLE_VERSION_PATTERN = new RegExp(
  `^${SEMVER_IDENTIFIER}\\.${SEMVER_IDENTIFIER}\\.${SEMVER_IDENTIFIER}$`
);
const RELEASE_TAG_PATTERN = new RegExp(
  `^${IMPORTER_PACKAGE_ID.replaceAll('.', '\\.')}-(${STABLE_VERSION_PATTERN.source.slice(1, -1)})$`
);
const GITHUB_SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;

export type GitHubReleaseAsset = {
  browser_download_url: string;
  digest?: string | null;
  name: string;
};

export type GitHubRelease = {
  assets: GitHubReleaseAsset[];
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  tag_name: string;
};

type PackageManifest = { name?: unknown; version?: unknown };

export type PublicImporterReleaseSyncResult = {
  changed: boolean;
  ledger: PublicImporterReleaseLedger;
  pinnedVersions: string[];
};

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = (leftParts[index] as number) - (rightParts[index] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

function cloneAndSortLedger(ledger: PublicImporterReleaseLedger): PublicImporterReleaseLedger {
  return {
    releases: Object.fromEntries(
      Object.entries(ledger.releases)
        .sort(([left], [right]) => compareVersions(left, right))
        .map(([version, release]) => [version, { sha256: release.sha256 }])
    ),
    schemaVersion: 1,
  };
}

function parsePackageManifest(bytes: Uint8Array, source: string): PackageManifest {
  try {
    const manifest = JSON.parse(strFromU8(bytes));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('not an object');
    }
    return manifest as PackageManifest;
  } catch {
    throw new Error(`${source} must contain valid JSON`);
  }
}

function assertPackageManifest(manifest: PackageManifest, version: string, source: string): void {
  if (manifest.name !== IMPORTER_PACKAGE_ID) {
    throw new Error(`${source} name must be ${IMPORTER_PACKAGE_ID}`);
  }
  if (manifest.version !== version) {
    throw new Error(`${source} version must be ${version}`);
  }
}

function eligibleVersion(release: GitHubRelease): string | undefined {
  if (release.draft || release.prerelease || !release.published_at) return undefined;
  const match = RELEASE_TAG_PATTERN.exec(release.tag_name);
  return match?.[1];
}

function selectRequiredAssets(
  release: GitHubRelease,
  version: string
): {
  archive: GitHubReleaseAsset;
  manifest: GitHubReleaseAsset;
} {
  const archiveName = `${IMPORTER_PACKAGE_ID}-${version}.zip`;
  const archives = release.assets.filter((asset) => asset.name === archiveName);
  const manifests = release.assets.filter((asset) => asset.name === 'package.json');
  if (archives.length !== 1 || manifests.length !== 1) {
    throw new Error(
      `Eligible importer release ${release.tag_name} must have exactly one matching ZIP asset and one package.json asset`
    );
  }
  return {
    archive: archives[0] as GitHubReleaseAsset,
    manifest: manifests[0] as GitHubReleaseAsset,
  };
}

function readArchiveManifest(archive: Uint8Array): PackageManifest {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive);
  } catch {
    throw new Error('Importer release ZIP must be a valid archive');
  }
  const packageJson = files['package.json'];
  if (!packageJson) throw new Error('Importer release ZIP must contain package.json');
  return parsePackageManifest(packageJson, 'archive package.json');
}

function digestFor(asset: GitHubReleaseAsset): string {
  const match = GITHUB_SHA256_DIGEST_PATTERN.exec(asset.digest ?? '');
  if (!match) {
    throw new Error(`Importer release ZIP asset ${asset.name} must have a sha256 digest`);
  }
  return match[1] as string;
}

export function formatPublicImporterReleaseLedger(ledger: PublicImporterReleaseLedger): string {
  return `${JSON.stringify(cloneAndSortLedger(ledger), null, 2)}\n`;
}

export async function collectPublicImporterReleasePins(input: {
  downloadAsset: (asset: GitHubReleaseAsset) => Promise<Uint8Array>;
  ledger: PublicImporterReleaseLedger;
  releases: GitHubRelease[];
}): Promise<PublicImporterReleaseSyncResult> {
  const nextLedger = cloneAndSortLedger(input.ledger);
  const pinnedVersions: string[] = [];
  const candidates = input.releases
    .map((release) => ({ release, version: eligibleVersion(release) }))
    .filter((candidate): candidate is { release: GitHubRelease; version: string } =>
      Boolean(candidate.version)
    )
    .sort((left, right) => compareVersions(left.version, right.version));

  for (const { release, version } of candidates) {
    const { archive, manifest } = selectRequiredAssets(release, version);
    const expectedSha256 = digestFor(archive);
    const [archiveBytes, manifestBytes] = await Promise.all([
      input.downloadAsset(archive),
      input.downloadAsset(manifest),
    ]);
    const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Importer release ${version} ZIP digest does not match its downloaded bytes`);
    }
    assertPackageManifest(
      parsePackageManifest(manifestBytes, 'release package.json'),
      version,
      'release package.json'
    );
    assertPackageManifest(readArchiveManifest(archiveBytes), version, 'archive package.json');

    const pinned = nextLedger.releases[version];
    if (pinned && pinned.sha256 !== actualSha256) {
      throw new Error(`Importer release ${version} would change the already pinned archive hash`);
    }
    if (!pinned) {
      nextLedger.releases[version] = { sha256: actualSha256 };
      pinnedVersions.push(version);
    }
  }

  const ledger = cloneAndSortLedger(nextLedger);
  return { changed: pinnedVersions.length > 0, ledger, pinnedVersions };
}

// GitHub Releases API: https://docs.github.com/en/rest/releases/releases#list-releases
async function listGitHubReleases(fetcher: typeof fetch, token?: string): Promise<GitHubRelease[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const releases: GitHubRelease[] = [];
  let nextUrl: string | undefined =
    `https://api.github.com/repos/${COMPONENTS_REPOSITORY}/releases?per_page=100`;
  while (nextUrl) {
    const response: Response = await fetcher(nextUrl, { headers });
    if (!response.ok) {
      throw new Error(`GitHub releases request failed with status ${response.status}`);
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error('GitHub releases response must be an array');
    releases.push(...(body as GitHubRelease[]));
    nextUrl = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  return releases;
}

async function downloadGitHubAsset(
  fetcher: typeof fetch,
  asset: GitHubReleaseAsset,
  token?: string
): Promise<Uint8Array> {
  const headers: Record<string, string> = { Accept: 'application/octet-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetcher(asset.browser_download_url, { headers });
  if (!response.ok) throw new Error(`Download failed for importer release asset ${asset.name}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function synchronizePublicImporterReleaseLedger(
  input: { dryRun?: boolean; fetcher?: typeof fetch; ledgerPath?: string; token?: string } = {}
): Promise<PublicImporterReleaseSyncResult> {
  const ledgerPath = input.ledgerPath ?? RELEASE_LEDGER_PATH;
  const fetcher = input.fetcher ?? fetch;
  const token = input.token ?? process.env.GITHUB_TOKEN;
  const [ledger, releases] = await Promise.all([
    readPublicImporterReleaseLedger(ledgerPath),
    listGitHubReleases(fetcher, token),
  ]);
  const result = await collectPublicImporterReleasePins({
    downloadAsset: (asset) => downloadGitHubAsset(fetcher, asset, token),
    ledger,
    releases,
  });
  if (result.changed && !input.dryRun) {
    await writeFile(ledgerPath, formatPublicImporterReleaseLedger(result.ledger));
  }
  return result;
}

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run');
  const result = await synchronizePublicImporterReleaseLedger({ dryRun });
  const output = process.env.GITHUB_OUTPUT;
  if (output)
    await writeFile(output, `pinned_versions=${result.pinnedVersions.join(',')}\n`, { flag: 'a' });
  if (result.changed) {
    console.log(
      `${dryRun ? 'Verified' : 'Pinned'} importer releases: ${result.pinnedVersions.join(', ')}`
    );
  } else {
    console.log('No new eligible importer releases');
  }
}
