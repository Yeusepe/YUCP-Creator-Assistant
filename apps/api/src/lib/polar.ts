import { Polar } from '@polar-sh/sdk';
import { getCertificateBillingConfig } from '../../../../convex/lib/certificateBillingConfig';

export interface CertificateBillingCustomerState {
  id: string;
  email: string;
  externalId?: string | null;
  activeSubscriptions: Array<{
    id: string;
    productId: string;
    status: string;
    recurringInterval: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    metadata?: Record<string, unknown>;
  }>;
}

function createCertificateBillingPolarClient() {
  const billingConfig = getCertificateBillingConfig();
  if (!billingConfig.polarAccessToken) {
    return null;
  }

  return new Polar({
    accessToken: billingConfig.polarAccessToken,
    server: billingConfig.polarServer === 'sandbox' ? 'sandbox' : 'production',
  });
}

export async function fetchCertificateBillingCustomerStateByExternalId(
  externalId: string
): Promise<CertificateBillingCustomerState | null> {
  const polar = createCertificateBillingPolarClient();
  if (!polar) {
    return null;
  }

  try {
    // Polar customer state reference: https://docs.polar.sh/api-reference/customers/state-external
    const state = await polar.customers.getStateExternal({ externalId });
    return {
      id: state.id,
      email: state.email,
      externalId: state.externalId,
      activeSubscriptions: state.activeSubscriptions.map((subscription) => ({
        id: subscription.id,
        productId: subscription.productId,
        status: subscription.status,
        recurringInterval: subscription.recurringInterval,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        metadata: subscription.metadata,
      })),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'ResourceNotFound' ||
        ('statusCode' in error && typeof error.statusCode === 'number' && error.statusCode === 404))
    ) {
      return null;
    }

    throw error;
  }
}
