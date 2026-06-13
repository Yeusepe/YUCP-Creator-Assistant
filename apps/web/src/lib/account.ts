import { apiClient } from '@/api/client';

export interface UserLicenseEntitlement {
  id: string;
  sourceProvider: string;
  productId: string;
  catalogProductId: string | null;
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

export interface UserVerificationIntentRequirement {
  methodKey: string;
  providerKey: string;
  providerLabel: string;
  kind: 'existing_entitlement' | 'manual_license' | 'buyer_provider_link';
  title: string;
  description: string | null;
  creatorAuthUserId: string | null;
  productId: string | null;
  providerProductRef: string | null;
  capability: {
    methodKind: 'existing_entitlement' | 'manual_license' | 'buyer_provider_link';
    completion: 'immediate' | 'deferred';
    actionLabel: string;
    input?: {
      kind: 'license_key';
      label: string;
      placeholder: string | null;
      masked: boolean;
      submitLabel: string;
    };
  };
}

export interface UserVerificationIntent {
  object: 'verification_intent';
  id: string;
  packageId: string;
  packageName: string | null;
  status: string;
  verificationUrl: string;
  returnUrl: string;
  requirements: UserVerificationIntentRequirement[];
  verifiedMethodKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  grantToken: string | null;
  grantAvailable: boolean;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface AccountRecoveryVerificationResult {
  success: boolean;
  recoveryPasskeyContext: string;
  expiresAt: number;
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

export async function getUserVerificationIntent(intentId: string) {
  return apiClient.get<UserVerificationIntent>(
    `/api/connect/user/verification-intents/${encodeURIComponent(intentId)}`
  );
}

export async function verifyUserVerificationEntitlement(intentId: string, methodKey: string) {
  return apiClient.post<{ success: boolean }>(
    `/api/connect/user/verification-intents/${encodeURIComponent(intentId)}/verify-entitlement`,
    { methodKey }
  );
}

export async function verifyUserVerificationProviderLink(intentId: string, methodKey: string) {
  return apiClient.post<{ success: boolean }>(
    `/api/connect/user/verification-intents/${encodeURIComponent(intentId)}/verify-provider-link`,
    { methodKey }
  );
}

export async function verifyUserVerificationManualLicense(
  intentId: string,
  methodKey: string,
  licenseKey: string
) {
  return apiClient.post<{ success: boolean }>(
    `/api/connect/user/verification-intents/${encodeURIComponent(intentId)}/manual-license`,
    { methodKey, licenseKey }
  );
}

export async function startAccountRecovery(email: string) {
  return apiClient.post<{
    success: boolean;
    message: string;
  }>('/api/account-recovery/start', { email });
}

export async function verifyAccountRecoveryEmail(email: string, otp: string) {
  return apiClient.post<AccountRecoveryVerificationResult>('/api/account-recovery/verify-email', {
    email,
    otp,
  });
}

export async function verifyAccountRecoveryBackupCode(email: string, backupCode: string) {
  return apiClient.post<AccountRecoveryVerificationResult>(
    '/api/account-recovery/verify-backup-code',
    {
      email,
      backupCode,
    }
  );
}

export async function verifyRecoveryContactEnrollment(email: string, otp: string) {
  return apiClient.post<{ success: boolean }>('/api/account-security/recovery-email/verify', {
    email,
    otp,
  });
}
