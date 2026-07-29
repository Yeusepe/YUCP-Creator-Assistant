import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type { PublicImporterReleaseLedger } from './publicImporterRelease';
import {
  collectPublicImporterReleasePins,
  formatPublicImporterReleaseLedger,
  type GitHubRelease,
} from './publicImporterReleaseSync';

const importerPackageId = 'com.yucp.importer';

function archiveFor(version: string, packageName = importerPackageId): Uint8Array {
  return zipSync({
    'package.json': strToU8(JSON.stringify({ name: packageName, version })),
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function releaseFor(input: {
  version: string;
  archive?: Uint8Array;
  assetDigest?: string;
  manifest?: { name: string; version: string };
  assets?: GitHubRelease['assets'];
}): { release: GitHubRelease; downloads: Map<string, Uint8Array> } {
  const archive = input.archive ?? archiveFor(input.version);
  const manifest = input.manifest ?? { name: importerPackageId, version: input.version };
  const zipUrl = `https://downloads.example/${input.version}.zip`;
  const manifestUrl = `https://downloads.example/${input.version}.package.json`;
  return {
    release: {
      assets: input.assets ?? [
        {
          browser_download_url: zipUrl,
          digest: input.assetDigest ?? `sha256:${sha256(archive)}`,
          name: `${importerPackageId}-${input.version}.zip`,
        },
        { browser_download_url: manifestUrl, name: 'package.json' },
      ],
      draft: false,
      prerelease: false,
      published_at: '2026-07-28T00:00:00Z',
      tag_name: `${importerPackageId}-${input.version}`,
    },
    downloads: new Map([
      [zipUrl, archive],
      [manifestUrl, strToU8(JSON.stringify(manifest))],
    ]),
  };
}

const emptyLedger: PublicImporterReleaseLedger = { releases: {}, schemaVersion: 1 };

async function collect(
  releases: GitHubRelease[],
  downloads: Map<string, Uint8Array>,
  ledger = emptyLedger
) {
  return collectPublicImporterReleasePins({
    downloadAsset: async (asset) => {
      const bytes = downloads.get(asset.browser_download_url);
      if (!bytes) throw new Error(`Unexpected download: ${asset.browser_download_url}`);
      return bytes;
    },
    ledger,
    releases,
  });
}

test('pins valid releases in semantic-version order with deterministic ledger formatting', async () => {
  const newer = releaseFor({ version: '0.1.62' });
  const older = releaseFor({ version: '0.1.9' });
  const result = await collect(
    [newer.release, older.release],
    new Map([...newer.downloads, ...older.downloads])
  );

  expect(result.pinnedVersions).toEqual(['0.1.9', '0.1.62']);
  expect(Object.keys(result.ledger.releases)).toEqual(['0.1.9', '0.1.62']);
  expect(formatPublicImporterReleaseLedger(result.ledger)).toBe(
    `${JSON.stringify(result.ledger, null, 2)}\n`
  );
});

test('does not rewrite an already pinned matching archive', async () => {
  const candidate = releaseFor({ version: '0.1.62' });
  const result = await collect([candidate.release], candidate.downloads, {
    releases: {
      '0.1.62': { sha256: sha256(candidate.downloads.values().next().value as Uint8Array) },
    },
    schemaVersion: 1,
  });

  expect(result.pinnedVersions).toEqual([]);
  expect(result.changed).toBeFalse();
});

test('rejects candidate releases that are missing required assets', async () => {
  const candidate = releaseFor({
    version: '0.1.62',
    assets: [{ browser_download_url: 'https://downloads.example/archive', name: 'other.zip' }],
  });

  await expect(collect([candidate.release], candidate.downloads)).rejects.toThrow(
    'must have exactly one matching ZIP asset and one package.json asset'
  );
});

test('rejects duplicate matching release assets', async () => {
  const candidate = releaseFor({ version: '0.1.62' });
  const duplicateArchive = candidate.release.assets[0] as GitHubRelease['assets'][number];
  const release = { ...candidate.release, assets: [...candidate.release.assets, duplicateArchive] };

  await expect(collect([release], candidate.downloads)).rejects.toThrow(
    'must have exactly one matching ZIP asset and one package.json asset'
  );
});

test('rejects package identity and version mismatches in either manifest', async () => {
  const releaseManifestMismatch = releaseFor({
    manifest: { name: importerPackageId, version: '0.1.61' },
    version: '0.1.62',
  });
  await expect(
    collect([releaseManifestMismatch.release], releaseManifestMismatch.downloads)
  ).rejects.toThrow('release package.json version must be 0.1.62');

  const archive = archiveFor('0.1.62', 'com.yucp.other');
  const archiveManifestMismatch = releaseFor({ archive, version: '0.1.62' });
  await expect(
    collect([archiveManifestMismatch.release], archiveManifestMismatch.downloads)
  ).rejects.toThrow('archive package.json name must be com.yucp.importer');
});

test('rejects malformed and mismatching GitHub ZIP digests', async () => {
  const malformed = releaseFor({ assetDigest: 'not-a-digest', version: '0.1.62' });
  await expect(collect([malformed.release], malformed.downloads)).rejects.toThrow(
    'must have a sha256 digest'
  );

  const mismatch = releaseFor({ assetDigest: `sha256:${'0'.repeat(64)}`, version: '0.1.62' });
  await expect(collect([mismatch.release], mismatch.downloads)).rejects.toThrow(
    'ZIP digest does not match its downloaded bytes'
  );
});

test('rejects historical hash replacement and ignores ineligible releases', async () => {
  const candidate = releaseFor({ version: '0.1.62' });
  await expect(
    collect([candidate.release], candidate.downloads, {
      releases: { '0.1.62': { sha256: 'f'.repeat(64) } },
      schemaVersion: 1,
    })
  ).rejects.toThrow('would change the already pinned archive hash');

  const ignored = { ...candidate.release, prerelease: true };
  const result = await collect([ignored], candidate.downloads);
  expect(result.changed).toBeFalse();
  expect(result.pinnedVersions).toEqual([]);
});
