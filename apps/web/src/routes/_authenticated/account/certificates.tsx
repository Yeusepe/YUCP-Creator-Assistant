import { createFileRoute, redirect } from '@tanstack/react-router';

interface AccountCertificatesSearch {
  plan?: string;
  checkout?: string;
  portal?: string;
  source?: string;
}

export const Route = createFileRoute('/_authenticated/account/certificates')({
  validateSearch: (search: Record<string, unknown>): AccountCertificatesSearch => ({
    plan: typeof search.plan === 'string' ? search.plan : undefined,
    checkout: typeof search.checkout === 'string' ? search.checkout : undefined,
    portal: typeof search.portal === 'string' ? search.portal : undefined,
    source: typeof search.source === 'string' ? search.source : undefined,
  }),
  beforeLoad: ({ search }) => {
    const hasBillingSearch =
      Boolean(search.checkout) ||
      Boolean(search.portal) ||
      Boolean(search.plan) ||
      Boolean(search.source);

    throw redirect({
      to: hasBillingSearch ? '/dashboard/billing' : '/dashboard/certificates',
      search: hasBillingSearch ? search : undefined,
      replace: true,
    });
  },
  component: () => null,
});
