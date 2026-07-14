/**
 * Shared reference for Backstage artifacts stored in Lore.
 *
 * The address and repository formats are defined by the Lore Phase A storage
 * contract supplied with this repository change.
 */
export type LoreBackstageArtifactReference = {
  repositoryId: string;
  address: string;
  sha256: string;
  byteSize: number;
  uploadedAt: string;
  tenantId?: string;
};

export function isLoreBackstageArtifactReference(
  value: unknown
): value is LoreBackstageArtifactReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.repositoryId === 'string' &&
    typeof candidate.address === 'string' &&
    typeof candidate.sha256 === 'string' &&
    typeof candidate.byteSize === 'number' &&
    Number.isFinite(candidate.byteSize) &&
    candidate.byteSize >= 0 &&
    typeof candidate.uploadedAt === 'string' &&
    (candidate.tenantId === undefined || typeof candidate.tenantId === 'string')
  );
}
