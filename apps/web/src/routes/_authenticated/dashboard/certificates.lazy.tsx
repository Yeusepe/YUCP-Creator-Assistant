import { createLazyFileRoute } from '@tanstack/react-router';
// Redirect handled in certificates.tsx beforeLoad; this stub satisfies the
// lazy-companion contract and never renders.
export const Route = createLazyFileRoute('/_authenticated/dashboard/certificates')({
  component: () => null,
});
