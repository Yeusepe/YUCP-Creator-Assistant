/**
 * Shared shape for Backstage package ZIPs that have been published into CDNgine.
 *
 * References:
 * - docs/backstage-cdngine-delivery.md
 * - C:/Users/svalp/OneDrive/Documents/Development/antiwork/cdngine/docs/api-surface.md
 * - C:/Users/svalp/OneDrive/Documents/Development/antiwork/cdngine/contracts/openapi/public.openapi.yaml
 */
export type CdngineBackstageDeliveryReference = {
  assetId: string;
  assetOwner: string;
  byteSize: number;
  deliveryScopeId: string;
  serviceNamespaceId: string;
  sha256: string;
  uploadedAt: number;
  variant: string;
  versionId: string;
  tenantId?: string;
};

export type CdngineBackstageSourceReference = {
  assetId: string;
  assetOwner: string;
  byteSize: number;
  serviceNamespaceId: string;
  sha256: string;
  uploadedAt: number;
  versionId: string;
  tenantId?: string;
};

export function isCdngineBackstageDeliveryReference(
  value: unknown
): value is CdngineBackstageDeliveryReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.assetId === 'string' &&
    typeof candidate.assetOwner === 'string' &&
    typeof candidate.byteSize === 'number' &&
    typeof candidate.deliveryScopeId === 'string' &&
    typeof candidate.serviceNamespaceId === 'string' &&
    typeof candidate.sha256 === 'string' &&
    typeof candidate.uploadedAt === 'number' &&
    typeof candidate.variant === 'string' &&
    typeof candidate.versionId === 'string' &&
    (candidate.tenantId === undefined || typeof candidate.tenantId === 'string')
  );
}

export function isCdngineBackstageSourceReference(
  value: unknown
): value is CdngineBackstageSourceReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.assetId === 'string' &&
    typeof candidate.assetOwner === 'string' &&
    typeof candidate.byteSize === 'number' &&
    typeof candidate.serviceNamespaceId === 'string' &&
    typeof candidate.sha256 === 'string' &&
    typeof candidate.uploadedAt === 'number' &&
    typeof candidate.versionId === 'string' &&
    (candidate.tenantId === undefined || typeof candidate.tenantId === 'string')
  );
}
