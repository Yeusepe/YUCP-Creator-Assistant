import { apiClient } from '@/api/client';

export interface CreatorCertificateBillingSummary {
  billingEnabled: boolean;
  status: string;
  allowEnrollment: boolean;
  allowSigning: boolean;
  planKey: string | null;
  productId: string | null;
  deviceCap: number | null;
  activeDeviceCount: number;
  signQuotaPerPeriod: number | null;
  auditRetentionDays: number | null;
  supportTier: string | null;
  currentPeriodEnd: number | null;
  graceUntil: number | null;
  reason: string | null;
  capabilities: CreatorCertificateBillingCapability[];
}

export interface CreatorCertificateBillingCapability {
  capabilityKey: string;
  status: string;
}

export function hasActiveCreatorBillingCapability(
  capabilities: CreatorCertificateBillingCapability[] | undefined,
  capabilityKey: string
) {
  return (
    capabilities?.some(
      (capability) =>
        capability.capabilityKey === capabilityKey &&
        (capability.status === 'active' || capability.status === 'grace')
    ) ?? false
  );
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
  displayBadge?: string;
  deviceCap: number;
  signQuotaPerPeriod: number | null;
  auditRetentionDays: number;
  supportTier: string;
  billingGraceDays: number;
  capabilities: string[];
  meteredPrices: Array<{
    priceId: string;
    meterId: string;
    meterName: string;
  }>;
}

export interface CreatorCertificateWorkspace {
  workspaceKey: string;
  creatorProfileId: string | null;
  billing: CreatorCertificateBillingSummary;
  devices: CreatorCertificateDevice[];
  availablePlans: CreatorCertificatePlan[];
  meters: Array<{
    meterId: string;
    meterName?: string;
    consumedUnits: number;
    creditedUnits: number;
    balance: number;
  }>;
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
      productId: data.billing.productId ?? null,
      deviceCap: data.billing.deviceCap ?? null,
      signQuotaPerPeriod: data.billing.signQuotaPerPeriod ?? null,
      auditRetentionDays: data.billing.auditRetentionDays ?? null,
      supportTier: data.billing.supportTier ?? null,
      currentPeriodEnd: data.billing.currentPeriodEnd ?? null,
      graceUntil: data.billing.graceUntil ?? null,
      reason: data.billing.reason ?? null,
      capabilities: Array.isArray(data.billing.capabilities) ? data.billing.capabilities : [],
    },
    availablePlans: data.availablePlans.map((plan) => ({
      ...plan,
      description: plan.description?.trim() || undefined,
      displayBadge: plan.displayBadge?.trim() || undefined,
      highlights: Array.isArray(plan.highlights) ? plan.highlights.filter(Boolean) : [],
      signQuotaPerPeriod: plan.signQuotaPerPeriod ?? null,
      capabilities: Array.isArray(plan.capabilities) ? plan.capabilities.filter(Boolean) : [],
      meteredPrices: Array.isArray(plan.meteredPrices) ? plan.meteredPrices : [],
    })),
    meters: Array.isArray(data.meters) ? data.meters : [],
  } satisfies CreatorCertificateWorkspace;
}

export async function createCreatorCertificateCheckout(input: {
  productId?: string;
  planKey?: string;
}) {
  return apiClient.post<{
    url: string;
    redirect: boolean;
    workspaceKey: string;
    planKey: string;
    productId: string;
  }>('/api/connect/creator/certificates/checkout', input);
}

export async function getCreatorCertificatePortal() {
  return apiClient.get<{ url: string; redirect: boolean }>(
    '/api/connect/creator/certificates/portal'
  );
}

export async function reconcileCreatorCertificateBilling() {
  return apiClient.post<{
    reconciled: boolean;
    overview: CreatorCertificateWorkspace;
  }>('/api/connect/creator/certificates/reconcile', {});
}

export async function revokeCreatorCertificate(certNonce: string) {
  return apiClient.post<{ success: boolean }>('/api/connect/creator/certificates/revoke', {
    certNonce,
  });
}
