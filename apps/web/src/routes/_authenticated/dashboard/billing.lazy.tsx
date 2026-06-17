import { createLazyFileRoute } from '@tanstack/react-router';
// Redirect handled in billing.tsx beforeLoad; this stub satisfies the lazy-companion
// contract and never renders.
export const Route = createLazyFileRoute('/_authenticated/dashboard/billing')({
  component: () => null,
});
