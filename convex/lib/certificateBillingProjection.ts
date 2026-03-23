export interface CertificateBillingProjectionSubscriptionSource {
  id: string;
  productId: string;
  status: string;
  recurringInterval: string;
  currentPeriodStart: Date | number | string;
  currentPeriodEnd: Date | number | string;
  cancelAtPeriodEnd: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface CertificateBillingProjectionSubscription {
  subscriptionId: string;
  productId: string;
  status: string;
  recurringInterval: string;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  metadata: Record<string, string | number | boolean>;
}

function toProjectionTimestamp(value: Date | number | string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Invalid Polar customer-state timestamp: ${String(value)}`);
}

export function normalizeCertificateBillingProjectionMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, string | number | boolean> {
  if (!metadata) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([, value]) =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    )
  ) as Record<string, string | number | boolean>;
}

export function toCertificateBillingProjectionSubscription(
  subscription: CertificateBillingProjectionSubscriptionSource
): CertificateBillingProjectionSubscription {
  return {
    subscriptionId: subscription.id,
    productId: subscription.productId,
    status: subscription.status,
    recurringInterval: subscription.recurringInterval,
    currentPeriodStart: toProjectionTimestamp(subscription.currentPeriodStart),
    currentPeriodEnd: toProjectionTimestamp(subscription.currentPeriodEnd),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    metadata: normalizeCertificateBillingProjectionMetadata(subscription.metadata),
  };
}
