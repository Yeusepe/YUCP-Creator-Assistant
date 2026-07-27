import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildLocalImporterRepository, type LocalImporterRepository } from './localVpmRepository';

const IMPORTER_PACKAGE_ID = 'com.yucp.importer';
const RELEASE_LEDGER_PATH = join(import.meta.dir, 'public-importer-releases.json');
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type PublicImporterReleaseLedger = {
  releases: Record<string, { sha256: string }>;
  schemaVersion: 1;
};

function validateReleaseLedger(value: unknown): PublicImporterReleaseLedger {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new Error('The public importer release ledger is invalid');
  }
  const releases = (value as { releases?: unknown }).releases;
  if (!releases || typeof releases !== 'object' || Array.isArray(releases)) {
    throw new Error('The public importer release ledger is invalid');
  }
  for (const [version, release] of Object.entries(releases)) {
    if (
      !STABLE_VERSION_PATTERN.test(version) ||
      !release ||
      typeof release !== 'object' ||
      Array.isArray(release) ||
      !SHA256_PATTERN.test((release as { sha256?: unknown }).sha256 as string)
    ) {
      throw new Error('The public importer release ledger is invalid');
    }
  }
  return value as PublicImporterReleaseLedger;
}

export async function readPublicImporterReleaseLedger(
  path = RELEASE_LEDGER_PATH
): Promise<PublicImporterReleaseLedger> {
  return validateReleaseLedger(JSON.parse(await readFile(path, 'utf8')));
}

export function assertPinnedImporterRelease(
  repository: LocalImporterRepository,
  ledger: PublicImporterReleaseLedger
): void {
  const versions = repository.index.packages[IMPORTER_PACKAGE_ID].versions;
  const entries = Object.entries(versions);
  if (entries.length !== 1) {
    throw new Error('The public importer build must contain exactly one release');
  }
  const [version, manifest] = entries[0] as [string, (typeof versions)[string]];
  const archiveSha256 = createHash('sha256').update(repository.archive).digest('hex');
  if (manifest.zipSHA256 !== archiveSha256) {
    throw new Error('The public importer index does not match its package bytes');
  }
  const pinned = ledger.releases[version];
  if (!pinned) {
    throw new Error(`Public importer version ${version} is not pinned for release`);
  }
  if (pinned.sha256 !== archiveSha256) {
    throw new Error(
      `The public importer changed published version ${version}. ` +
        'Changed importer bytes must publish a new semantic version'
    );
  }
}

export async function buildPinnedLocalImporterRepository(input: {
  baseUrl: string;
  importerPath: string;
  releaseLedgerPath?: string;
}): Promise<LocalImporterRepository> {
  const repository = await buildLocalImporterRepository(input);
  const ledger = await readPublicImporterReleaseLedger(input.releaseLedgerPath);
  assertPinnedImporterRelease(repository, ledger);
  return repository;
}
