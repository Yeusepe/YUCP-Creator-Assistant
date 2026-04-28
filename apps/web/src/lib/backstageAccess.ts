import { apiClient } from '@/api/client';

export interface BuyerBackstageAccessInfo {
  creatorName?: string;
  creatorRepoRef: string;
  productRef: string;
  title: string;
  thumbnailUrl?: string;
  provider: string;
  primaryPackageId?: string;
  packageSummaries: Array<{
    packageId: string;
    displayName?: string;
    latestPublishedVersion?: string;
  }>;
  ready: boolean;
}

export interface BuyerBackstageVerificationIntent {
  intentId: string;
  verificationUrl: string;
}

export interface BuyerBackstageRepoAccess {
  creatorName?: string;
  creatorRepoRef: string;
  repositoryUrl: string;
  repositoryName: string;
  addRepoUrl: string;
  expiresAt: number;
}

export function buildBuyerBackstageAccessPath(creatorRef: string, productRef: string): string {
  return `/get-in-unity/${encodeURIComponent(creatorRef)}/${encodeURIComponent(productRef)}`;
}

export async function getBuyerBackstageAccessInfo(input: {
  creatorRef: string;
  productRef: string;
}) {
  return await apiClient.get<BuyerBackstageAccessInfo>(
    `/api/backstage/access/${encodeURIComponent(input.creatorRef)}/${encodeURIComponent(input.productRef)}`
  );
}

export async function createBuyerBackstageVerificationIntent(input: {
  creatorRef: string;
  productRef: string;
  returnUrl: string;
  machineFingerprint: string;
  codeChallenge: string;
  idempotencyKey?: string;
}) {
  return await apiClient.post<BuyerBackstageVerificationIntent>(
    `/api/backstage/access/${encodeURIComponent(input.creatorRef)}/${encodeURIComponent(input.productRef)}/verification-intent`,
    {
      returnUrl: input.returnUrl,
      machineFingerprint: input.machineFingerprint,
      codeChallenge: input.codeChallenge,
      idempotencyKey: input.idempotencyKey,
    }
  );
}

export async function requestUserBackstageRepoAccess() {
  return await apiClient.get<BuyerBackstageRepoAccess>('/api/backstage/repos/access');
}
