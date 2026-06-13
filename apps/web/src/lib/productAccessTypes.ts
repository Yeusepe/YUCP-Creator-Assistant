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
