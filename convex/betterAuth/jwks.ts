type StoredJwkRecord = {
  id: string;
  publicKey: string;
  alg?: string | null;
  crv?: string | null;
  expiresAt?: Date | number | string | null;
};

type PublicJwk = JsonWebKey & {
  alg: string;
  kid: string;
  crv?: string;
};

type BuildPublicJwksOptions = {
  defaultAlg?: string;
  gracePeriodMs?: number;
  now?: number;
};

function normalizeDate(value: Date | number | string | null | undefined): Date | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function isWithinGracePeriod(
  expiresAt: Date | number | string | null | undefined,
  now: number,
  gracePeriodMs: number
): boolean {
  const normalized = normalizeDate(expiresAt);
  if (!normalized) return true;
  return normalized.getTime() + gracePeriodMs > now;
}

export function buildPublicJwks(
  keys: StoredJwkRecord[],
  options: BuildPublicJwksOptions = {}
): { keys: PublicJwk[] } {
  const now = options.now ?? Date.now();
  const gracePeriodMs = options.gracePeriodMs ?? 30 * 24 * 60 * 60 * 1000;
  const defaultAlg = options.defaultAlg ?? 'RS256';

  return {
    keys: keys
      .filter((key) => isWithinGracePeriod(key.expiresAt, now, gracePeriodMs))
      .map((key) => {
        const publicKey = JSON.parse(key.publicKey) as JsonWebKey;
        return {
          ...publicKey,
          alg: key.alg ?? defaultAlg,
          crv: key.crv ?? undefined,
          kid: key.id,
        } satisfies PublicJwk;
      }),
  };
}
