import { createFileRoute } from '@tanstack/react-router';

interface DashboardBillingSearch {
  plan?: string;
  checkout?: string;
  portal?: string;
  source?: string;
}

export const Route = createFileRoute('/_authenticated/dashboard/billing')({
  validateSearch: (search: Record<string, unknown>): DashboardBillingSearch => ({
    plan: typeof search.plan === 'string' ? search.plan : undefined,
    checkout: typeof search.checkout === 'string' ? search.checkout : undefined,
    portal: typeof search.portal === 'string' ? search.portal : undefined,
    source: typeof search.source === 'string' ? search.source : undefined,
  }),
});
