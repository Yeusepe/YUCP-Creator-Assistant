import { createLazyFileRoute } from '@tanstack/react-router';
// Redirect handled in forensics.tsx beforeLoad; this stub satisfies the
// lazy-companion contract and never renders.
export const Route = createLazyFileRoute('/_authenticated/dashboard/forensics')({
  component: () => null,
});
