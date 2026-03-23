import { createFileRoute, redirect } from '@tanstack/react-router';

interface AccountCertificatesSearch {
  plan?: string;
  checkout?: string;
  portal?: string;
  source?: string;
}

export const Route = createFileRoute('/account/certificates')({
  validateSearch: (search: Record<string, unknown>): AccountCertificatesSearch => ({
    plan: typeof search.plan === 'string' ? search.plan : undefined,
    checkout: typeof search.checkout === 'string' ? search.checkout : undefined,
    portal: typeof search.portal === 'string' ? search.portal : undefined,
    source: typeof search.source === 'string' ? search.source : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/dashboard/certificates',
      search,
      replace: true,
    });
  },
  component: () => null,
});
