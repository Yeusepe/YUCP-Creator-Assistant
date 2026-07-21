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

export function buildProductAccessReturnPath(): string {
  if (typeof window === 'undefined') {
    return '/account/licenses';
  }
  const url = new URL(window.location.href);
  url.searchParams.delete('grant');
  url.searchParams.delete('intent_id');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function clearProductAccessGrantFromUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('grant') && !url.searchParams.has('intent_id')) return;
  url.searchParams.delete('grant');
  url.searchParams.delete('intent_id');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
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
