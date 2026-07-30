const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isStrictSemanticVersion(value: string): boolean {
  return STRICT_SEMVER_PATTERN.test(value);
}

export function normalizeStrictSemanticVersion(value: string, fieldName = 'version'): string {
  const normalized = value.trim();
  if (!isStrictSemanticVersion(normalized)) {
    throw new Error(`${fieldName} must be a valid Semantic Version`);
  }
  return normalized;
}

type ParsedSemanticVersion = {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[];
};

function parseSemanticVersion(value: string): ParsedSemanticVersion {
  const normalized = normalizeStrictSemanticVersion(value);
  const match = STRICT_SEMVER_PATTERN.exec(normalized);
  if (!match) {
    throw new Error('version must be a valid Semantic Version');
  }
  return {
    major: BigInt(match[1] as string),
    minor: BigInt(match[2] as string),
    patch: BigInt(match[3] as string),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareBigInts(left: bigint, right: bigint): number {
  return left === right ? 0 : left > right ? 1 : -1;
}

export function compareSemanticVersions(left: string, right: string): number {
  const leftVersion = parseSemanticVersion(left);
  const rightVersion = parseSemanticVersion(right);
  for (const field of ['major', 'minor', 'patch'] as const) {
    const comparison = compareBigInts(leftVersion[field], rightVersion[field]);
    if (comparison !== 0) {
      return comparison;
    }
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    return leftVersion.prerelease.length === rightVersion.prerelease.length
      ? 0
      : leftVersion.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareBigInts(BigInt(leftIdentifier), BigInt(rightIdentifier));
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

export function isPrereleaseSemanticVersion(value: string): boolean {
  return parseSemanticVersion(value).prerelease.length > 0;
}
