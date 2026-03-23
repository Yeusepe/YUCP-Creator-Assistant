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

export interface UserCertificateBillingSummary {
  billingEnabled: boolean;
  status: string;
  allowEnrollment: boolean;
  allowSigning: boolean;
  planKey: string | null;
  deviceCap: number | null;
  activeDeviceCount: number;
  signQuotaPerPeriod: number | null;
  auditRetentionDays: number | null;
  supportTier: string | null;
  currentPeriodEnd: number | null;
  graceUntil: number | null;
  reason: string | null;
}

export interface UserCertificateDevice {
  certNonce: string;
  devPublicKey: string;
  publisherId: string;
  publisherName: string;
  issuedAt: number;
  expiresAt: number;
  status: string;
}

export interface UserCertificatePlan {
  planKey: string;
  slug: string;
  productId: string;
  priority: number;
  deviceCap: number;
  signQuotaPerPeriod: number | null;
  auditRetentionDays: number;
  supportTier: string;
  billingGraceDays: number;
}

export interface UserCertificateWorkspace {
  workspaceKey: string;
  creatorProfileId: string | null;
  billing: UserCertificateBillingSummary;
  devices: UserCertificateDevice[];
  availablePlans: UserCertificatePlan[];
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

export async function listUserCertificates() {
  const data = await apiClient.get<UserCertificateWorkspace>('/api/connect/user/certificates');
  return {
    ...data,
    creatorProfileId: data.creatorProfileId ?? null,
    billing: {
      ...data.billing,
      planKey: data.billing.planKey ?? null,
      deviceCap: data.billing.deviceCap ?? null,
      signQuotaPerPeriod: data.billing.signQuotaPerPeriod ?? null,
      auditRetentionDays: data.billing.auditRetentionDays ?? null,
      supportTier: data.billing.supportTier ?? null,
      currentPeriodEnd: data.billing.currentPeriodEnd ?? null,
      graceUntil: data.billing.graceUntil ?? null,
      reason: data.billing.reason ?? null,
    },
    availablePlans: data.availablePlans.map((plan) => ({
      ...plan,
      signQuotaPerPeriod: plan.signQuotaPerPeriod ?? null,
    })),
  } satisfies UserCertificateWorkspace;
}

export async function createUserCertificateCheckout(planKey: string) {
  return apiClient.post<{
    url: string;
    redirect: boolean;
    workspaceKey: string;
    planKey: string;
  }>('/api/connect/user/certificates/checkout', { planKey });
}

export async function getUserCertificatePortal() {
  return apiClient.get<{ url: string; redirect: boolean }>('/api/connect/user/certificates/portal');
}

export async function revokeUserCertificate(certNonce: string) {
  return apiClient.post<{ success: boolean }>('/api/connect/user/certificates/revoke', {
    certNonce,
  });
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
