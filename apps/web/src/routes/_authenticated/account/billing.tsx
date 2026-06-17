import { createFileRoute } from '@tanstack/react-router';

interface AccountBillingSearch {
  plan?: string;
  checkout?: string;
  portal?: string;
  source?: string;
}

export const Route = createFileRoute('/_authenticated/account/billing')({
  validateSearch: (search: Record<string, unknown>): AccountBillingSearch => ({
    plan: typeof search.plan === 'string' ? search.plan : undefined,
    checkout: typeof search.checkout === 'string' ? search.checkout : undefined,
    portal: typeof search.portal === 'string' ? search.portal : undefined,
    source: typeof search.source === 'string' ? search.source : undefined,
  }),
});
