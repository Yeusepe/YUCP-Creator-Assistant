export interface ExternalAccountIdentityCandidate {
  bindingCreatedAt: number;
  bindingId: string;
  externalAccountCreatedAt: number;
  externalAccountCreationTime: number;
  externalAccountId: string;
  provider: string;
  providerUserId: string;
}

export interface DuplicateExternalAccountIdentityGroup<T extends ExternalAccountIdentityCandidate> {
  duplicates: T[];
  keep: T;
  provider: string;
  providerUserId: string;
}

export function getExternalAccountIdentityKey(provider: string, providerUserId: string): string {
  return `${provider}:${providerUserId}`;
}

export function compareExternalAccountIdentityCandidates(
  left: ExternalAccountIdentityCandidate,
  right: ExternalAccountIdentityCandidate
): number {
  if (left.externalAccountCreatedAt !== right.externalAccountCreatedAt) {
    return left.externalAccountCreatedAt - right.externalAccountCreatedAt;
  }
  if (left.externalAccountCreationTime !== right.externalAccountCreationTime) {
    return left.externalAccountCreationTime - right.externalAccountCreationTime;
  }
  if (left.bindingCreatedAt !== right.bindingCreatedAt) {
    return left.bindingCreatedAt - right.bindingCreatedAt;
  }

  const externalAccountIdCompare = left.externalAccountId.localeCompare(right.externalAccountId);
  if (externalAccountIdCompare !== 0) {
    return externalAccountIdCompare;
  }

  return left.bindingId.localeCompare(right.bindingId);
}

export function selectCanonicalExternalAccountCandidates<
  T extends ExternalAccountIdentityCandidate,
>(candidates: T[]): T[] {
  const canonicalByIdentity = new Map<string, T>();

  for (const candidate of candidates) {
    const identityKey = getExternalAccountIdentityKey(candidate.provider, candidate.providerUserId);
    const existing = canonicalByIdentity.get(identityKey);
    if (!existing || compareExternalAccountIdentityCandidates(candidate, existing) < 0) {
      canonicalByIdentity.set(identityKey, candidate);
    }
  }

  return Array.from(canonicalByIdentity.values()).sort(compareExternalAccountIdentityCandidates);
}

export function findDuplicateExternalAccountIdentityGroups<
  T extends ExternalAccountIdentityCandidate,
>(candidates: T[]): Array<DuplicateExternalAccountIdentityGroup<T>> {
  const groupedCandidates = new Map<string, T[]>();

  for (const candidate of candidates) {
    const identityKey = getExternalAccountIdentityKey(candidate.provider, candidate.providerUserId);
    const existing = groupedCandidates.get(identityKey);
    if (existing) {
      existing.push(candidate);
    } else {
      groupedCandidates.set(identityKey, [candidate]);
    }
  }

  const duplicateGroups: Array<DuplicateExternalAccountIdentityGroup<T>> = [];
  for (const grouped of groupedCandidates.values()) {
    if (grouped.length < 2) continue;

    const ordered = [...grouped].sort(compareExternalAccountIdentityCandidates);
    duplicateGroups.push({
      duplicates: ordered.slice(1),
      keep: ordered[0],
      provider: ordered[0].provider,
      providerUserId: ordered[0].providerUserId,
    });
  }

  return duplicateGroups.sort((left, right) =>
    compareExternalAccountIdentityCandidates(left.keep, right.keep)
  );
}
