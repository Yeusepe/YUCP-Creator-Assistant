import { apiClient } from '@/api/client';

export interface CreatorCertificateBillingSummary {
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

export interface CreatorCertificateDevice {
  certNonce: string;
  devPublicKey: string;
  publisherId: string;
  publisherName: string;
  issuedAt: number;
  expiresAt: number;
  status: string;
}

export interface CreatorCertificatePlan {
  planKey: string;
  slug: string;
  productId: string;
  displayName: string;
  description?: string;
  highlights: string[];
  priority: number;
  deviceCap: number;
  signQuotaPerPeriod: number | null;
  auditRetentionDays: number;
  supportTier: string;
  billingGraceDays: number;
}

export interface CreatorCertificateWorkspace {
  workspaceKey: string;
  creatorProfileId: string | null;
  billing: CreatorCertificateBillingSummary;
  devices: CreatorCertificateDevice[];
  availablePlans: CreatorCertificatePlan[];
}

function padTwoDigits(value: number) {
  return value.toString().padStart(2, '0');
}

export function formatCertificateDate(timestamp: number | null) {
  if (!timestamp) {
    return 'Unknown date';
  }

  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatCertificateDateTime(timestamp: number | null) {
  if (!timestamp) {
    return 'Unknown date';
  }

  const date = new Date(timestamp);
  return `${formatCertificateDate(timestamp)} at ${padTwoDigits(date.getHours())}:${padTwoDigits(date.getMinutes())}`;
}

export async function listCreatorCertificates() {
  const data = await apiClient.get<CreatorCertificateWorkspace>(
    '/api/connect/creator/certificates'
  );
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
      description: plan.description?.trim() || undefined,
      highlights: Array.isArray(plan.highlights) ? plan.highlights.filter(Boolean) : [],
      signQuotaPerPeriod: plan.signQuotaPerPeriod ?? null,
    })),
  } satisfies CreatorCertificateWorkspace;
}

export async function createCreatorCertificateCheckout(planKey: string) {
  return apiClient.post<{
    url: string;
    redirect: boolean;
    workspaceKey: string;
    planKey: string;
  }>('/api/connect/creator/certificates/checkout', { planKey });
}

export async function getCreatorCertificatePortal() {
  return apiClient.get<{ url: string; redirect: boolean }>(
    '/api/connect/creator/certificates/portal'
  );
}

export async function revokeCreatorCertificate(certNonce: string) {
  return apiClient.post<{ success: boolean }>('/api/connect/creator/certificates/revoke', {
    certNonce,
  });
}
