import { Polar } from '@polar-sh/sdk';
import { getCertificateBillingConfig } from '../../../../convex/lib/certificateBillingConfig';
import { withApiSpan } from './observability';

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
  grantedBenefits: Array<{
    id: string;
    benefitId: string;
    benefitType: string;
    benefitMetadata?: Record<string, unknown>;
  }>;
  activeMeters: Array<{
    id: string;
    meterId: string;
    consumedUnits: number;
    creditedUnits: number;
    balance: number;
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

async function collectPageItems<T>(iterator: AsyncIterable<{ result: { items: T[] } }>) {
  const items: T[] = [];
  for await (const page of iterator) {
    items.push(...page.result.items);
  }
  return items;
}

function isPolarResourceNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ResourceNotFound' ||
      ('statusCode' in error && typeof error.statusCode === 'number' && error.statusCode === 404))
  );
}

export async function fetchCertificateBillingCustomerStateByExternalId(
  externalId: string
): Promise<CertificateBillingCustomerState | null> {
  return withApiSpan(
    'polar.customer_state.fetch',
    {
      provider: 'polar',
      externalCustomerId: externalId,
    },
    async () => {
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
          grantedBenefits: state.grantedBenefits.map((grant) => ({
            id: grant.id,
            benefitId: grant.benefitId,
            benefitType: grant.benefitType,
            benefitMetadata: grant.benefitMetadata,
          })),
          activeMeters: state.activeMeters.map((meter) => ({
            id: meter.id,
            meterId: meter.meterId,
            consumedUnits: meter.consumedUnits,
            creditedUnits: meter.creditedUnits,
            balance: meter.balance,
          })),
        };
      } catch (error) {
        if (isPolarResourceNotFound(error)) {
          return null;
        }

        throw error;
      }
    }
  );
}

export async function createCertificateBillingPortalSession(input: {
  externalCustomerId: string;
  customerEmail?: string | null;
  customerName?: string | null;
}): Promise<{ customerPortalUrl: string } | null> {
  return withApiSpan(
    'polar.portal_session.create',
    {
      provider: 'polar',
      externalCustomerId: input.externalCustomerId,
      hasCustomerEmail: Boolean(input.customerEmail),
    },
    async () => {
      const polar = createCertificateBillingPolarClient();
      if (!polar) {
        return null;
      }

      let customerId: string | null = null;

      try {
        // Polar get-by-external-id reference:
        // https://docs.polar.sh/api-reference/customers/get-external
        const customer = await withApiSpan(
          'polar.customer.lookup_external',
          {
            provider: 'polar',
            externalCustomerId: input.externalCustomerId,
          },
          () =>
            polar.customers.getExternal({
              externalId: input.externalCustomerId,
            })
        );
        customerId = customer.id;
      } catch (error) {
        if (!isPolarResourceNotFound(error)) {
          throw error;
        }
      }

      if (!customerId && input.customerEmail) {
        // Polar list-customers reference:
        // https://docs.polar.sh/api-reference/customers/list
        const customers = await withApiSpan(
          'polar.customer.lookup_email',
          {
            provider: 'polar',
            hasCustomerEmail: true,
          },
          async () =>
            collectPageItems(
              await polar.customers.list({
                email: input.customerEmail,
                limit: 1,
              })
            )
        );
        customerId = customers[0]?.id ?? null;
      }

      if (!customerId) {
        if (!input.customerEmail) {
          throw new Error('Polar customer portal requires a customer email');
        }
        const customerEmail = input.customerEmail;

        // Polar create-customer reference:
        // https://docs.polar.sh/api-reference/customers/create
        const customer = await withApiSpan(
          'polar.customer.create',
          {
            provider: 'polar',
            hasCustomerEmail: true,
            hasCustomerName: Boolean(input.customerName),
          },
          () =>
            polar.customers.create({
              email: customerEmail,
              externalId: input.externalCustomerId,
              ...(input.customerName ? { name: input.customerName } : {}),
              metadata: {
                certificate_billing: true,
                yucp_user_id: input.externalCustomerId,
              },
            })
        );
        customerId = customer.id;
      }

      // Polar create-customer-session reference:
      // https://docs.polar.sh/api-reference/customer-portal/sessions/create
      const session = await withApiSpan(
        'polar.customer_portal.session',
        {
          provider: 'polar',
          customerId,
        },
        () =>
          polar.customerSessions.create({
            customerId,
          })
      );
      return {
        customerPortalUrl: session.customerPortalUrl,
      };
    }
  );
}
