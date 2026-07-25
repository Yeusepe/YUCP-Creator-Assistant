export const MAX_VPM_BOOTSTRAP_DOCUMENTS = 32;
const MAX_DEPENDENCIES = 64;
const MAX_REPOSITORIES = 16;
export const MAX_VPM_BOOTSTRAP_MANIFEST_BYTES = 256 * 1024;
const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,213}$/;

export type VpmBootstrapMetadata = {
  vpmDependencies: Record<string, string>;
  vpmRepositories: Record<string, string>;
};

export type VpmBootstrapMetadataDocument = {
  body: string;
  normalizedPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isTempInstallDescriptor(normalizedPath: string): boolean {
  const segments = normalizedPath.split('/');
  const fileName = segments.at(-1) ?? '';
  if (!/^YUCP_TempInstall_[^/]+\.json$/i.test(fileName)) {
    return false;
  }
  return (
    normalizedPath.startsWith('Assets/') ||
    (normalizedPath.startsWith('Packages/yucp.installed-packages/') &&
      normalizedPath.includes('/_temp/'))
  );
}

function isEmbeddedPackageManifest(normalizedPath: string): boolean {
  return /^Packages\/[^/]+\/package\.json$/.test(normalizedPath);
}

function requireSafeText(value: unknown, name: string, maximumBytes: number): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  const normalized = value.trim();
  const bytes = new TextEncoder().encode(normalized);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > maximumBytes ||
    Array.from(normalized).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new Error(`${name} contains an invalid value`);
  }
  return normalized;
}

function parseDependencies(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error('vpmDependencies must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_DEPENDENCIES) {
    throw new Error(`vpmDependencies exceeds ${MAX_DEPENDENCIES} entries`);
  }
  const dependencies: Record<string, string> = {};
  for (const [rawName, rawRange] of entries.sort(([left], [right]) => compareText(left, right))) {
    const name = requireSafeText(rawName, 'VPM dependency name', 214);
    if (!PACKAGE_ID_PATTERN.test(name)) {
      throw new Error(`VPM dependency name is invalid: ${name}`);
    }
    dependencies[name] = requireSafeText(rawRange, `VPM dependency ${name}`, 128);
  }
  return dependencies;
}

function parseRepositories(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error('vpmRepositories must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_REPOSITORIES) {
    throw new Error(`vpmRepositories exceeds ${MAX_REPOSITORIES} entries`);
  }
  const repositories: Record<string, string> = {};
  for (const [rawName, rawUrl] of entries.sort(([left], [right]) => compareText(left, right))) {
    const name = requireSafeText(rawName, 'VPM repository name', 128);
    const text = requireSafeText(rawUrl, `VPM repository ${name}`, 2_048);
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`VPM repository ${name} must use an absolute HTTPS URL`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`VPM repository ${name} must use an absolute HTTPS URL`);
    }
    repositories[name] = url.toString();
  }
  return repositories;
}

function mergeMap(
  target: Record<string, string>,
  source: Record<string, string>,
  kind: 'dependency' | 'repository'
): void {
  for (const [name, value] of Object.entries(source)) {
    const current = target[name];
    if (current !== undefined && current !== value) {
      throw new Error(`Package metadata contains a conflicting VPM ${kind}: ${name}`);
    }
    target[name] = value;
  }
}

export function normalizeVpmBootstrapMetadata(value: {
  vpmDependencies?: unknown;
  vpmRepositories?: unknown;
}): VpmBootstrapMetadata {
  return {
    vpmDependencies: parseDependencies(value.vpmDependencies),
    vpmRepositories: parseRepositories(value.vpmRepositories),
  };
}

export function extractVpmBootstrapMetadataFromDocuments(
  documents: readonly VpmBootstrapMetadataDocument[]
): VpmBootstrapMetadata {
  if (documents.length > MAX_VPM_BOOTSTRAP_DOCUMENTS) {
    throw new Error(`Package bootstrap metadata exceeds ${MAX_VPM_BOOTSTRAP_DOCUMENTS} documents`);
  }
  const tempDescriptors = documents.filter((document) =>
    isTempInstallDescriptor(document.normalizedPath)
  );
  const candidates =
    tempDescriptors.length > 0
      ? tempDescriptors
      : documents.filter((document) => isEmbeddedPackageManifest(document.normalizedPath));
  const vpmDependencies: Record<string, string> = {};
  const vpmRepositories: Record<string, string> = {};

  for (const candidate of [...candidates].sort((left, right) =>
    compareText(left.normalizedPath, right.normalizedPath)
  )) {
    if (new TextEncoder().encode(candidate.body).byteLength > MAX_VPM_BOOTSTRAP_MANIFEST_BYTES) {
      throw new Error(`VPM metadata document is too large: ${candidate.normalizedPath}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(candidate.body);
    } catch {
      throw new Error(`VPM metadata document is not valid JSON: ${candidate.normalizedPath}`);
    }
    if (!isRecord(value)) {
      throw new Error(`VPM metadata document must be an object: ${candidate.normalizedPath}`);
    }
    const parsed = normalizeVpmBootstrapMetadata(value);
    mergeMap(vpmDependencies, parsed.vpmDependencies, 'dependency');
    mergeMap(vpmRepositories, parsed.vpmRepositories, 'repository');
  }

  return {
    vpmDependencies: Object.fromEntries(
      Object.entries(vpmDependencies).sort(([left], [right]) => compareText(left, right))
    ),
    vpmRepositories: Object.fromEntries(
      Object.entries(vpmRepositories).sort(([left], [right]) => compareText(left, right))
    ),
  };
}

export function isVpmBootstrapMetadataPath(normalizedPath: string): boolean {
  return isTempInstallDescriptor(normalizedPath) || isEmbeddedPackageManifest(normalizedPath);
}
