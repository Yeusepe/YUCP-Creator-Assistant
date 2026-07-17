import { apiClient } from '@/api/client';

export interface BuyerProductAccessVerificationIntent {
  intentId: string;
  codeVerifier: string;
  machineFingerprint: string;
  verificationUrl: string;
}

export interface BuyerVpmRepositoryAccess {
  addRepoUrl: string;
  expiresAt: number;
  indexUrl: string;
  token: string;
}

export function buildBuyerProductAccessPath(catalogProductId: string): string {
  return `/access/${encodeURIComponent(catalogProductId)}`;
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

export async function mintBuyerVpmRepository() {
  return apiClient.post<BuyerVpmRepositoryAccess>('/api/vpm/repo-token');
}
