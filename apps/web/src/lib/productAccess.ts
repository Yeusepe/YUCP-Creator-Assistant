import { apiClient } from '@/api/client';

export interface BuyerProductAccessVerificationIntent {
  intentId: string;
  codeVerifier: string;
  machineFingerprint: string;
  verificationUrl: string;
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
