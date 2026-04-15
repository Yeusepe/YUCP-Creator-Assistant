export type YucpPinnedRoot = Readonly<{
  keyId: string;
  algorithm: 'Ed25519';
  publicKeyBase64: string;
}>;

export type YucpTrustedRoot = YucpPinnedRoot;

export type YucpTrustJwk = Readonly<{
  kty: 'OKP';
  crv: 'Ed25519';
  kid: string;
  x: string;
}>;

export type YucpTrustBundleConfig = Readonly<{
  version: number;
  roots: readonly YucpTrustedRoot[];
}>;

const PINNED_ROOT_PUBLIC_KEY_BASE64 = 'y+8Zs9/mS1MFZFeF4CFjwqe0nsLW8lCcwmyvBx6H0Zo=';

const BUILTIN_PINNED_ROOTS: readonly YucpPinnedRoot[] = Object.freeze([
  {
    keyId: 'yucp-root',
    algorithm: 'Ed25519',
    publicKeyBase64: PINNED_ROOT_PUBLIC_KEY_BASE64,
  },
  {
    keyId: 'yucp-root-2025',
    algorithm: 'Ed25519',
    publicKeyBase64: PINNED_ROOT_PUBLIC_KEY_BASE64,
  },
]);

let pinnedRootsOverride: readonly YucpPinnedRoot[] | null = null;

function normalizePinnedRoot(root: YucpPinnedRoot): YucpPinnedRoot {
  return {
    keyId: root.keyId.trim(),
    algorithm: 'Ed25519',
    publicKeyBase64: root.publicKeyBase64.trim(),
  };
}

function normalizeTrustJwk(root: YucpPinnedRoot): YucpTrustJwk {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    kid: root.keyId,
    x: root.publicKeyBase64,
  };
}

function parseTrustedRootCandidate(candidate: unknown): YucpTrustedRoot | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  const keyId =
    typeof record.keyId === 'string'
      ? record.keyId
      : typeof record.kid === 'string'
        ? record.kid
        : null;
  const algorithm =
    typeof record.algorithm === 'string'
      ? record.algorithm
      : typeof record.crv === 'string'
        ? record.crv
        : null;
  const publicKeyBase64 =
    typeof record.publicKeyBase64 === 'string'
      ? record.publicKeyBase64
      : typeof record.x === 'string'
        ? record.x
        : null;

  if (!keyId?.trim() || !publicKeyBase64?.trim()) {
    return null;
  }
  if (algorithm && algorithm.trim() !== 'Ed25519') {
    return null;
  }

  return normalizePinnedRoot({
    keyId,
    algorithm: 'Ed25519',
    publicKeyBase64,
  });
}

export function getYucpRootByKeyId(
  roots: readonly YucpTrustedRoot[],
  keyId: string | null | undefined
): YucpTrustedRoot | null {
  if (!keyId) {
    return null;
  }

  return roots.find((root) => root.keyId === keyId.trim() && root.algorithm === 'Ed25519') ?? null;
}

export function getYucpJwkSetFromRoots(roots: readonly YucpTrustedRoot[]): YucpTrustJwk[] {
  return roots.map(normalizeTrustJwk);
}

export function getPinnedYucpRoots(): readonly YucpPinnedRoot[] {
  return pinnedRootsOverride ?? BUILTIN_PINNED_ROOTS;
}

export function getPrimaryPinnedYucpRoot(): YucpPinnedRoot {
  const [primaryRoot] = getPinnedYucpRoots();
  if (!primaryRoot) {
    throw new Error('No pinned YUCP roots configured');
  }
  return primaryRoot;
}

export function getPinnedYucpRootByKeyId(keyId: string | null | undefined): YucpPinnedRoot | null {
  return getYucpRootByKeyId(getPinnedYucpRoots(), keyId);
}

export function getPinnedYucpJwkSet(): YucpTrustJwk[] {
  return getYucpJwkSetFromRoots(getPinnedYucpRoots());
}

export function resolveConfiguredYucpTrustBundle(
  json: string | null | undefined
): YucpTrustBundleConfig {
  if (typeof json !== 'string' || !json.trim()) {
    return {
      version: 1,
      roots: getPinnedYucpRoots(),
    };
  }

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const version = parsed.version;
    const keys = parsed.keys;
    if (!Number.isInteger(version) || (version as number) < 1 || !Array.isArray(keys)) {
      throw new Error('invalid trust bundle');
    }

    const roots = keys
      .map((entry) => parseTrustedRootCandidate(entry))
      .filter((entry): entry is YucpTrustedRoot => entry !== null);
    if (roots.length === 0) {
      throw new Error('empty trust bundle');
    }

    return {
      version: version as number,
      roots,
    };
  } catch {
    return {
      version: 1,
      roots: getPinnedYucpRoots(),
    };
  }
}

/**
 * Test-only hook for replacing the pinned root set with deterministic fixture keys.
 */
export function setPinnedYucpRootsForTests(roots: readonly YucpPinnedRoot[] | null): void {
  pinnedRootsOverride = roots ? roots.map(normalizePinnedRoot) : null;
}
