export interface BuyerProductAccessResponse {
  product: {
    catalogProductId: string;
    displayName: string;
    canonicalSlug: string | null;
    thumbnailUrl: string | null;
    provider: string;
    providerLabel: string;
    storefrontUrl: string | null;
    storefronts: Array<{
      catalogProductId: string;
      provider: string;
      providerLabel: string;
      storefrontUrl: string | null;
    }>;
  };
  accessState: {
    hasActiveEntitlement: boolean;
    requiresVerification: boolean;
  };
  repository: {
    addRepoUrl: string;
    indexUrl: string;
  } | null;
}
