import { apiClient } from '@/api/client';

export interface UserLicenseEntitlement {
  id: string;
  sourceProvider: string;
  productId: string;
  sourceReference: string | null;
  status: string;
  grantedAt: number;
  revokedAt: number | null;
}

export interface UserLicenseSubject {
  id: string;
  displayName: string | null;
  status: string;
  entitlements: UserLicenseEntitlement[];
}

export interface OAuthGrant {
  consentId: string;
  clientId: string;
  appName: string;
  scopes: string[];
  grantedAt: number | null;
  updatedAt: number | null;
}

function padTwoDigits(value: number) {
  return value.toString().padStart(2, '0');
}

export function formatAccountDate(timestamp: number | null) {
  if (!timestamp) {
    return 'Unknown date';
  }

  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatAccountDateTime(timestamp: number | null) {
  if (!timestamp) {
    return 'Unknown date';
  }

  const date = new Date(timestamp);
  return `${formatAccountDate(timestamp)} at ${padTwoDigits(date.getHours())}:${padTwoDigits(date.getMinutes())}`;
}

export function getAccountProviderIconPath(providerKey: string) {
  const map: Record<string, string> = {
    gumroad: '/Icons/Gumorad.png',
    jinxxy: '/Icons/Jinxxy.png',
    lemonsqueezy: '/Icons/LemonSqueezy.png',
    payhip: '/Icons/PayHip.png',
  };

  return map[providerKey.toLowerCase()] ?? null;
}

export async function listUserLicenses() {
  const data = await apiClient.get<{ subjects?: UserLicenseSubject[] }>(
    '/api/connect/user/licenses'
  );
  return data.subjects ?? [];
}

export async function revokeUserLicense(entitlementId: string) {
  return apiClient.delete<{ success: boolean }>(
    `/api/connect/user/entitlements/${encodeURIComponent(entitlementId)}`
  );
}

export async function listUserOAuthGrants() {
  const data = await apiClient.get<{ grants?: OAuthGrant[] }>('/api/connect/user/oauth/grants');
  return data.grants ?? [];
}

export async function revokeUserOAuthGrant(consentId: string) {
  return apiClient.delete<{ success: boolean }>(
    `/api/connect/user/oauth/grants/${encodeURIComponent(consentId)}`
  );
}

export async function downloadUserDataExport() {
  const response = await fetch('/api/connect/user/data-export', {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error('Could not prepare data export');
  }

  return response.blob();
}
