import { createFileRoute, redirect } from '@tanstack/react-router';

interface DashboardBillingSearch {
  plan?: string;
  checkout?: string;
  portal?: string;
  source?: string;
}

// Billing now lives in the account area. Keep this path as a redirect so existing
// deep links (Polar handoff, Unity, the API connect flow) keep working.
export const Route = createFileRoute('/_authenticated/dashboard/billing')({
  validateSearch: (search: Record<string, unknown>): DashboardBillingSearch => ({
    plan: typeof search.plan === 'string' ? search.plan : undefined,
    checkout: typeof search.checkout === 'string' ? search.checkout : undefined,
    portal: typeof search.portal === 'string' ? search.portal : undefined,
    source: typeof search.source === 'string' ? search.source : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/account/billing', search, replace: true });
  },
});
