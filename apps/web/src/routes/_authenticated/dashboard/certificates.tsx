import { createFileRoute, redirect } from '@tanstack/react-router';

// The standalone certificates page was retired. Authorized machines now live in the
// account area; keep this path as a redirect for any lingering deep links.
export const Route = createFileRoute('/_authenticated/dashboard/certificates')({
  beforeLoad: () => {
    throw redirect({ to: '/account/machines', replace: true });
  },
});
