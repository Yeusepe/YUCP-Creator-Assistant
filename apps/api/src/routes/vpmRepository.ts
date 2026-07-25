const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGES = 256;
const MAX_VERSIONS_PER_PACKAGE = 4_096;
const INDEX_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,213}$/;

export type VpmRepositoryPackages = Record<
  string,
  {
    versions: Record<string, Record<string, unknown>>;
  }
>;

export type VpmRepositoryIndex = Record<string, unknown> & {
  packages: VpmRepositoryPackages;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePackageUrl(value: unknown, packageId: string, version: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`VPM package ${packageId} ${version} has no artifact URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`VPM package ${packageId} ${version} has an invalid artifact URL`);
  }
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname))) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(`VPM package ${packageId} ${version} has an invalid artifact URL`);
  }
  return url.toString();
}

export function parseVpmRepositoryIndex(value: unknown): VpmRepositoryIndex {
  if (!isRecord(value) || !isRecord(value.packages)) {
    throw new Error('The VPM repository index does not contain a packages object');
  }
  const packageEntries = Object.entries(value.packages);
  if (packageEntries.length > MAX_PACKAGES) {
    throw new Error(`The VPM repository index exceeds ${MAX_PACKAGES} packages`);
  }
  const packages: VpmRepositoryPackages = {};
  for (const [packageId, rawPackage] of packageEntries) {
    if (!PACKAGE_ID_PATTERN.test(packageId) || !isRecord(rawPackage)) {
      throw new Error(`The VPM repository contains an invalid package: ${packageId}`);
    }
    const rawVersions = rawPackage.versions;
    if (!isRecord(rawVersions)) {
      throw new Error(`VPM package ${packageId} does not contain versions`);
    }
    const versionEntries = Object.entries(rawVersions);
    if (versionEntries.length > MAX_VERSIONS_PER_PACKAGE) {
      throw new Error(`VPM package ${packageId} exceeds ${MAX_VERSIONS_PER_PACKAGE} versions`);
    }
    const versions: Record<string, Record<string, unknown>> = {};
    for (const [version, rawManifest] of versionEntries) {
      if (
        !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(version) ||
        !isRecord(rawManifest) ||
        rawManifest.name !== packageId ||
        rawManifest.version !== version
      ) {
        throw new Error(`VPM package ${packageId} ${version} has an invalid manifest`);
      }
      versions[version] = {
        ...rawManifest,
        url: requirePackageUrl(rawManifest.url, packageId, version),
      };
    }
    packages[packageId] = { versions };
  }
  return { ...value, packages };
}

export async function fetchVpmRepositoryIndex(input: {
  fetchImpl: typeof fetch;
  indexUrl: string;
}): Promise<VpmRepositoryIndex> {
  // Repository contract: https://vcc.docs.vrchat.com/vpm/repos/
  const response = await input.fetchImpl(input.indexUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`The VPM repository returned HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_INDEX_BYTES) {
    throw new Error('The VPM repository exceeded its response limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('The VPM repository returned invalid JSON');
  }
  return parseVpmRepositoryIndex(parsed);
}

export function mergeVpmRepositoryPackages(
  target: VpmRepositoryPackages,
  source: VpmRepositoryPackages
): void {
  for (const [packageId, sourcePackage] of Object.entries(source)) {
    let targetPackage = target[packageId];
    if (!targetPackage) {
      targetPackage = { versions: {} };
      target[packageId] = targetPackage;
    }
    for (const [version, sourceManifest] of Object.entries(sourcePackage.versions)) {
      const existing = targetPackage.versions[version];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(sourceManifest)) {
        throw new Error(`VPM repositories disagree on ${packageId} ${version}`);
      }
      targetPackage.versions[version] = sourceManifest;
    }
  }
}
