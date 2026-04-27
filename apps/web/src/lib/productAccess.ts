import { apiClient } from '@/api/client';

export interface BuyerProductAccessPackagePreview {
  packageId: string;
  packageName: string | null;
  displayName: string | null;
  defaultChannel: string | null;
  latestPublishedVersion: string | null;
  latestPublishedAt: number | null;
  repositoryVisibility: 'hidden' | 'listed';
}

export interface BuyerProductAccessResponse {
  product: {
    catalogProductId: string;
    displayName: string;
    canonicalSlug: string | null;
    thumbnailUrl: string | null;
    provider: string;
    providerLabel: string;
    storefrontUrl: string | null;
    accessPagePath: string;
    packagePreview: BuyerProductAccessPackagePreview[];
  };
  accessState: {
    hasActiveEntitlement: boolean;
    requiresVerification: boolean;
    hasPublishedPackages: boolean;
  };
}

export interface BuyerProductAccessVerificationIntent {
  verificationUrl: string;
}

export function buildBuyerProductAccessPath(catalogProductId: string): string {
  return `/access/${encodeURIComponent(catalogProductId)}`;
}

export async function getBuyerProductAccess(catalogProductId: string) {
  return apiClient.get<BuyerProductAccessResponse>(
    `/api/connect/user/product-access/${encodeURIComponent(catalogProductId)}`
  );
}

export async function createBuyerProductAccessVerificationIntent(
  catalogProductId: string,
  input?: { returnTo?: string }
) {
  return apiClient.post<BuyerProductAccessVerificationIntent>(
    `/api/connect/user/product-access/${encodeURIComponent(catalogProductId)}`,
    input ?? {}
  );
}
