import { YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION } from '@yucp/shared';

const IMPORTER_PACKAGE_ID = 'com.yucp.importer';
const MAX_PUBLIC_INDEX_BYTES = 2 * 1024 * 1024;
const PUBLIC_INDEX_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export type VpmImporterManifest = Record<string, unknown> & {
  displayName: string;
  name: typeof IMPORTER_PACKAGE_ID;
  url: string;
  version: string;
  zipSHA256: string;
};

export type PublicImporterReleaseLedger = {
  releases: Record<string, { sha256: string }>;
  schemaVersion: 1;
};

export function assertPublicImporterIndexMatchesReleaseLedger(
  value: unknown,
  ledger: PublicImporterReleaseLedger
): void {
  if (ledger.schemaVersion !== 1 || !isRecord(ledger.releases)) {
    throw new Error('The public importer release ledger is invalid');
  }
  if (!isRecord(value) || !isRecord(value.packages)) {
    throw new Error('The public VPM index does not contain a packages object');
  }
  const packageEntry = value.packages[IMPORTER_PACKAGE_ID];
  if (!isRecord(packageEntry) || !isRecord(packageEntry.versions)) {
    throw new Error('The public VPM index does not contain the importer package');
  }
  for (const [version, manifest] of Object.entries(packageEntry.versions)) {
    if (
      !parseStableVersion(version) ||
      !isRecord(manifest) ||
      manifest.name !== IMPORTER_PACKAGE_ID ||
      manifest.version !== version ||
      typeof manifest.zipSHA256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(manifest.zipSHA256)
    ) {
      throw new Error(`The public importer manifest for version ${version} is invalid`);
    }
    const pin = ledger.releases[version];
    if (!pin || !/^[0-9a-f]{64}$/.test(pin.sha256)) {
      throw new Error(`Public importer version ${version} is not pinned for release`);
    }
    if (pin.sha256 !== manifest.zipSHA256) {
      throw new Error(
        `The public importer changed published version ${version}. ` +
          'Changed importer bytes must publish a new semantic version'
      );
    }
  }
}

export function assertPublicImporterVersionsImmutable(
  published: VpmImporterManifest,
  candidate: VpmImporterManifest
): void {
  if (published.version === candidate.version && published.zipSHA256 !== candidate.zipSHA256) {
    throw new Error(
      `The public importer changed published version ${candidate.version}. ` +
        'Changed importer bytes must publish a new semantic version'
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStableVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    return null;
  }
  const parts = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    return null;
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function requirePublicPackageUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('The public importer manifest is missing its package URL');
  }
  const url = new URL(value);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname))
  ) {
    throw new Error('The public importer package URL must use HTTPS or loopback HTTP');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('The public importer package URL must not contain credentials or a fragment');
  }
  return url.toString();
}

export function selectPublicImporterManifest(value: unknown): VpmImporterManifest {
  if (!isRecord(value) || !isRecord(value.packages)) {
    throw new Error('The public VPM index does not contain a packages object');
  }
  const packageEntry = value.packages[IMPORTER_PACKAGE_ID];
  if (!isRecord(packageEntry) || !isRecord(packageEntry.versions)) {
    throw new Error('The public VPM index does not contain the importer package');
  }

  const minimum = parseStableVersion(YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION);
  if (!minimum) {
    throw new Error('The configured importer minimum version is invalid');
  }

  const candidates = Object.entries(packageEntry.versions)
    .flatMap(([version, manifest]) => {
      const parsed = parseStableVersion(version);
      return parsed && compareVersions(parsed, minimum) >= 0 && isRecord(manifest)
        ? [{ manifest, parsed, version }]
        : [];
    })
    .sort((left, right) => compareVersions(right.parsed, left.parsed));
  const selected = candidates[0];
  if (!selected) {
    throw new Error(
      `The public VPM index requires ${IMPORTER_PACKAGE_ID} ${YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION} or newer`
    );
  }

  const displayName = selected.manifest.displayName;
  const zipSHA256 = selected.manifest.zipSHA256;
  if (
    selected.manifest.name !== IMPORTER_PACKAGE_ID ||
    selected.manifest.version !== selected.version ||
    typeof displayName !== 'string' ||
    !displayName.trim() ||
    typeof zipSHA256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(zipSHA256)
  ) {
    throw new Error('The public importer manifest is invalid');
  }

  return {
    ...selected.manifest,
    name: IMPORTER_PACKAGE_ID,
    displayName: displayName.trim(),
    version: selected.version,
    url: requirePublicPackageUrl(selected.manifest.url),
    zipSHA256: zipSHA256.toLowerCase(),
  };
}

export async function fetchPublicImporterManifest(input: {
  fetchImpl: typeof fetch;
  publicVpmIndexUrl: string;
}): Promise<VpmImporterManifest> {
  // VPM repository format: https://vcc.docs.vrchat.com/vpm/repos/
  const response = await input.fetchImpl(input.publicVpmIndexUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(PUBLIC_INDEX_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`The public VPM index returned HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PUBLIC_INDEX_BYTES) {
    throw new Error('The public VPM index exceeded its response limit');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('The public VPM index returned invalid JSON');
  }
  return selectPublicImporterManifest(parsed);
}
